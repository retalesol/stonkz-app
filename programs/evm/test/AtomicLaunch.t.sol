// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockUniversalRouter, MockWETH, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {UpgradeAtomicLaunch} from "../script/UpgradeAtomicLaunch.s.sol";
import {MainnetGuard} from "../script/MainnetGuard.sol";
import {DeployMigrator} from "../script/DeployMigrator.s.sol";
import {UniswapV2Migrator} from "../src/UniswapV2Migrator.sol";
import {StonkzV2Factory} from "../src/testnet/StonkzV2Factory.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";

/// @notice Create + dev buy in one transaction (anti-snipe).
///
/// Tokens are deployed with CREATE, so a coin's address is unknown until its
/// creation lands; a creator's dev buy sent as a second transaction leaves a
/// block in which anyone watching `TokenCreated` can buy first.
/// `StonkzRouter.createAndBuyWithEth` closes that window: the launchpad's
/// router-only `createTokenFor` records the *user* as creator, and the buy
/// happens in the same call.
///
/// Wiring mirrors `script/UpgradeAtomicLaunch.s.sol`: an existing proxy (built
/// with a router-less implementation), a new router bound to it, then an
/// upgrade to an implementation whose immutable `trustedRouter` is that router.
contract AtomicLaunchTest is Test {
    StonkzLaunchpad pad;
    StonkzRouter router;
    MockWETH weth;
    MockERC20 usdg;
    MockUniversalRouter ur;
    MockSwapRouter02 sr02;
    PushPriceSource oracle;

    address admin = address(0xA11CE);
    address oracleAuth = address(0x0AC1E);
    address user = address(0xC4EA7);
    address sniper = address(0x5417E);

    bytes32 constant TOKEN_CREATED = keccak256(
        "TokenCreated(address,address,address,string,uint256,uint16,bool,uint64,uint256,uint256,uint256,uint256,uint256,uint256)"
    );
    bytes[] NO_UPDATE;
    bytes32 constant ATOMIC_BUY = keccak256("AtomicBuy(address,address,uint256,uint256,uint256)");

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new MockWETH();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, admin, admin, oracle, admin);
        ur = new MockUniversalRouter(weth, usdg, 3_000e6);
        sr02 = new MockSwapRouter02(weth, usdg, 3_000e6);
        router = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(0))
        );

        // The upgrade `UpgradeAtomicLaunch` performs.
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        vm.prank(admin);
        pad.upgradeToAndCall(address(impl), "");

        vm.startPrank(oracleAuth);
        oracle.pushPrice(address(weth), 3_000_000_000, 0);
        oracle.pushPrice(address(usdg), 1_000_000, 0);
        vm.stopPrank();

        vm.deal(user, 100 ether);
        vm.deal(sniper, 100 ether);
    }

    function _params(string memory ticker) internal view returns (StonkzRouter.CreateParams memory) {
        return StonkzRouter.CreateParams({
            name: "Atomic Coin",
            ticker: ticker,
            uri: "ipfs://meta",
            supply: 1_000_000_000,
            baseToken: address(weth),
            feeBps: 250,
            cashback: false
        });
    }

    /// The address the launchpad's next CREATE will land at.
    function _nextToken() internal view returns (address) {
        return vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
    }

    function _assertRouterEmpty(address token) internal view {
        assertEq(StonkzToken(token).balanceOf(address(router)), 0, "router holds no tokens");
        assertEq(weth.balanceOf(address(router)), 0, "router holds no weth");
        assertEq(address(router).balance, 0, "router holds no eth");
    }

    /* ------------------------------------------------------------ happy path */

    function test_CreatesAndDevBuysInOneCallWithTheUserAsCreator() public {
        assertEq(pad.trustedRouter(), address(router));
        address expected = _nextToken();
        uint256 userEthBefore = user.balance;

        // TokenCreated names the user, not the router — same signature as ever.
        vm.expectEmit(true, true, true, false, address(pad));
        emit StonkzLaunchpad.TokenCreated(expected, address(weth), user, "", 0, 0, false, 0, 0, 0, 0, 0, 0, 0);
        // AtomicBuy names the user too; that is what the indexer attributes.
        vm.expectEmit(true, true, false, false, address(router));
        emit StonkzRouter.AtomicBuy(user, expected, 1 ether, 0, 0);

        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyWithEth{value: 1 ether}(_params("ATOM"), NO_UPDATE, 1, block.timestamp + 60);

        assertEq(token, expected);
        assertGt(out, 0, "dev buy filled");
        assertEq(StonkzToken(token).balanceOf(user), out, "the tokens land with the user");
        assertEq(user.balance, userEthBefore - 1 ether, "a full fill refunds nothing");

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.creator, user, "creator is the user, not the router");
        assertEq(c.baseToken, address(weth));
        assertEq(
            c.realBase, 1 ether - c.protocolAccrued - c.opsAccrued - c.burnAccrued - c.creatorBucketAccrued
        );
        assertEq(pad.tokenByTicker(keccak256("ATOM")), token);
        _assertRouterEmpty(token);

        // The creator ledger belongs to the user: they can claim, the router cannot.
        vm.prank(address(router));
        vm.expectRevert(bytes("not creator"));
        pad.claimCreatorFees(token);
        uint256 wethBefore = weth.balanceOf(user);
        vm.prank(user);
        pad.claimCreatorFees(token);
        assertGt(weth.balanceOf(user), wethBefore, "creator fees from the dev buy go to the user");
    }

    /// The dev buy is the curve's first fill: nobody can be ahead of it,
    /// because nobody can know the address before this transaction lands.
    function test_TheDevBuyIsTheFirstFill() public {
        vm.recordLogs();
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyWithEth{value: 2 ether}(_params("FIRST"), NO_UPDATE, 0, block.timestamp + 60);

        // Exactly what a solo first buyer of 2 ETH would get.
        StonkzLaunchpad twin = DeployPad.launchpad(admin, admin, admin, oracle, admin);
        vm.deal(address(this), 2 ether);
        weth.deposit{value: 2 ether}();
        weth.approve(address(twin), 2 ether);
        address twinToken =
            twin.createToken("Atomic Coin", "FIRST", "ipfs://meta", 1_000_000_000, address(weth), 250, false);
        assertEq(twin.buy(twinToken, 2 ether, 0), out, "same fill as the first buy on a fresh curve");

        // And the only Trade on this coin in the transaction is the router's.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 atomic;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == ATOMIC_BUY) {
                atomic++;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), user);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), token);
            }
        }
        assertEq(atomic, 1);
    }

    /// Unspent ETH comes back when the buy is larger than the curve can take.
    function test_RefundsWhatTheCurveCannotAbsorb() public {
        uint256 before = user.balance;
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyWithEth{value: 60 ether}(_params("WHALE"), NO_UPDATE, 0, block.timestamp + 60);
        uint256 spent = weth.balanceOf(address(pad));

        assertGt(out, 0);
        assertLt(spent, 60 ether, "the curve could not absorb the whole buy");
        assertEq(user.balance, before - spent, "only what the curve took left the user");
        assertTrue(pad.coinInfo(token).complete, "the dev buy exhausted the curve");
        _assertRouterEmpty(token);
    }

    /// No ETH: a plain launch, still attributed to the user, with no buy and
    /// no `AtomicBuy`.
    function test_NoEthLaunchesWithoutABuy() public {
        vm.recordLogs();
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyWithEth(_params("NOBUY"), NO_UPDATE, 123, block.timestamp + 60);

        assertEq(out, 0);
        assertEq(pad.coinInfo(token).creator, user);
        assertEq(pad.coinInfo(token).realBase, 0, "curve untouched");
        assertEq(StonkzToken(token).balanceOf(user), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != ATOMIC_BUY, "no AtomicBuy without a buy");
            if (logs[i].topics[0] == TOKEN_CREATED) {
                assertEq(address(uint160(uint256(logs[i].topics[3]))), user, "TokenCreated creator");
            }
        }
        _assertRouterEmpty(token);
    }

    /* -------------------------------------------------------------- reverts */

    /// A dev buy below the creator's floor reverts the launch with it: there
    /// is never a coin without its dev buy.
    function test_MinOutRevertsTheWholeLaunch() public {
        uint256 countBefore = pad.tokenCount();
        vm.prank(user);
        vm.expectRevert(bytes("slippage"));
        router.createAndBuyWithEth{value: 1 ether}(
            _params("MINOUT"), NO_UPDATE, type(uint256).max, block.timestamp + 60
        );
        assertEq(pad.tokenCount(), countBefore, "no coin was created");
        assertEq(pad.tokenByTicker(keccak256("MINOUT")), address(0));
    }

    function test_RejectsAnExpiredDeadline() public {
        vm.prank(user);
        vm.expectRevert(StonkzRouter.DeadlineExpired.selector);
        router.createAndBuyWithEth{value: 1 ether}(_params("LATE"), NO_UPDATE, 0, block.timestamp - 1);
    }

    function test_RejectsANonWethBase() public {
        StonkzRouter.CreateParams memory p = _params("USDG");
        p.baseToken = address(usdg);
        vm.prank(user);
        vm.expectRevert(bytes("not weth pair"));
        router.createAndBuyWithEth{value: 1 ether}(p, NO_UPDATE, 0, block.timestamp + 60);
    }

    /// Only the trusted router may name a creator. Anyone else — a user, a
    /// sniper, another router — gets nothing, whatever creator they pass.
    function test_OnlyTheTrustedRouterCanCreateFor() public {
        vm.prank(sniper);
        vm.expectRevert(bytes("not router"));
        pad.createTokenFor(user, "X", "X", "u", 1_000_000_000, address(weth), 250, false);

        StonkzRouter other = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(0))
        );
        vm.prank(user);
        vm.expectRevert(bytes("not router"));
        other.createAndBuyWithEth{value: 1 ether}(_params("OTHER"), NO_UPDATE, 0, block.timestamp + 60);
    }

    /// An implementation built without a router (`address(0)`) disables
    /// `createTokenFor` outright.
    function test_ARouterlessImplementationDisablesCreateFor() public {
        StonkzLaunchpad plain = new StonkzLaunchpad(address(0));
        vm.prank(admin);
        pad.upgradeToAndCall(address(plain), "");
        assertEq(pad.trustedRouter(), address(0));
        vm.prank(user);
        vm.expectRevert(bytes("not router"));
        router.createAndBuyWithEth{value: 1 ether}(_params("OFF"), NO_UPDATE, 0, block.timestamp + 60);
    }

    /// Launch-side checks still apply on the atomic path, with the same
    /// strings the API preflight maps.
    function test_LaunchGuardsStillApply() public {
        vm.prank(admin);
        pad.setPause(false, true, false, false, false);
        vm.prank(user);
        vm.expectRevert(bytes("launch paused"));
        router.createAndBuyWithEth{value: 1 ether}(_params("PAUSED"), NO_UPDATE, 0, block.timestamp + 60);

        vm.prank(admin);
        pad.setPause(false, false, false, false, false);
        vm.prank(user);
        vm.expectRevert(bytes("ticker"));
        router.createAndBuyWithEth{value: 1 ether}(_params("lower"), NO_UPDATE, 0, block.timestamp + 60);
    }

    function test_TheBuyCapAppliesToTheDevBuy() public {
        StonkzRouter capped = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            1 ether,
            IPyth(address(0))
        );
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.BuyAboveCap.selector, 2 ether, 1 ether));
        capped.createAndBuyWithEth{value: 2 ether}(_params("CAP"), NO_UPDATE, 0, block.timestamp + 60);
    }

    /* ------------------------------------------------------------ regressions */

    /// A direct `createToken` still records its caller.
    function test_DirectCreateTokenIsUnchanged() public {
        vm.prank(sniper);
        address token = pad.createToken("Plain", "PLAIN", "u", 1_000_000_000, address(weth), 250, false);
        assertEq(pad.coinInfo(token).creator, sniper);
    }

    /// `coins` lost its auto-generated getter (for bytecode size) but must
    /// return the same bytes under the same selector, which the API's
    /// `curve-sync` decodes as a flat 38-word tuple.
    function test_CoinsGetterMatchesCoinInfoBytes() public {
        vm.prank(user);
        (address token,) =
            router.createAndBuyWithEth{value: 1 ether}(_params("BYTES"), NO_UPDATE, 0, block.timestamp + 60);

        (bool ok, bytes memory raw) =
            address(pad).staticcall(abi.encodeWithSignature("coins(address)", token));
        assertTrue(ok);
        assertEq(raw.length, 38 * 32, "flat 38-word tuple, no offset");
        assertEq(raw, abi.encode(pad.coinInfo(token)), "identical to coinInfo");
        assertEq(abi.decode(raw, (address)), token, "word 0 is the token");
        (,, address creator) = abi.decode(raw, (address, address, address));
        assertEq(creator, user, "word 2 is the creator");
    }

    /// The router lives in the implementation's bytecode, not in storage: the
    /// pinned slots read the same after the upgrade.
    function test_TheUpgradeAddsNoStorage() public view {
        address p = address(pad);
        assertEq(address(uint160(uint256(vm.load(p, bytes32(uint256(5)))))), admin, "slot 5 = admin");
        assertEq(uint256(vm.load(p, bytes32(uint256(12)))), 90_000, "slot 12 = maxOracleStaleness");
        assertEq(uint256(vm.load(p, bytes32(uint256(15)))), 1, "slot 15 = _lock");
        assertEq(uint256(vm.load(p, bytes32(uint256(16)))), 0, "slot 16 = pauser, unset by the upgrade");
        assertEq(uint256(vm.load(p, bytes32(uint256(17)))), 0, "nothing after pauser");
    }
}

