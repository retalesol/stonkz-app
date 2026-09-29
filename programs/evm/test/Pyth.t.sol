// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockUniversalRouter, MockWETH, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice Launch pricing on Pyth's pull model: the launch transaction
/// carries a Hermes update, the router posts it (paying its fee out of
/// `msg.value`), and the launchpad snapshots a seconds-old price. No keeper,
/// no server key.
contract PythTest is Test {
    bytes32 constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    uint256 constant FEE = 1 wei * 1e9; // per update

    MockPyth pyth;
    PythPriceSource source;
    PushPriceSource push;
    StonkzLaunchpad pad;
    StonkzRouter router;
    MockWETH weth;
    MockERC20 usdg;
    MockERC20 stock;

    address admin = address(0xA11CE);
    address user = address(0xC4EA7);

    function setUp() public {
        vm.warp(1_800_000_000);
        pyth = new MockPyth(FEE);
        weth = new MockWETH();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        stock = new MockERC20("Tesla", "TSLA", 18);

        // The previous push oracle stays on as the fallback for bases Pyth does
        // not cover.
        push = DeployPad.pushOracle(admin, admin, 90_000);
        vm.prank(admin);
        push.pushPrice(address(stock), 250e6, 0);

        source = new PythPriceSource(admin, IPyth(address(pyth)));
        vm.startPrank(admin);
        source.setFeed(address(weth), ETH_USD, 120, 100e6, 100_000e6);
        source.setFixedPrice(address(usdg), 1e6, 120);
        source.setFallbackSource(IPriceSource(address(push)));
        vm.stopPrank();

        pad = DeployPad.launchpad(admin, admin, admin, source, admin);
        MockUniversalRouter ur = new MockUniversalRouter(weth, usdg, 3_000e6);
        MockSwapRouter02 sr02 = new MockSwapRouter02(weth, usdg, 3_000e6);
        router = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(pyth))
        );
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        vm.startPrank(admin);
        pad.upgradeToAndCall(address(impl), "");
        // What `UpgradeAtomicLaunch` sets: with in-tx updates this can be tight.
        pad.setMaxOracleStaleness(120);
        vm.stopPrank();

        // On chain, ETH/USD was last updated six days ago (RH 46630 today).
        pyth.updatePriceFeeds{value: FEE}(_update(3_000e8, 1e8, block.timestamp - 6 days));
        vm.deal(user, 100 ether);
    }

    /// @dev `MockPyth.createUpdate`'s encoding, built locally so it makes no
    /// external call (which would consume a pending `vm.prank`/`expectRevert`).
    function _update(int64 price, uint64 conf, uint256 publishTime) internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encode(ETH_USD, price, conf, int32(-8), publishTime);
    }

    function _params(string memory ticker, address base)
        internal
        pure
        returns (StonkzRouter.CreateParams memory)
    {
        return StonkzRouter.CreateParams({
            name: "Pyth Coin",
            ticker: ticker,
            uri: "ipfs://p",
            supply: 1_000_000_000,
            baseToken: base,
            feeBps: 250,
            cashback: false
        });
    }

    /* ------------------------------------------------------ PythPriceSource */

    function test_ScalesPythExponentsTo1e6() public {
        pyth.updatePriceFeeds{value: FEE}(_update(2_761_47922801, 45364678, block.timestamp));
        (uint256 p, uint256 at, uint256 age) = source.priceUsd1e6(address(weth));
        assertEq(p, 2_761_479228, "$2,761.479228 from expo -8");
        assertEq(at, block.timestamp);
        assertEq(age, 120);

        // Other exponents.
        bytes32 id = keccak256("X");
        vm.prank(admin);
        source.setFeed(address(0xE1), id, 60, 1, type(uint64).max);
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(id, int64(5), uint64(0), int32(2), block.timestamp); // 5e2 = $500
        pyth.updatePriceFeeds{value: FEE}(u);
        (p,,) = source.priceUsd1e6(address(0xE1));
        assertEq(p, 500e6);
    }

    function test_AWideConfidenceIntervalIsNoAnswer() public {
        // conf 2.5% of price.
        pyth.updatePriceFeeds{value: FEE}(_update(3_000e8, 75e8, block.timestamp));
        (uint256 p,,) = source.priceUsd1e6(address(weth));
        assertEq(p, 0);
        // conf exactly 2% is still an answer.
        pyth.updatePriceFeeds{value: FEE}(_update(3_000e8, 60e8, block.timestamp + 1));
        vm.warp(block.timestamp + 1);
        (p,,) = source.priceUsd1e6(address(weth));
        assertEq(p, 3_000e6);
    }

    function test_APriceOutsideTheBandIsNoAnswer() public {
        pyth.updatePriceFeeds{value: FEE}(_update(99e8, 0, block.timestamp)); // $99 < $100 floor
        (uint256 p,,) = source.priceUsd1e6(address(weth));
        assertEq(p, 0, "below band");
        pyth.updatePriceFeeds{value: FEE}(_update(100_001e8, 0, block.timestamp + 1));
        vm.warp(block.timestamp + 1);
        (p,,) = source.priceUsd1e6(address(weth));
        assertEq(p, 0, "above band");
    }

    function test_NeverRevertsOnAFeedPythHasNeverSeen() public {
        vm.prank(admin);
        source.setFeed(address(0xE2), keccak256("never"), 60, 1, 2);
        (uint256 p, uint256 at, uint256 age) = source.priceUsd1e6(address(0xE2));
        assertEq(p, 0);
        assertEq(at, 0);
        assertEq(age, 60);
        // And an unknown base with no fallback is zero, not a revert.
        vm.prank(admin);
        source.setFallbackSource(IPriceSource(address(0)));
        (p,,) = source.priceUsd1e6(address(0xE3));
        assertEq(p, 0);
    }

    function test_StablesAreAFixedDollarAndOthersFallBack() public view {
        (uint256 p, uint256 at,) = source.priceUsd1e6(address(usdg));
        assertEq(p, 1e6);
        assertEq(at, block.timestamp, "always current");
        (p,,) = source.priceUsd1e6(address(stock));
        assertEq(p, 250e6, "the push oracle still prices what Pyth does not");
    }

    /// Hermes can stamp an update slightly ahead of the chain's clock; the
    /// launchpad refuses a price from the future, so it is reported as now.
    function test_AFutureStampedUpdateReadsAsCurrent() public {
        pyth.updatePriceFeeds{value: FEE}(_update(3_000e8, 0, block.timestamp + 3));
        (uint256 p, uint256 at,) = source.priceUsd1e6(address(weth));
        assertEq(p, 3_000e6);
        assertEq(at, block.timestamp);
    }

    function test_OnlyTheAdminConfiguresAndHandoverIsTwoStep() public {
        vm.expectRevert(bytes("not admin"));
        source.setFeed(address(weth), ETH_USD, 1, 1, 1);
        vm.expectRevert(bytes("not admin"));
        source.setFixedPrice(address(weth), 1, 1);
        vm.expectRevert(bytes("not admin"));
        source.setFallbackSource(IPriceSource(address(0)));

        vm.prank(admin);
        source.proposeAdmin(address(0x7133));
        assertEq(source.admin(), admin, "nothing moves until accepted");
        vm.expectRevert(bytes("not pending"));
        source.acceptAdmin();
        vm.prank(address(0x7133));
        source.acceptAdmin();
        assertEq(source.admin(), address(0x7133));
    }

    /* --------------------------------------------------- the launch path */

    /// The on-chain price is six days old: without an update the launch is
    /// refused with the string the API preflight maps.
    function test_StaleWithoutAnUpdateIsRefused() public {
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createAndBuyWithEth{value: 1 ether}(
            _params("STALE", address(weth)), new bytes[](0), 0, block.timestamp + 60
        );

        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createWithPriceUpdate(_params("STALE", address(weth)), new bytes[](0), block.timestamp + 60);

        // And the direct path is refused the same way.
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        pad.createToken("Pyth Coin", "STALE", "u", 1_000_000_000, address(weth), 250, false);
    }

    /// Update, create and dev-buy in one transaction. The fee comes out of
    /// `msg.value`; the rest is the buy.
    function test_UpdateThenCreateAndBuyInOneTransaction() public {
        uint256 before = user.balance;
        bytes[] memory u = _update(3_200e8, 1e8, block.timestamp - 2);

        vm.expectEmit(true, false, false, false, address(router));
        emit StonkzRouter.AtomicBuy(user, address(0), 1 ether - FEE, 0, 0);
        vm.prank(user);
        (address token, uint256 out) = router.createAndBuyWithEth{value: 1 ether}(
            _params("PYTH", address(weth)), u, 1, block.timestamp + 60
        );

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.creator, user);
        assertEq(c.creationPrice1e6, 3_200e6, "the curve snapshots the price the update carried");
        assertEq(address(pyth).balance, FEE * 2, "the update fee went to Pyth (plus setUp's)");
        assertEq(weth.balanceOf(address(pad)), 1 ether - FEE, "everything else was the dev buy");
        assertEq(user.balance, before - 1 ether);
        assertEq(StonkzToken(token).balanceOf(user), out);
        assertEq(address(router).balance, 0, "router holds no eth");
        assertEq(weth.balanceOf(address(router)), 0, "router holds no weth");
    }

    /// Create-only, on any base — every app launch goes through the router.
    function test_CreateOnlyRefundsEverythingAboveTheFee() public {
        uint256 before = user.balance;
        vm.prank(user);
        address token = router.createWithPriceUpdate{value: 0.01 ether}(
            _params("NOBUY", address(weth)), _update(3_000e8, 1e8, block.timestamp), block.timestamp + 60
        );
        assertEq(pad.coinInfo(token).creator, user);
        assertEq(pad.coinInfo(token).realBase, 0, "no buy");
        assertEq(user.balance, before - FEE, "only the fee was kept");
        assertEq(address(router).balance, 0);

        // A stable-based launch needs no update at all.
        vm.prank(user);
        address usdCoin = router.createWithPriceUpdate(
            _params("USDC", address(usdg)), new bytes[](0), block.timestamp + 60
        );
        assertEq(pad.coinInfo(usdCoin).creator, user);
        assertEq(pad.coinInfo(usdCoin).creationPrice1e6, 1e6);
    }

    function test_AnUnpaidUpdateFeeReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.UpdateFeeUnpaid.selector, FEE, FEE - 1));
        router.createWithPriceUpdate{value: FEE - 1}(
            _params("FEE", address(weth)), _update(3_000e8, 1e8, block.timestamp), block.timestamp + 60
        );
    }

    /// A fee-only `msg.value` on the buy entry point is a plain launch.
    function test_AFeeOnlyValueLaunchesWithoutABuy() public {
        vm.prank(user);
        (address token, uint256 out) = router.createAndBuyWithEth{value: FEE}(
            _params("FEEONLY", address(weth)), _update(3_000e8, 1e8, block.timestamp), 1, block.timestamp + 60
        );
        assertEq(out, 0);
        assertEq(pad.coinInfo(token).creator, user);
    }

    /// An update whose price is outside the sanity band lands in Pyth but is
    /// no answer to the launchpad: refused as stale, nothing created.
    function test_ABandViolatingUpdateIsRefused() public {
        uint256 count = pad.tokenCount();
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createAndBuyWithEth{value: 1 ether}(
            _params("BAND", address(weth)),
            _update(1_000_000e8, 1e8, block.timestamp),
            0,
            block.timestamp + 60
        );
        assertEq(pad.tokenCount(), count);
    }

    /// A price older than the launchpad's 120 s bound is refused even if it
    /// was posted by an update: the bound is what makes in-tx updates matter.
    function test_AnUpdateOlderThanTheBoundIsRefused() public {
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createWithPriceUpdate{value: FEE}(
            _params("OLD", address(weth)), _update(3_000e8, 1e8, block.timestamp - 121), block.timestamp + 60
        );
    }

    /// A router built without Pyth refuses a non-empty update rather than
    /// silently ignoring it.
    function test_ARouterWithoutPythRefusesAnUpdate() public {
        StonkzRouter bare = new StonkzRouter(
            router.universalRouter(), pad, IWETH9(address(weth)), router.swapRouter02(), 0, IPyth(address(0))
        );
        bytes[] memory u = _update(3_000e8, 1e8, block.timestamp);
        vm.prank(user);
        vm.expectRevert(StonkzRouter.NoPyth.selector);
        bare.createWithPriceUpdate{value: FEE}(_params("BARE", address(weth)), u, block.timestamp + 60);
    }
}
