// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {MockUniversalRouter, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {StockFixture} from "./StockPriceSource.t.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {StockPriceSource} from "../src/oracle/StockPriceSource.sol";
import {StockBases} from "../src/config/StockBases.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {DeployStockPriceSource} from "../script/DeployStockPriceSource.s.sol";
import {UpgradeStockLaunch} from "../script/UpgradeStockLaunch.s.sol";

/// @notice Stock-base launches end to end: `createAndBuyViaV3` (Pyth update →
/// wrap → V3 WETH→TSLA → `createTokenFor` → curve buy, one transaction), priced
/// by launchpad → `PythPriceSource` → `StockPriceSource` with no push, at any hour.
contract StockLaunchTest is StockFixture {
    /// Sunday 2027-01-17 03:00 America/New_York (EST): markets closed since
    /// Friday 16:00 (`FRIDAY_CLOSE`), and nobody has pushed a price.
    uint256 constant SUNDAY_3AM_ET = 1_800_172_800;
    uint256 constant FRIDAY_CLOSE = 1_800_046_800;
    /// 1 WETH buys 16 TSLA on the (mock) V3 pool: $4,000 / $250.
    uint256 constant TSLA_PER_WETH = 16e18;

    bytes32 constant ATOMIC_BUY = keccak256("AtomicBuy(address,address,uint256,uint256,uint256)");

    StonkzLaunchpad pad;
    StonkzRouter router;
    MockSwapRouter02 sr02;
    address user = address(0xC4EA7);

    function setUp() public {
        _setUpSources();
        pad = DeployPad.launchpad(admin, admin, admin, IPriceSource(address(pps)), admin);
        sr02 = new MockSwapRouter02(weth, tsla, TSLA_PER_WETH);
        MockUniversalRouter ur = new MockUniversalRouter(weth, tsla, TSLA_PER_WETH);
        router = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(pyth)),
            IStockAttestationSink(address(0))
        );
        // The upgrade `UpgradeStockLaunch` performs.
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        vm.prank(admin);
        pad.upgradeToAndCall(address(impl), "");
        vm.deal(user, 1000 ether);
    }

    function _coin(string memory ticker) internal view returns (StonkzRouter.CreateParams memory) {
        return StonkzRouter.CreateParams({
            name: "Stock Coin",
            ticker: ticker,
            uri: "ipfs://meta",
            supply: 1_000_000_000,
            baseToken: address(tsla),
            feeBps: 250,
            cashback: false
        });
    }

    /// What the app sends: a fresh ETH/USD print (crypto trades 24/7) and the
    /// TSLA equity feed as Hermes has it (fresh in market hours, Friday's
    /// close on a weekend).
    function _hermes(int64 tsla1e8, uint256 tslaPublish) internal view returns (bytes[] memory u) {
        u = new bytes[](2);
        u[0] = pyth.createUpdate(ETH_USD, 4000e8, 0, -8, block.timestamp - 1);
        u[1] = pyth.createUpdate(TSLA_USD, tsla1e8, 0, -8, tslaPublish);
    }

    function _nextToken() internal view returns (address) {
        return vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
    }

    function _assertRouterEmpty(address token) internal view {
        assertEq(StonkzToken(token).balanceOf(address(router)), 0, "router holds no coin");
        assertEq(tsla.balanceOf(address(router)), 0, "router holds no base");
        assertEq(weth.balanceOf(address(router)), 0, "router holds no weth");
        assertEq(address(router).balance, 0, "router holds no eth");
    }

    /* ------------------------------------------------------ createAndBuyViaV3 */

    function test_CreatesAndDevBuysAStockBaseCoinForTheUser() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        uint256 fee = 2 * PYTH_FEE;
        address expected = _nextToken();
        uint256 ethBefore = user.balance;

        vm.expectEmit(true, true, true, false, address(pad));
        emit StonkzLaunchpad.TokenCreated(expected, address(tsla), user, "", 0, 0, false, 0, 0, 0, 0, 0, 0, 0);
        vm.expectEmit(true, true, false, false, address(router));
        emit StonkzRouter.AtomicBuy(user, expected, 1 ether - fee, (1 ether - fee) * 16, 0);
        // (topics only; the data words are checked from the recorded log below.)
        vm.recordLogs();
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyViaV3{value: 1 ether}(_coin("TSLAX"), u, 3000, 15e18, 1, block.timestamp + 60);
        assertEq(token, expected);
        assertGt(out, 0);
        assertEq(StonkzToken(token).balanceOf(user), out, "tokens land with the user");
        assertEq(user.balance, ethBefore - 1 ether, "the fee came out of msg.value, nothing refunded");
        assertEq(pyth.updates(), 2, "the update was posted");

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.creator, user, "creator is the user");
        assertEq(c.baseToken, address(tsla));
        assertEq(c.creationPrice1e6, 250e6, "both legs agree: the Pyth print");
        assertEq(tsla.balanceOf(address(pad)), (1 ether - fee) * 16, "every TSLA the swap delivered went in");
        _assertRouterEmpty(token);

        // AtomicBuy.tokensOut is the dev buy.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == ATOMIC_BUY) {
                (uint256 ethIn, uint256 base, uint256 tokensOut) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(ethIn, 1 ether - fee, "ethIn = msg.value - fee");
                assertEq(base, (1 ether - fee) * 16);
                assertEq(tokensOut, out);
            }
        }

        // Creator fees are the user's.
        vm.prank(address(router));
        vm.expectRevert(bytes("not creator"));
        pad.claimCreatorFees(token);
        uint256 before = tsla.balanceOf(user);
        vm.prank(user);
        pad.claimCreatorFees(token);
        assertGt(tsla.balanceOf(user), before);
    }

    function test_MinBaseOutRevertsTheWholeLaunch() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        uint256 delivered = (1 ether - 2 * PYTH_FEE) * 16;
        uint256 count = pad.tokenCount();
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                StonkzRouter.AggregatorShortfall.selector, delivered + 1, delivered + 1, delivered
            )
        );
        router.createAndBuyViaV3{value: 1 ether}(
            _coin("MINBASE"), u, 3000, delivered + 1, 0, block.timestamp + 60
        );
        assertEq(pad.tokenCount(), count, "no coin");
    }

    function test_MinTokenOutRevertsTheWholeLaunch() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        uint256 count = pad.tokenCount();
        vm.prank(user);
        vm.expectRevert(bytes("slippage"));
        router.createAndBuyViaV3{value: 1 ether}(
            _coin("MINTOK"), u, 3000, 0, type(uint256).max, block.timestamp + 60
        );
        assertEq(pad.tokenCount(), count, "no coin");
    }

    /// A dev buy bigger than the curve: the unspent base comes back as TSLA.
    function test_RefundsTheBaseTheCurveCannotAbsorb() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyViaV3{value: 100 ether}(_coin("WHALE"), u, 3000, 0, 0, block.timestamp + 60);
        uint256 delivered = (100 ether - 2 * PYTH_FEE) * 16;
        uint256 spent = tsla.balanceOf(address(pad));
        assertGt(out, 0);
        assertTrue(pad.coinInfo(token).complete, "curve exhausted");
        assertLt(spent, delivered);
        assertEq(tsla.balanceOf(user), delivered - spent, "unspent TSLA refunded to the user");
        _assertRouterEmpty(token);
    }

    function test_RejectsAnExpiredDeadline() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        vm.prank(user);
        vm.expectRevert(StonkzRouter.DeadlineExpired.selector);
        router.createAndBuyViaV3{value: 1 ether}(_coin("LATE"), u, 3000, 0, 0, block.timestamp - 1);
    }

    function test_TheUpdateFeeMustBeCovered() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.UpdateFeeUnpaid.selector, 2 * PYTH_FEE, PYTH_FEE));
        router.createAndBuyViaV3{value: PYTH_FEE}(_coin("FEE"), u, 3000, 0, 0, block.timestamp + 60);
    }

    /// `msg.value` that only covers the fee: a plain launch, still the user's.
    function test_NothingBeyondTheFeeIsAPlainLaunch() public {
        bytes[] memory u = _hermes(250e8, block.timestamp - 1);
        vm.recordLogs();
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyViaV3{value: 2 * PYTH_FEE}(_coin("PLAIN"), u, 3000, 0, 0, block.timestamp + 60);
        assertEq(out, 0);
        assertEq(pad.coinInfo(token).creator, user);
        assertEq(pad.coinInfo(token).realBase, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != ATOMIC_BUY, "no buy, no AtomicBuy");
        }
        _assertRouterEmpty(token);
    }

    function test_RejectsAWethBase() public {
        StonkzRouter.CreateParams memory p = _coin("WETHB");
        p.baseToken = address(weth);
        vm.prank(user);
        vm.expectRevert(bytes("weth pair"));
        router.createAndBuyViaV3{value: 1 ether}(p, new bytes[](0), 3000, 0, 0, block.timestamp + 60);
    }

    function test_TheBuyCapApplies() public {
        StonkzRouter capped = new StonkzRouter(
            IUniversalRouter(address(router.universalRouter())),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            1 ether,
            IPyth(address(pyth)),
            IStockAttestationSink(address(0))
        );
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.BuyAboveCap.selector, 2 ether, 1 ether));
        capped.createAndBuyViaV3{value: 2 ether}(
            _coin("CAP"), new bytes[](0), 3000, 0, 0, block.timestamp + 60
        );
    }

    /* ------------------------------------------------------ pricing at any hour */

    /// 03:00 on a Sunday: the equity feed's newest print is Friday's close,
    /// nobody has ever pushed TSLA, and the launch still prices — from the
    /// DEX TWAP, reached through PythPriceSource's fallback.
    function test_SundayThreeAmLaunchNeedsNoPush() public {
        vm.warp(SUNDAY_3AM_ET);
        (uint256 pushed,,) = push.prices(address(tsla));
        assertEq(pushed, 0, "never pushed");

        bytes[] memory u = _hermes(262e8, FRIDAY_CLOSE);
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyViaV3{value: 1 ether}(_coin("SUNDAY"), u, 3000, 0, 1, block.timestamp + 60);
        assertGt(out, 0);
        _assertNear(pad.coinInfo(token).creationPrice1e6, 250e6, 2, "priced by the TWAP, not Friday's close");
        assertEq(pad.coinInfo(token).creator, user);
    }

    /// The same Sunday launch before this change (PythPriceSource → push
    /// oracle only) fails.
    function test_SundayWithoutTheStockSourceFails() public {
        vm.prank(admin);
        pps.setFallbackSource(IPriceSource(address(push)));
        vm.warp(SUNDAY_3AM_ET);
        bytes[] memory u = _hermes(262e8, FRIDAY_CLOSE);
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createAndBuyViaV3{value: 1 ether}(_coin("SUNDAY"), u, 3000, 0, 1, block.timestamp + 60);
    }

    /// Market hours with a manipulated pool (or a bad print): the legs
    /// disagree and the launch is refused rather than priced by either.
    function test_DivergentLegsRefuseTheLaunch() public {
        bytes[] memory u = _hermes(300e8, block.timestamp - 1);
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createAndBuyViaV3{value: 1 ether}(_coin("DIVERGE"), u, 3000, 0, 0, block.timestamp + 60);
    }

    /// Weekend manipulation, end to end: a pool pushed 20% above Friday's
    /// close for the whole 2-hour window. Both callers that snapshot a price
    /// refuse — a launch, and the oracle graduation trigger on a live coin —
    /// where the same coin a few hours earlier got a price ("not graduable").
    function test_WeekendManipulationRefusesCreateAndOracleGraduation() public {
        // Friday in market hours: a TSLA-base coin with some base raised.
        bytes[] memory u = new bytes[](2);
        u[0] = pyth.createUpdate(ETH_USD, 4000e8, 0, -8, T0);
        u[1] = pyth.createUpdate(TSLA_USD, 250e8, 0, -8, T0);
        pyth.updatePriceFeeds{value: 2 * PYTH_FEE}(u);
        vm.prank(user);
        address token = pad.createToken("Weekend", "WKND", "u", 1_000_000_000, address(tsla), 250, false);
        tsla.mint(user, 10e18);
        vm.startPrank(user);
        tsla.approve(address(pad), 10e18);
        pad.buy(token, 10e18, 0);
        vm.stopPrank();

        // Saturday: the close anchors; the honest pool gets a price.
        vm.warp(T0 + 21 hours);
        _postEth(block.timestamp);
        vm.expectRevert(bytes("not graduable"));
        pad.graduate(token);

        // Someone holds the pool 20% up for three hours.
        pool.set(_tickFor(address(tsla), address(weth), 300e6, 4000e6), DEEP);
        vm.warp(T0 + 24 hours);
        _postEth(block.timestamp);

        vm.expectRevert(bytes("stale oracle"));
        pad.graduate(token);
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        pad.createToken("Pumped", "PUMP", "u", 1_000_000_000, address(tsla), 250, false);
        bytes[] memory eth = new bytes[](1);
        eth[0] = pyth.createUpdate(ETH_USD, 4000e8, 0, -8, block.timestamp);
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createAndBuyViaV3{value: 1 ether}(_coin("PUMP"), eth, 3000, 0, 0, block.timestamp + 60);
        assertFalse(pad.coinInfo(token).graduated);
    }

    /// A direct `createToken` on a stock base works the same way (no router).
    function test_DirectCreateTokenOnAStockBase() public {
        bytes[] memory u = new bytes[](1);
        u[0] = pyth.createUpdate(ETH_USD, 4000e8, 0, -8, block.timestamp);
        pyth.updatePriceFeeds{value: PYTH_FEE}(u);
        vm.prank(user);
        address token = pad.createToken("Plain", "PLAIN", "u", 1_000_000_000, address(tsla), 250, false);
        _assertNear(pad.coinInfo(token).creationPrice1e6, 250e6, 2, "TWAP");
    }
}