/// @notice The deploy scripts themselves, against a local proxy set up the
/// way RH 46630's is today (router-less implementation, EOA admin).
contract AtomicLaunchScriptsTest is Test {
    uint256 constant ADMIN_KEY = 0xAD814; // test-only key
    address admin;
    StonkzLaunchpad pad;

    function setUp() public {
        vm.chainId(46630);
        vm.warp(1_800_000_000);
        admin = vm.addr(ADMIN_KEY);
        PushPriceSource oracle = DeployPad.pushOracle(admin, admin, 90_000);
        pad = DeployPad.launchpad(admin, address(0xC01D1), admin, oracle, admin);
    }

    function test_UpgradeAtomicLaunchDeploysATrustedRouterAndKeepsLayout() public {
        bytes32 slot5 = vm.load(address(pad), bytes32(uint256(5)));
        address push = address(pad.priceSource());
        UpgradeAtomicLaunch s = new UpgradeAtomicLaunch();
        UpgradeAtomicLaunch.Result memory r = s.execute(s.defaults(address(pad)), ADMIN_KEY);

        assertEq(pad.trustedRouter(), r.router, "proxy trusts the new router");
        assertEq(StonkzLaunchpad(r.impl).trustedRouter(), r.router);
        assertEq(address(StonkzRouter(payable(r.router)).launchpad()), address(pad));
        assertEq(address(StonkzRouter(payable(r.router)).weth()), RobinhoodChainTestnet.WETH9);
        assertEq(address(StonkzRouter(payable(r.router)).pyth()), RobinhoodChainTestnet.PYTH);
        assertEq(vm.load(address(pad), bytes32(uint256(5))), slot5, "admin slot unchanged");
        assertEq(pad.admin(), admin);

        // Pricing switched to Pyth, tight, with the push oracle behind it.
        PythPriceSource ps = PythPriceSource(r.priceSource);
        assertEq(address(pad.priceSource()), r.priceSource);
        assertEq(pad.maxOracleStaleness(), 120);
        assertEq(address(ps.pyth()), RobinhoodChainTestnet.PYTH);
        assertEq(address(ps.fallbackSource()), push);
        assertEq(ps.admin(), admin);
        (bytes32 feedId, uint64 maxAge,,,) = ps.feeds(RobinhoodChainTestnet.WETH9);
        assertEq(feedId, RobinhoodChainTestnet.PYTH_ETH_USD);
        assertEq(maxAge, 120);
        (uint256 usd,,) = ps.priceUsd1e6(RobinhoodChainTestnet.USDG);
        assertEq(usd, 1e6, "USDG fixed at $1");
    }

    function test_UpgradeAtomicLaunchCanDeferTheOracleSwitch() public {
        address push = address(pad.priceSource());
        UpgradeAtomicLaunch s = new UpgradeAtomicLaunch();
        UpgradeAtomicLaunch.Params memory p = s.defaults(address(pad));
        p.switchPriceSource = false;
        UpgradeAtomicLaunch.Result memory r = s.execute(p, ADMIN_KEY);
        assertEq(pad.trustedRouter(), r.router);
        assertEq(address(pad.priceSource()), push, "not switched yet");
        assertEq(pad.maxOracleStaleness(), 90_000);
        assertTrue(r.priceSource.code.length > 0, "but deployed and configured");
    }

    function test_UpgradeAtomicLaunchByANonAdminOnlyDeploys() public {
        UpgradeAtomicLaunch s = new UpgradeAtomicLaunch();
        UpgradeAtomicLaunch.Result memory r = s.execute(s.defaults(address(pad)), 0xBAD);
        assertEq(pad.trustedRouter(), address(0), "not upgraded without the admin");
        assertTrue(r.router.code.length > 0);
        assertEq(PythPriceSource(r.priceSource).pendingAdmin(), admin, "offered to the real admin");
    }

    function test_DeployMigratorInstallsOnANewTestnetFactory() public {
        (address migrator, address factory) =
            new DeployMigrator().execute(address(pad), ADMIN_KEY, address(0), address(0x316), _noGov());
        assertEq(address(pad.migrator()), migrator);
        assertEq(pad.migrationAuthority(), address(0x316));
        assertEq(address(UniswapV2Migrator(migrator).factory()), factory);
        assertEq(UniswapV2Migrator(migrator).launchpad(), address(pad));
        assertEq(StonkzV2Factory(factory).allPairsLength(), 0, "a fresh pair registry");
    }

    function _noGov() internal pure returns (MainnetGuard.Governance memory g) {}
}
