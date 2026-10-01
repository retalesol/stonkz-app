// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {UniswapV2Migrator, IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {StonkzV2Factory, StonkzV2Pair} from "../src/testnet/StonkzV2Factory.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLens} from "../src/StonkzLens.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockUniversalRouter, MockWETH, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice The graduation *trigger* end to end, as it is wired on RH 46630 and
/// Base 84532 today: the launchpad prices through `PythPriceSource`, whose
/// per-feed bound (120 s) is far tighter than any wallet can rely on between
/// Hermes pulls, so the oracle trigger is only reachable through a transaction
/// that carries the update. `StonkzRouter.graduateWithPriceUpdate` is that
/// transaction. `test/Migration.t.sol` owns what happens to the reserves after
/// the flag flips; this file owns getting the flag to flip, and the ledgers
/// that must keep paying out afterwards.
contract GraduationTest is Test {
    bytes32 constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    uint256 constant FEE = 1 wei * 1e9;

    StonkzLaunchpad pad;
    StonkzRouter router;
    MockPyth pyth;
    MockWETH weth;
    PythPriceSource source;
    PushPriceSource push;
    StonkzV2Factory factory;
    UniswapV2Migrator migrator;
    StonkzLens lens;

    address admin = address(0xA11CE);
    address migAuth = address(0x11165);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address keeper = address(0x6EE9E7);
    address staker = address(0x57A6E7);

    function setUp() public {
        vm.warp(1_800_000_000);
        pyth = new MockPyth(FEE);
        weth = new MockWETH();
        push = DeployPad.pushOracle(admin, admin, 90_000);

        source = new PythPriceSource(admin, IPyth(address(pyth)));
        vm.startPrank(admin);
        // The live RH / Base configuration: ETH/USD through Pyth, 120 s max age.
        source.setFeed(address(weth), ETH_USD, 120, 100e6, 100_000e6);
        source.setFallbackSource(IPriceSource(address(push)));
        vm.stopPrank();

        pad = DeployPad.launchpad(admin, admin, admin, source, migAuth);
        lens = new StonkzLens();
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockUniversalRouter ur = new MockUniversalRouter(weth, usdg, 3_000e6);
        MockSwapRouter02 sr02 = new MockSwapRouter02(weth, usdg, 3_000e6);
        router = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(pyth)),
            IStockAttestationSink(address(0))
        );
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        factory = new StonkzV2Factory();
        migrator = new UniswapV2Migrator(IUniswapV2Factory(address(factory)), address(pad));
        vm.startPrank(admin);
        pad.upgradeToAndCall(address(impl), "");
        pad.setMaxOracleStaleness(90_000);
        pad.setMigrator(IGraduationMigrator(address(migrator)), migAuth);
        vm.stopPrank();

        // A fresh ETH/USD at $3,000 so the launch can price itself.
        pyth.updatePriceFeeds{value: FEE}(_update(3_000e8, 1e8, block.timestamp));

        vm.deal(trader, 10_000 ether);
        vm.deal(keeper, 1 ether);
        vm.deal(staker, 100 ether);
        vm.prank(trader);
        weth.deposit{value: 9_000 ether}();
        vm.prank(trader);
        weth.approve(address(pad), type(uint256).max);
        vm.prank(staker);
        weth.deposit{value: 50 ether}();
        vm.prank(staker);
        weth.approve(address(pad), type(uint256).max);
    }

    function _update(int64 price, uint64 conf, uint256 publishTime) internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encode(ETH_USD, price, conf, int32(-8), publishTime);
    }

    function _none() internal pure returns (bytes[] memory u) {
        u = new bytes[](0);
    }

    function _launch(string memory ticker) internal returns (address token) {
        vm.prank(creator);
        token = pad.createToken("Coin", ticker, "u", 1_000_000_000, address(weth), 250, false);
    }

    /// Buys to roughly $40K at the launch price (ETH $3,000) with tokens left
    /// on the curve. The oracle trigger then needs ETH to have *risen*: at
    /// $6,000 the same reserves are worth ~$80K, past the $69K line — which is
    /// exactly the fresh price `_risen()` carries. That is the shape only a
    /// price update can graduate: the curve is not exhausted, and nothing but
    /// the oracle knows the cap moved.
    function _buyMostOfTheWay(address token) internal {
        for (uint256 i = 0; i < 40; i++) {
            (, uint256 usd) = lens.marketCap(pad, token);
            if (usd >= 40_000e6) break;
            vm.prank(trader);
            pad.buy(token, 1 ether, 0);
        }
        (, uint256 usdAtLaunch) = lens.marketCap(pad, token);
        assertLt(usdAtLaunch, CurveMath.GRAD_MCAP_USD_1E6, "under the cap at the launch price");
        assertGt(pad.coinInfo(token).realToken, 0, "tokens remain on the curve");
    }

    /// ETH/USD at $6,000, stamped now.
    function _risen() internal view returns (bytes[] memory) {
        return _update(6_000e8, 1e8, block.timestamp);
    }

    function _exhaust(address token) internal {
        for (uint256 i = 0; i < 60 && pad.coinInfo(token).realToken > 0; i++) {
            vm.prank(trader);
            pad.buy(token, 5 ether, 0);
        }
        assertEq(pad.coinInfo(token).realToken, 0, "curve exhausted");
    }

    /* ------------------------------------------------------------- trigger */

    /// The scenario that motivated the router path: the on-chain feed is
    /// older than the source's bound, so `graduate` defers ("stale oracle",
    /// never a wedge) — and the same call with a Hermes update in front of it
    /// graduates, from any wallet, for the price of the update.
    function test_OracleTriggerIsReachableOnlyThroughAPriceUpdate() public {
        address token = _launch("PYTHG");
        _buyMostOfTheWay(token);

        // Time passes; nobody has pulled a fresh ETH/USD in a while.
        vm.warp(block.timestamp + 1 days);

        vm.prank(keeper);
        vm.expectRevert(bytes("stale oracle"));
        pad.graduate(token);

        uint256 before = keeper.balance;
        vm.prank(keeper);
        router.graduateWithPriceUpdate{value: FEE * 3}(token, _risen(), block.timestamp + 60);

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertTrue(c.graduated, "graduated through the router");
        assertEq(c.graduationReason, 1, "on the oracle trigger");
        assertEq(c.realToken, 0, "the unsold allocation was burned");
        assertEq(keeper.balance, before - FEE, "only the update fee was spent; the rest came back");
        assertEq(address(pyth).balance, FEE * 2, "Pyth received exactly one update fee (plus setUp's)");
    }

    /// The launchpad, not the router, decides. A token under the cap stays.
    function test_TheRouterCannotGraduateWhatTheLaunchpadWouldNot() public {
        address token = _launch("YOUNG");
        vm.prank(trader);
        pad.buy(token, 0.1 ether, 0);
        vm.warp(block.timestamp + 1 days);

        vm.prank(keeper);
        vm.expectRevert(bytes("not graduable"));
        router.graduateWithPriceUpdate{value: FEE}(
            token, _update(3_000e8, 1e8, block.timestamp), block.timestamp + 60
        );
        assertFalse(pad.coinInfo(token).graduated);
        assertTrue(pad.coinInfo(token).realToken > 0);
    }

    /// An exhausted curve consults no oracle: the router path with an empty
    /// update is a plain `graduate`, and a stale feed cannot stop it.
    function test_AnExhaustedCurveGraduatesWithoutAnUpdateEvenWhenTheFeedIsStale() public {
        address token = _launch("FULL");
        _exhaust(token);
        vm.warp(block.timestamp + 30 days); // the oracle is long dead

        vm.prank(keeper);
        router.graduateWithPriceUpdate(token, _none(), block.timestamp + 60);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertTrue(c.graduated);
        assertEq(c.graduationReason, 0, "curve complete");
    }

    /// The admin switch that stops the early trigger does not reach the
    /// exhaustion trigger, and applies equally through the router.
    function test_PausingOracleGraduationOnlyRemovesTheEarlyTrigger() public {
        address early = _launch("EARLY");
        _buyMostOfTheWay(early);
        address full = _launch("FULL2");
        _exhaust(full);

        vm.prank(admin);
        pad.setPause(false, false, false, false, true);

        vm.prank(keeper);
        vm.expectRevert(bytes("oracle graduation paused"));
        router.graduateWithPriceUpdate{value: FEE}(early, _risen(), block.timestamp + 60);
        vm.prank(keeper);
        router.graduateWithPriceUpdate(full, _none(), block.timestamp + 60);
        assertTrue(pad.coinInfo(full).graduated);
        assertFalse(pad.coinInfo(early).graduated);
    }

    function test_AGraduatedTokenCannotBeGraduatedAgain() public {
        address token = _launch("TWICE");
        _exhaust(token);
        pad.graduate(token);
        vm.prank(keeper);
        vm.expectRevert(bytes("graduated"));
        router.graduateWithPriceUpdate(token, _none(), block.timestamp + 60);
    }

    function test_AnUnpaidUpdateFeeRevertsBeforeTouchingTheCurve() public {
        address token = _launch("UNPAID");
        _buyMostOfTheWay(token);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.UpdateFeeUnpaid.selector, FEE, 0));
        router.graduateWithPriceUpdate(token, _update(3_000e8, 1e8, block.timestamp), block.timestamp + 60);
        assertFalse(pad.coinInfo(token).graduated);
    }

    function test_AnExpiredDeadlineIsRefused() public {
        address token = _launch("LATE");
        _exhaust(token);
        vm.prank(keeper);
        vm.expectRevert(StonkzRouter.DeadlineExpired.selector);
        router.graduateWithPriceUpdate(token, _none(), block.timestamp - 1);
    }

    /// A router deployed without Pyth (a chain that has none) still serves the
    /// exhaustion trigger and refuses a non-empty update loudly.
    function test_ARouterWithoutPythStillGraduatesAnExhaustedCurve() public {
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockUniversalRouter ur = new MockUniversalRouter(weth, usdg, 3_000e6);
        MockSwapRouter02 sr02 = new MockSwapRouter02(weth, usdg, 3_000e6);
        StonkzRouter bare = new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(0)),
            IStockAttestationSink(address(0))
        );
        address token = _launch("NOPYTH");
        _exhaust(token);
        vm.prank(keeper);
        vm.expectRevert(StonkzRouter.NoPyth.selector);
        bare.graduateWithPriceUpdate{value: FEE}(
            token, _update(3_000e8, 1e8, block.timestamp), block.timestamp + 60
        );
        vm.prank(keeper);
        bare.graduateWithPriceUpdate(token, _none(), block.timestamp + 60);
        assertTrue(pad.coinInfo(token).graduated);
    }

    /* ---------------------------------------------------- after the trigger */

    /// Graduation and migration are two transactions on purpose (the second
    /// is gated on the migration authority). Between them the curve is closed
    /// and the raise still sits on the launchpad; after, every LP token is at
    /// the dead address and the ledger cannot release twice.
    function test_TriggerThenMigrateLeavesEveryLpTokenBurned() public {
        address token = _launch("BOND");
        _buyMostOfTheWay(token);
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        router.graduateWithPriceUpdate{value: FEE}(token, _risen(), block.timestamp + 60);

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        uint256 raise = c.realBase;
        uint256 escrow = c.lpReserve;
        assertGt(raise, 0);
        assertGt(escrow, 0);
        assertGe(weth.balanceOf(address(pad)), raise, "the raise is still on the launchpad");

        vm.prank(trader);
        vm.expectRevert(bytes("graduated"));
        pad.buy(token, 1 ether, 0);

        vm.prank(migAuth);
        pad.migrateLiquidity(token);

        StonkzV2Pair pair = StonkzV2Pair(factory.getPair(token, address(weth)));
        assertEq(pair.balanceOf(migrator.BURN_ADDRESS()), pair.totalSupply(), "all LP is dead");
        assertEq(weth.balanceOf(address(pair)), raise, "the whole raise is in the pool");
        assertEq(StonkzToken(token).balanceOf(address(pair)), escrow, "so is the escrowed 20%");
        assertEq(pad.coinInfo(token).realBase, 0);
        assertEq(pad.coinInfo(token).lpReserve, 0);
    }

    /// Fail closed, with a legible reason, when the release is misconfigured.
    function test_MigrationFailsClosedWithoutAuthorityOrMigrator() public {
        address token = _launch("CLOSED");
        _exhaust(token);
        pad.graduate(token);

        vm.prank(keeper);
        vm.expectRevert(bytes("not migration authority"));
        pad.migrateLiquidity(token);

        vm.prank(admin);
        pad.setMigrator(IGraduationMigrator(address(0)), migAuth);
        vm.prank(migAuth);
        vm.expectRevert(bytes("no migrator"));
        pad.migrateLiquidity(token);

        // Nothing moved; the raise is intact for when the wiring is fixed.
        assertGt(pad.coinInfo(token).realBase, 0);
        vm.prank(admin);
        pad.setMigrator(IGraduationMigrator(address(migrator)), migAuth);
        vm.prank(migAuth);
        pad.migrateLiquidity(token);
        assertEq(pad.coinInfo(token).realBase, 0);
    }

    /// Curve fees stop at graduation; what accrued before it still pays out,
    /// to the creator and to stakers, and stakers can leave — before and
    /// after the reserves have left for the pool.
    function test_AccruedFeesStillPayOutAndStakersCanLeaveAfterGraduation() public {
        address token = _launch("FEES");
        vm.prank(trader);
        pad.buy(token, 2 ether, 0);

        // A staker with a real lock, so the bucket peels a staker share.
        vm.prank(trader);
        StonkzToken(token).transfer(staker, 1_000_000e18);
        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        pad.stake(token, 1_000_000e18, 30);
        vm.stopPrank();

        _exhaust(token);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertGt(c.creatorClaimableBase, 0, "creator fees accrued on the curve");
        (uint256 stakerBase,) = pad.pendingStakeRewards(token, staker);
        assertGt(stakerBase, 0, "staker rewards accrued on the curve");

        pad.graduate(token);
        vm.prank(migAuth);
        pad.migrateLiquidity(token);

        // The 69% bucket is a separate ledger from the raise, so migrating
        // the raise leaves every claim funded.
        uint256 creatorBefore = weth.balanceOf(creator);
        vm.prank(creator);
        pad.claimCreatorFees(token);
        assertEq(weth.balanceOf(creator) - creatorBefore, c.creatorClaimableBase, "creator paid in full");

        uint256 stakerBefore = weth.balanceOf(staker);
        vm.prank(staker);
        pad.claimStake(token);
        assertEq(weth.balanceOf(staker) - stakerBefore, stakerBase, "staker paid in full");

        vm.warp(block.timestamp + 31 days);
        vm.prank(staker);
        pad.unstake(token, 1_000_000e18);
        assertEq(StonkzToken(token).balanceOf(staker), 1_000_000e18, "stake returned after graduation");

        // And the bucket is exactly drained: no ledger was left short.
        StonkzLaunchpad.Coin memory after_ = pad.coinInfo(token);
        assertEq(after_.creatorClaimableBase, 0);
        assertLe(after_.bucketBase, after_.poolDustBase + 1, "only dust remains in the bucket");
    }

    /// Staking after graduation still works mechanically (the token is live on
    /// the DEX), but nothing new accrues — the curve is the only fee source.
    function test_NothingAccruesToStakersAfterGraduation() public {
        address token = _launch("POST");
        _exhaust(token);
        pad.graduate(token);
        vm.prank(trader);
        StonkzToken(token).transfer(staker, 10e18);
        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        pad.stake(token, 10e18, 0);
        vm.stopPrank();
        (uint256 b, uint256 t) = pad.pendingStakeRewards(token, staker);
        assertEq(b + t, 0, "no post-graduation accrual source exists on the curve");
        vm.prank(staker);
        pad.unstake(token, 10e18);
    }
}
