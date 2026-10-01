// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {CurveMath} from "../../src/CurveMath.sol";
import {FeeLocker} from "../../src/FeeLocker.sol";
import {ReferralVault} from "../../src/ReferralVault.sol";
import {StonkzLaunchpad} from "../../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../../src/StonkzRouter.sol";
import {StonkzToken} from "../../src/StonkzToken.sol";
import {UniswapV3Migrator} from "../../src/UniswapV3Migrator.sol";
import {ChainlinkPriceSource} from "../../src/oracle/ChainlinkPriceSource.sol";
import {IPyth} from "../../src/oracle/IPyth.sol";
import {PushPriceSource} from "../../src/oracle/PushPriceSource.sol";
import {PythPriceSource} from "../../src/oracle/PythPriceSource.sol";
import {StockPriceSourceV2} from "../../src/oracle/StockPriceSourceV2.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../../src/oracle/uniswap/IUniswapV3.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";
import {MainnetGuard} from "../../script/MainnetGuard.sol";
import {V3TestSwapper} from "../mocks/V3Fixture.sol";

interface IWETHLike {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice `DeployMainnet` end to end against a **fork of the real chain**
/// (RH 4663 / Base 8453): the full broadcast with stand-in governance
/// addresses, then the whole user journey on what it deployed — launch
/// through the router (Pyth mocked fresh, or a real Hermes update), buy,
/// sell, stake, buy the curve out, graduate, migrate into the real Uniswap V3
/// factory, trade the pool, `claimFees`, a referral claim with a test signer,
/// a pause by the pauser that only the timelock can lift, and the deployer
/// ending with no role anywhere. Nothing is broadcast.
///
/// Skipped unless the RPC for the chain is set:
///
/// ```
/// MAINNET_FORK_RPC_RH=https://rpc.mainnet.chain.robinhood.com \
///   forge test --match-path test/fork/MainnetDeployFork.t.sol --match-test RH -vv
/// MAINNET_FORK_RPC_BASE=https://mainnet.base.org \
///   forge test --match-path test/fork/MainnetDeployFork.t.sol --match-test Base -vv
/// ```
/// `MAINNET_FORK_PYTH_UPDATE=0x<hermes hex>` (fetched moments before) makes
/// the launch post a real update through the real Pyth instead of the mock.
contract MainnetDeployForkTest is Test {
    uint256 constant SIGNER_KEY = 0x51634E; // test-only referral signer
    address constant SAFE = address(0x5AFE);
    address pauser = address(0x9A05E);
    address ops = address(0x0B5);
    address migration = address(0x316);
    address protocol = address(0xC01D1);
    address attester = address(0xA77E57);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address keeper = address(0x6EE9E7);
    address alice = address(0xA71CE);
    address funder = address(0xF00D);

    function test_RH4663_FullStackOnAFork() public {
        _journey("MAINNET_FORK_RPC_RH", 4663);
    }

    function test_Base8453_FullStackOnAFork() public {
        _journey("MAINNET_FORK_RPC_BASE", 8453);
    }

    function _gov() internal view returns (MainnetGuard.Governance memory g) {
        g.proposers = new address[](1);
        g.proposers[0] = SAFE;
        g.executors = g.proposers;
        g.minDelay = 1 days;
        g.pauser = pauser;
        g.opsAuthority = ops;
        g.migrationAuthority = migration;
    }

    struct Ctx {
        StonkzLaunchpad pad;
        StonkzRouter router;
        TimelockController tl;
        IWETHLike weth;
        address pyth;
        address token;
        address token2;
    }

    function _journey(string memory rpcEnv, uint256 chainId) internal {
        string memory rpc = vm.envOr(rpcEnv, string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == chainId, "fork: unexpected chain id");

        // 1. The deployment, exactly as the broadcast would run it. The test
        //    contract is the deployer and must be left with nothing.
        DeployMainnet d = new DeployMainnet();
        DeployMainnet.Params memory p = d.defaults(_gov());
        p.protocolAuthority = protocol;
        p.referralSigner = vm.addr(SIGNER_KEY);
        p.referralMaxPerDay = 5 ether;
        p.attester = attester;
        DeployMainnet.Result memory r = d.execute(p, address(this));

        Ctx memory c;
        c.pad = StonkzLaunchpad(r.launchpad);
        c.router = StonkzRouter(payable(r.router));
        c.tl = TimelockController(payable(r.timelock));
        c.weth = IWETHLike(address(c.router.weth()));
        c.pyth = address(c.router.pyth());
        _assertGoverned(c, r);

        // 2. Launch + dev buy through the router.
        _launch(c, r);
        // 3. Buy, sell, stake.
        _trade(c);
        // 4. Referral claim with the test signer; the pauser can stop it.
        _referral(c, r);
        // 5. Exhaust the curve, graduate, migrate into the real V3 factory,
        //    trade the pool, claim fees into the ledgers.
        _graduate(c, r);
        // 6. Pause by the pauser; only the timelock unpauses.
        _pause(c);
    }

    function _assertGoverned(Ctx memory c, DeployMainnet.Result memory r) internal view {
        assertEq(c.pad.admin(), r.timelock, "launchpad admin is the timelock");
        assertEq(c.pad.pendingAdmin(), address(0));
        assertEq(c.pad.pauser(), pauser);
        assertEq(c.pad.opsWithdrawAuthority(), ops);
        assertEq(c.pad.protocolWithdrawAuthority(), protocol);
        assertEq(c.pad.migrationAuthority(), migration);
        assertEq(c.pad.trustedRouter(), r.router);
        assertEq(address(c.pad.migrator()), r.v3Migrator);
        assertEq(address(c.pad.priceSource()), r.pythPriceSource);
        assertEq(c.pad.maxOracleStaleness(), 90_000);
        assertEq(PythPriceSource(r.pythPriceSource).admin(), r.timelock);
        assertEq(ChainlinkPriceSource(r.chainlinkPriceSource).admin(), r.timelock);
        assertEq(StockPriceSourceV2(r.stockPriceSourceV2).admin(), r.timelock);
        assertEq(PushPriceSource(r.pushPriceSource).admin(), r.timelock);
        assertEq(ReferralVault(payable(r.referralVault)).admin(), r.timelock);
        assertEq(c.tl.getMinDelay(), 1 days);
        assertTrue(c.tl.hasRole(c.tl.PROPOSER_ROLE(), SAFE));
        assertFalse(c.tl.hasRole(c.tl.PROPOSER_ROLE(), address(this)), "deployer: no proposer role");
        assertFalse(c.tl.hasRole(c.tl.EXECUTOR_ROLE(), address(this)), "deployer: no executor role");
        assertFalse(c.tl.hasRole(c.tl.CANCELLER_ROLE(), address(this)), "deployer: no canceller role");
        assertFalse(c.tl.hasRole(c.tl.DEFAULT_ADMIN_ROLE(), address(this)), "deployer: no admin role");
        // Storage layout, as pinned by test_StorageLayoutIsAppendOnly.
        address p = r.launchpad;
        assertEq(address(uint160(uint256(vm.load(p, bytes32(uint256(5)))))), r.timelock, "slot 5 = admin");
        assertEq(address(uint160(uint256(vm.load(p, bytes32(uint256(11)))))), r.pythPriceSource, "slot 11");
        assertEq(uint256(vm.load(p, bytes32(uint256(12)))), 90_000, "slot 12 = maxOracleStaleness");
        assertEq(uint256(vm.load(p, bytes32(uint256(15)))), 1, "slot 15 = _lock");
        assertEq(address(uint160(uint256(vm.load(p, bytes32(uint256(16)))))), pauser, "slot 16 = pauser");
        assertEq(uint256(vm.load(p, bytes32(uint256(17)))), 0, "nothing after pauser");
        // The real V3 factory has the tier the migrator was built for.
        assertEq(IUniswapV3Factory(r.v3Factory).feeAmountTickSpacing(10_000), 200, "1% tier live");
        assertEq(UniswapV3Migrator(r.v3Migrator).fee(), 10_000);
    }

    function _params(string memory ticker, address weth)
        internal
        pure
        returns (StonkzRouter.CreateParams memory)
    {
        return StonkzRouter.CreateParams({
            name: ticker,
            ticker: ticker,
            uri: "ipfs://fork",
            supply: 1_000_000_000,
            baseToken: weth,
            feeBps: 250,
            cashback: false
        });
    }

    function _launch(Ctx memory c, DeployMainnet.Result memory r) internal {
        address weth = address(c.weth);
        vm.deal(creator, 100 ether);
        uint256 deadline = block.timestamp + 60;

        // Without a fresh print the launch is refused — a deferral, not a wedge.
        (uint256 live, uint256 at,) = PythPriceSource(r.pythPriceSource).priceUsd1e6(weth);
        if (live == 0 || block.timestamp - at > 120) {
            vm.prank(creator);
            vm.expectRevert(bytes("stale oracle"));
            c.router.createAndBuyWithEth{value: 1 ether}(_params("FORKA", weth), new bytes[](0), 1, deadline);
        }

        // A real Hermes update when given; otherwise a fresh print at Pyth.
        bytes memory hermes = vm.envOr("MAINNET_FORK_PYTH_UPDATE", bytes(""));
        bytes[] memory updates;
        if (hermes.length > 0) {
            updates = new bytes[](1);
            updates[0] = hermes;
        } else {
            vm.mockCall(
                c.pyth,
                abi.encodeWithSelector(IPyth.getPriceUnsafe.selector),
                abi.encode(IPyth.Price(3_000e8, 1e8, -8, block.timestamp))
            );
        }
        vm.prank(creator);
        (address token, uint256 out) =
            c.router.createAndBuyWithEth{value: 1 ether}(_params("FORKA", weth), updates, 1, deadline);
        assertEq(c.pad.coinInfo(token).creator, creator, "creator");
        assertEq(StonkzToken(token).balanceOf(creator), out, "dev buy delivered");
        assertGt(out, 0);
        c.token = token;
        // A second coin, kept on the curve for the pause check.
        vm.prank(creator);
        (c.token2,) =
            c.router.createAndBuyWithEth{value: 0.1 ether}(_params("FORKB", weth), updates, 1, deadline);
    }

    function _trade(Ctx memory c) internal {
        uint256 deadline = block.timestamp + 60;
        vm.deal(trader, 200_000 ether);
        vm.prank(trader);
        uint256 got = c.router.buyWithEth{value: 2 ether}(c.token, 0, deadline);
        assertGt(got, 0, "buy");

        vm.startPrank(trader);
        StonkzToken(c.token).approve(address(c.router), type(uint256).max);
        uint256 ethBefore = trader.balance;
        uint256 ethOut = c.router
            .sellForEth(
                c.token, got / 4, StonkzRouter.PermitData(0, 0, 0, bytes32(0), bytes32(0)), 0, 0, deadline
            );
        vm.stopPrank();
        assertGt(ethOut, 0, "sell");
        assertEq(trader.balance - ethBefore, ethOut, "sell paid in ETH");

        vm.startPrank(trader);
        StonkzToken(c.token).approve(address(c.pad), type(uint256).max);
        c.pad.stake(c.token, got / 4, 30);
        vm.stopPrank();
        assertEq(c.pad.coinInfo(c.token).eligibleStaked, got / 4, "staked");
        vm.prank(creator);
        c.router.buyWithEth{value: 1 ether}(c.token, 0, deadline);
        (uint256 pending,) = c.pad.pendingStakeRewards(c.token, trader);
        assertGt(pending, 0, "the locked staker earns from the next fill");
    }

    function _referral(Ctx memory c, DeployMainnet.Result memory r) internal {
        ReferralVault vault = ReferralVault(payable(r.referralVault));
        address weth = address(c.weth);
        vm.deal(funder, 10 ether);
        vm.startPrank(funder);
        c.weth.deposit{value: 6 ether}();
        c.weth.approve(address(vault), type(uint256).max);
        vault.fund(weth, 6 ether);
        vm.stopPrank();

        uint256 dl = block.timestamp + 30 minutes;
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(SIGNER_KEY, vault.hashClaim(alice, weth, 1 ether, dl));
        vm.prank(keeper);
        vault.claim(alice, weth, 1 ether, dl, abi.encodePacked(rr, s, v));
        assertEq(c.weth.balanceOf(alice), 1 ether, "referral paid");

        (v, rr, s) = vm.sign(0xBAD, vault.hashClaim(alice, weth, 2 ether, dl));
        vm.prank(keeper);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, weth, 2 ether, dl, abi.encodePacked(rr, s, v));

        // The launchpad's pauser stops payouts; only the timelock restarts them.
        vm.prank(pauser);
        vault.pause();
        (v, rr, s) = vm.sign(SIGNER_KEY, vault.hashClaim(alice, weth, 2 ether, dl));
        vm.prank(keeper);
        vm.expectRevert(ReferralVault.ClaimsPaused.selector);
        vault.claim(alice, weth, 2 ether, dl, abi.encodePacked(rr, s, v));
        vm.prank(pauser);
        vm.expectRevert(ReferralVault.NotAdmin.selector);
        vault.unpause();
        vm.prank(r.timelock);
        vault.unpause();
        vm.prank(keeper);
        vault.claim(alice, weth, 2 ether, dl, abi.encodePacked(rr, s, v));
        assertEq(c.weth.balanceOf(alice), 2 ether, "cumulative voucher");
    }

