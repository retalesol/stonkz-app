// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {CurveMath} from "../../src/CurveMath.sol";
import {FeeLocker, ILaunchpadMigrator} from "../../src/FeeLocker.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../../src/StonkzToken.sol";
import {UniswapV3Migrator} from "../../src/UniswapV3Migrator.sol";
import {PythPriceSource} from "../../src/oracle/PythPriceSource.sol";
import {IPyth} from "../../src/oracle/IPyth.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../../src/oracle/uniswap/IUniswapV3.sol";
import {V3TestSwapper} from "../mocks/V3Fixture.sol";

interface IWETHLike {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice The v3 graduation and fee flow against the **live** launchpad proxy
/// and the **real** Uniswap V3 factory on a fork: upgrade the proxy to the
/// implementation in this tree (`vm.prank(admin)` — nothing is broadcast),
/// deploy `FeeLocker` + `UniswapV3Migrator`, install it, launch, buy out,
/// graduate, migrate, trade in the pool, `claimFees`, and check the ledgers.
///
/// Skipped unless `V3_FORK_RPC`, `V3_FORK_LAUNCHPAD`, `V3_FORK_WETH` and
/// `V3_FORK_FACTORY` are set:
///
///   V3_FORK_RPC=https://sepolia.base.org \
///   V3_FORK_LAUNCHPAD=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 \
///   V3_FORK_WETH=0x4200000000000000000000000000000000000006 \
///   V3_FORK_FACTORY=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 \
///   forge test --match-path test/fork/V3GraduationFork.t.sol -vv
///
///   V3_FORK_RPC=https://rpc.testnet.chain.robinhood.com \
///   V3_FORK_LAUNCHPAD=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 \
///   V3_FORK_WETH=0x7943e237c7F95DA44E0301572D358911207852Fa \
///   V3_FORK_FACTORY=0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932 \
///   forge test --match-path test/fork/V3GraduationFork.t.sol -vv
///
/// RH testnet has no NonfungiblePositionManager; the locker needs none, so
/// the same test covers both chains.
contract V3GraduationForkTest is Test {
    StonkzLaunchpad pad;
    IWETHLike weth;
    IUniswapV3Factory factory;
    FeeLocker locker;
    UniswapV3Migrator migrator;

    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address keeper = address(0x6EE9E7);

    function setUp() public {
        string memory rpc = vm.envOr("V3_FORK_RPC", string(""));
        address proxy = vm.envOr("V3_FORK_LAUNCHPAD", address(0));
        address w = vm.envOr("V3_FORK_WETH", address(0));
        address f = vm.envOr("V3_FORK_FACTORY", address(0));
        if (bytes(rpc).length == 0 || proxy == address(0) || w == address(0) || f == address(0)) return;
        vm.createSelectFork(rpc);
        pad = StonkzLaunchpad(proxy);
        weth = IWETHLike(w);
        factory = IUniswapV3Factory(f);
    }

    modifier onFork() {
        if (address(pad) == address(0)) {
            emit log("V3_FORK_* not set; skipping");
            return;
        }
        _;
    }

    function test_LiveFactoryHasTheOnePercentTier() public onFork {
        assertTrue(address(factory).code.length > 0, "factory deployed");
        assertEq(factory.feeAmountTickSpacing(10_000), 200, "1% tier enabled");
    }

    function test_GraduateMigrateTradeAndClaimOnTheLiveContracts() public onFork {
        address admin = pad.admin();
        // 1. The implementation in this tree, in place (admin-gated on chain;
        //    pranked here). Layout is append-only, so nothing moves.
        bytes32 lockBefore = vm.load(address(pad), bytes32(uint256(15)));
        StonkzLaunchpad impl = new StonkzLaunchpad(pad.trustedRouter());
        vm.prank(admin);
        pad.upgradeToAndCall(address(impl), "");
        assertEq(vm.load(address(pad), bytes32(uint256(15))), lockBefore, "_lock untouched");

        // 2. Locker + migrator on the real factory, installed.
        locker = new FeeLocker(ILaunchpadMigrator(address(pad)));
        migrator = new UniswapV3Migrator(factory, address(pad), locker, 10_000);
        address authority = pad.migrationAuthority();
        vm.prank(admin);
        pad.setMigrator(IGraduationMigrator(address(migrator)), authority);

        // 3. Launch and buy the curve out. The live Pyth ETH/USD is stale on a
        //    fork; stand in for the update the router would post.
        vm.deal(trader, 100_000 ether);
        vm.startPrank(trader);
        weth.deposit{value: 50_000 ether}();
        weth.approve(address(pad), type(uint256).max);
        vm.stopPrank();
        address pyth = address(PythPriceSource(address(pad.priceSource())).pyth());
        vm.mockCall(
            pyth,
            abi.encodeWithSelector(IPyth.getPriceUnsafe.selector),
            abi.encode(IPyth.Price(3_000e8, 1e8, -8, block.timestamp))
        );
        vm.prank(creator);
        address token =
            pad.createToken("Fork V3", "FV3", "ipfs://fork", 1_000_000_000, address(weth), 250, false);
        for (uint256 i = 0; i < 80 && pad.coinInfo(token).realToken > 0; i++) {
            vm.prank(trader);
            pad.buy(token, 10 ether, 0);
        }
        assertEq(pad.coinInfo(token).realToken, 0, "curve exhausted");
        uint256 raise = pad.coinInfo(token).realBase;
        uint256 escrow = pad.coinInfo(token).lpReserve;

        // 4. Graduate (anyone) and migrate (authority).
        vm.warp(block.timestamp + 7 days);
        vm.prank(keeper);
        pad.graduate(token);
        vm.prank(authority);
        pad.migrateLiquidity(token);

        address pool = factory.getPool(token, address(weth), 10_000);
        assertTrue(pool != address(0), "pool exists on the live factory");
        FeeLocker.Lock memory l = locker.lockOf(token);
        assertEq(l.pool, pool);
        assertGt(l.liquidity, 0);
        assertApproxEqRel(weth.balanceOf(pool), raise, 1e6, "the raise is in the pool");
        assertApproxEqRel(StonkzToken(token).balanceOf(pool), escrow, 1e6, "the escrow is in the pool");
        emit log_named_address("pool", pool);
        emit log_named_uint("liquidity", l.liquidity);

        // 5. Trade in the pool, then anyone claims.
        V3TestSwapper swapper = new V3TestSwapper();
        vm.prank(trader);
        weth.transfer(address(swapper), raise / 5);
        bool tokenIs0 = token < address(weth);
        swapper.swapExactIn(pool, !tokenIs0, raise / 5);
        swapper.swapExactIn(pool, tokenIs0, StonkzToken(token).balanceOf(address(swapper)) / 2);

        (uint256 pendingBase, uint256 pendingTokens) = locker.pendingFees(token);
        assertGt(pendingBase, 0);
        assertGt(pendingTokens, 0);
        uint256 protocolBefore = pad.protocolRevenue(address(weth));
        uint256 creatorBefore = pad.coinInfo(token).creatorClaimableBase;
        vm.prank(keeper);
        (uint256 baseAmt, uint256 tokenAmt) = locker.claimFees(token);
        assertEq(baseAmt, pendingBase);
        assertEq(tokenAmt, pendingTokens);
        CurveMath.FeeShares memory s = CurveMath.splitFee(baseAmt);
        assertEq(pad.protocolRevenue(address(weth)) - protocolBefore, s.protocol, "15% protocol");
        assertGe(
            pad.coinInfo(token).creatorClaimableBase - creatorBefore, s.creatorBucket / 2, "creator bucket"
        );
        assertEq(uint256(IUniswapV3Pool(pool).liquidity()), l.liquidity, "principal intact");
        emit log_named_uint("base fees claimed", baseAmt);
        emit log_named_uint("token fees claimed", tokenAmt);

        // 6. The creator can take it out.
        uint256 wb = weth.balanceOf(creator);
        vm.prank(creator);
        pad.claimCreatorFees(token);
        assertGt(weth.balanceOf(creator), wb, "creator claimed post-graduation fees");
    }
}