/// @notice The deploy scripts, against a local 46630 look-alike: mocks etched
/// at the pinned stock-token, pool, WETH and Pyth addresses, a push oracle
/// behind a `PythPriceSource`, and a router-less launchpad proxy with an EOA
/// admin (as `AtomicLaunchScriptsTest` does).
contract StockScriptsTest is Test {
    uint256 constant ADMIN_KEY = 0xAD814; // test-only key
    address admin;
    StonkzLaunchpad pad;
    PythPriceSource pps;
    PushPriceSource push;

    function setUp() public {
        vm.chainId(46630);
        vm.warp(1_800_000_000);
        admin = vm.addr(ADMIN_KEY);
        deployCodeTo("MockPyth.sol:MockPyth", abi.encode(uint256(1)), RobinhoodChainTestnet.PYTH);
        deployCodeTo("MockUniversalRouter.sol:MockWETH", "", RobinhoodChainTestnet.WETH9);
        deployCodeTo("Mocks.sol:MockERC20", abi.encode("USDG", "USDG", uint8(6)), RobinhoodChainTestnet.USDG);
        StockBases.Entry[] memory e = StockBases.forChain();
        for (uint256 i = 0; i < e.length; i++) {
            deployCodeTo("Mocks.sol:MockERC20", abi.encode(e[i].symbol, e[i].symbol, uint8(18)), e[i].token);
            deployCodeTo(
                "MockV3Pool.sol:MockV3Pool",
                abi.encode(e[i].token, e[i].quote, int24(0), uint128(0)),
                e[i].pool
            );
        }
        push = DeployPad.pushOracle(admin, admin, 90_000);
        pps = new PythPriceSource(admin, IPyth(RobinhoodChainTestnet.PYTH));
        vm.prank(admin);
        pps.setFallbackSource(IPriceSource(address(push)));
        pad = DeployPad.launchpad(admin, address(0xC01D1), admin, pps, admin);
    }

    function test_DeployStockPriceSourceConfiguresAndWires() public {
        DeployStockPriceSource s = new DeployStockPriceSource();
        DeployStockPriceSource.Params memory p = s.defaults(address(pps));
        assertEq(p.fallbackSource, address(push), "keeps the push oracle behind it");
        DeployStockPriceSource.Result memory r = s.execute(p, ADMIN_KEY);

        StockPriceSource sps = StockPriceSource(r.source);
        assertEq(r.configured, 5);
        assertTrue(r.fallbackSet);
        assertEq(address(pps.fallbackSource()), r.source, "PythPriceSource now falls back to it");
        assertEq(address(sps.quotePriceSource()), address(pps));
        assertEq(address(sps.fallbackSource()), address(push));
        assertEq(address(sps.pyth()), RobinhoodChainTestnet.PYTH);
        assertEq(sps.admin(), admin);
        assertTrue(sps.isStableQuote(RobinhoodChainTestnet.USDG));

        StockBases.Entry[] memory e = StockBases.forChain();
        for (uint256 i = 0; i < e.length; i++) {
            StockPriceSource.Config memory c = sps.getConfig(e[i].token);
            assertEq(c.p.pool, e[i].pool);
            assertEq(c.p.quoteToken, RobinhoodChainTestnet.WETH9);
            assertEq(c.p.twapSecs, 1800);
            assertEq(c.p.pythFeedId, e[i].pythFeedId);
            assertEq(c.p.maxDeviationBps, 500);
            assertEq(MockV3Pool(e[i].pool).observationCardinalityNext(), 64, "cardinality grown");
        }
        assertEq(sps.getConfig(StockBases.RH_TESTNET_TSLA).p.pythFeedId, StockBases.PYTH_TSLA);

        // A re-run keeps the push oracle as the fallback, not the first stock source.
        assertEq(s.defaults(address(pps)).fallbackSource, address(push));
    }

    function test_DeployStockPriceSourceByANonAdminOnlyDeploys() public {
        DeployStockPriceSource s = new DeployStockPriceSource();
        DeployStockPriceSource.Result memory r = s.execute(s.defaults(address(pps)), 0xBAD);
        assertFalse(r.fallbackSet);
        assertEq(address(pps.fallbackSource()), address(push), "PythPriceSource untouched");
        assertEq(StockPriceSource(r.source).pendingAdmin(), admin, "offered to the real admin");
    }

    function test_UpgradeStockLaunchTrustsANewRouterAndKeepsLayout() public {
        // A router the proxy trusts today, with a cap to carry over.
        StonkzRouter old = new StonkzRouter(
            IUniversalRouter(RobinhoodChainTestnet.UNIVERSAL_ROUTER),
            pad,
            IWETH9(RobinhoodChainTestnet.WETH9),
            ISwapRouter02(RobinhoodChainTestnet.UNISWAP_V3_SWAP_ROUTER02),
            5 ether,
            IPyth(RobinhoodChainTestnet.PYTH),
            IStockAttestationSink(address(0))
        );
        StonkzLaunchpad oldImpl = new StonkzLaunchpad(address(old));
        vm.prank(admin);
        pad.upgradeToAndCall(address(oldImpl), "");
        bytes32[18] memory before;
        for (uint256 i = 0; i < 18; i++) {
            before[i] = vm.load(address(pad), bytes32(i));
        }

        UpgradeStockLaunch s = new UpgradeStockLaunch();
        UpgradeStockLaunch.Params memory p = s.defaults(address(pad));
        assertEq(p.cap, 5 ether, "cap carried over");
        assertEq(p.pyth, RobinhoodChainTestnet.PYTH);
        p.pauser = address(0x9A05E);
        UpgradeStockLaunch.Result memory r = s.execute(p, ADMIN_KEY);

        assertTrue(r.upgraded);
        assertEq(pad.trustedRouter(), r.router, "proxy trusts the new router");
        assertEq(StonkzRouter(payable(r.router)).maxBuyNative(), 5 ether);
        assertEq(pad.pauser(), address(0x9A05E), "pauser slot still works");
        for (uint256 i = 0; i < 18; i++) {
            if (i == 16) continue;
            assertEq(vm.load(address(pad), bytes32(i)), before[i], "layout unchanged");
        }

        // The old router can no longer launch; the new one can.
        vm.expectRevert(bytes("not router"));
        old.createWithPriceUpdate(_plain(), new bytes[](0), block.timestamp + 60);
    }

    function test_UpgradeStockLaunchByANonAdminOnlyDeploys() public {
        UpgradeStockLaunch s = new UpgradeStockLaunch();
        UpgradeStockLaunch.Result memory r = s.execute(s.defaults(address(pad)), 0xBAD);
        assertFalse(r.upgraded);
        assertEq(pad.trustedRouter(), address(0));
        assertEq(StonkzLaunchpad(r.impl).trustedRouter(), r.router);
    }

    function _plain() internal pure returns (StonkzRouter.CreateParams memory) {
        return
            StonkzRouter.CreateParams("X", "X", "u", 1_000_000_000, RobinhoodChainTestnet.WETH9, 250, false);
    }
}