    function _graduate(Ctx memory c, DeployMainnet.Result memory r) internal {
        address token = c.token;
        address weth = address(c.weth);
        vm.startPrank(trader);
        c.weth.deposit{value: 100_000 ether}();
        c.weth.approve(address(c.pad), type(uint256).max);
        for (uint256 i = 0; i < 200 && c.pad.coinInfo(token).realToken > 0; i++) {
            c.pad.buy(token, 10 ether, 0);
        }
        vm.stopPrank();
        assertEq(c.pad.coinInfo(token).realToken, 0, "curve exhausted");
        uint256 raise = c.pad.coinInfo(token).realBase;
        uint256 escrow = c.pad.coinInfo(token).lpReserve;

        vm.prank(keeper);
        c.pad.graduate(token);
        vm.prank(migration);
        c.pad.migrateLiquidity(token);

        address pool = IUniswapV3Factory(r.v3Factory).getPool(token, weth, 10_000);
        assertTrue(pool != address(0), "pool on the live factory");
        FeeLocker locker = FeeLocker(r.feeLocker);
        FeeLocker.Lock memory l = locker.lockOf(token);
        assertEq(l.pool, pool);
        assertGt(l.liquidity, 0);
        assertApproxEqRel(c.weth.balanceOf(pool), raise, 1e6, "the raise is in the pool");
        assertApproxEqRel(StonkzToken(token).balanceOf(pool), escrow, 1e6, "the escrow is in the pool");

        V3TestSwapper swapper = new V3TestSwapper();
        vm.prank(trader);
        c.weth.transfer(address(swapper), raise / 5);
        bool tokenIs0 = token < weth;
        swapper.swapExactIn(pool, !tokenIs0, raise / 5);
        swapper.swapExactIn(pool, tokenIs0, StonkzToken(token).balanceOf(address(swapper)) / 2);

        (uint256 pendingBase, uint256 pendingTokens) = locker.pendingFees(token);
        assertGt(pendingBase, 0);
        assertGt(pendingTokens, 0);
        uint256 protocolBefore = c.pad.protocolRevenue(weth);
        vm.prank(keeper);
        (uint256 baseAmt, uint256 tokenAmt) = locker.claimFees(token);
        assertEq(baseAmt, pendingBase);
        assertEq(tokenAmt, pendingTokens);
        CurveMath.FeeShares memory s = CurveMath.splitFee(baseAmt);
        assertEq(c.pad.protocolRevenue(weth) - protocolBefore, s.protocol, "15% protocol");
        assertEq(uint256(IUniswapV3Pool(pool).liquidity()), l.liquidity, "principal intact");
        emit log_named_address("pool", pool);
        emit log_named_uint("base fees claimed", baseAmt);
    }

    function _pause(Ctx memory c) internal {
        uint256 deadline = block.timestamp + 60;
        vm.prank(pauser);
        c.pad.pause(true, true, true, true, true);
        assertTrue(c.pad.tradingPaused() && c.pad.launchPaused());
        vm.prank(trader);
        vm.expectRevert(bytes("trading paused"));
        c.router.buyWithEth{value: 1 ether}(c.token2, 0, deadline);

        // The deployer (this contract) is nobody.
        vm.expectRevert(bytes("not admin"));
        c.pad.setPause(false, false, false, false, false);
        vm.expectRevert(bytes("not admin"));
        c.pad.setPauser(address(this));

        bytes memory data = abi.encodeCall(c.pad.setPause, (false, false, false, false, false));
        vm.prank(SAFE);
        c.tl.schedule(address(c.pad), 0, data, bytes32(0), bytes32("unpause"), 1 days);
        vm.warp(block.timestamp + 1 days);
        vm.prank(SAFE);
        c.tl.execute(address(c.pad), 0, data, bytes32(0), bytes32("unpause"));
        assertFalse(c.pad.tradingPaused(), "timelock unpaused");
        vm.prank(trader);
        assertGt(c.router.buyWithEth{value: 1 ether}(c.token2, 0, block.timestamp + 60), 0, "trading again");
    }
}
