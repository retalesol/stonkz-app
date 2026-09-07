// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @notice The EVM half of review gate 2.A, plus the Phase 4 gates.
///
/// `Parity.t.sol` already proves this contract's arithmetic matches the Anchor
/// program's to the atom. This suite proves the *settlement*: that the wei land
/// in the ledgers the split says they should, that the treasuries have no user
/// -facing claim path, that locks hold, and that a stale oracle cannot wedge a
/// coin on the curve.
contract LaunchpadTest is Test {
    StonkzLaunchpad pad;
    PushPriceSource oracle;
    MockERC20 base;

    address admin = address(0xA11CE);
    address protocolCold = address(0xC01D1);
    address opsCold = address(0xC01D2);
    address oracleAuth = address(0x0AC1E);
    address migAuth = address(0x11165);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address staker = address(0x57A4E);

    uint8 constant BASE_DECIMALS = 6;
    /// One whole base token in atoms.
    uint256 constant ONE = 10 ** BASE_DECIMALS;
    /// @dev The curve takes `gradMcapBase / 5` — $13,800 against a $1 base —
    /// between launch and exhaustion. Ordinary fills in this suite stay a long
    /// way inside that so a test that means to exercise staking does not
    /// accidentally graduate the coin instead.
    uint256 constant FILL = 400 * ONE;
    /// $1.00, the USDG case.
    uint256 constant BASE_PRICE_1E6 = 1_000_000;
    uint256 constant SUPPLY = 1_000_000_000;

    function setUp() public {
        // Start well clear of zero: the cashback window subtracts from
        // `block.timestamp` and a genesis timestamp hides sign errors.
        vm.warp(1_800_000_000);

        base = new MockERC20("Global Dollar", "USDG", BASE_DECIMALS);
        oracle = new PushPriceSource(admin, oracleAuth, 90_000);
        pad = new StonkzLaunchpad(admin, protocolCold, opsCold, oracle, migAuth);

        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), BASE_PRICE_1E6, 0);

        for (uint256 i = 0; i < 3; i++) {
            address who = [trader, staker, creator][i];
            base.mint(who, 5_000_000 * ONE);
            vm.prank(who);
            base.approve(address(pad), type(uint256).max);
        }
    }

    function _launch(string memory ticker, uint16 feeBps, bool cashback) internal returns (address) {
        vm.prank(creator);
        return pad.createToken("Coin", ticker, "ipfs://x", SUPPLY, address(base), feeBps, cashback);
    }

    function _buy(address token, address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return pad.buy(token, amount, 0);
    }

    function _sell(address token, address who, uint256 amount) internal returns (uint256) {
        vm.startPrank(who);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        uint256 out = pad.sell(token, amount, 0);
        vm.stopPrank();
        return out;
    }

    /* --------------------------------------------------------- create_token */

    function test_CreateTokenSeedsTheCurveAndHasNoMintPath() public {
        address token = _launch("MOON", 250, false);
        StonkzToken t = StonkzToken(token);

        uint256 supplyAtoms = SUPPLY * 1e18;
        assertEq(t.totalSupply(), supplyAtoms, "fixed supply minted once");
        assertEq(t.balanceOf(address(pad)), supplyAtoms, "all of it escrowed at the pad");
        // There is no mint function at all, which is the EVM shape of the
        // Anchor program setting mint and freeze authority to None.
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", trader, 1));
        assertFalse(ok, "no mint path may exist");

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.tokensForSale + c.lpReserve, supplyAtoms, "supply conserved");
        assertEq(c.lpReserve, supplyAtoms / 5, "20% escrowed for the pool");
        assertGt(c.virtualToken, c.tokensForSale, "virtual reserve exceeds the sellable float");
        assertGt(c.virtualBase, 0);
    }

    function test_RejectsDuplicateTickerBadFeeAndBadTicker() public {
        _launch("DUPE", 250, false);
        vm.prank(creator);
        vm.expectRevert(bytes("ticker taken"));
        pad.createToken("Coin", "DUPE", "u", SUPPLY, address(base), 250, false);

        vm.prank(creator);
        vm.expectRevert(bytes("fee"));
        pad.createToken("Coin", "LOWFEE", "u", SUPPLY, address(base), 99, false);

        vm.prank(creator);
        vm.expectRevert(bytes("fee"));
        pad.createToken("Coin", "HIGHFEE", "u", SUPPLY, address(base), 501, false);

        vm.prank(creator);
        vm.expectRevert(bytes("ticker"));
        pad.createToken("Coin", "lower", "u", SUPPLY, address(base), 250, false);
    }

    function test_RefusesToLaunchAgainstAStaleOracle() public {
        vm.warp(block.timestamp + 200_000);
        vm.prank(creator);
        vm.expectRevert(bytes("stale oracle"));
        pad.createToken("Coin", "STALE", "u", SUPPLY, address(base), 250, false);
    }

    /* ----------------------------------------------------------- fee split */

    /// The gate: 20/10/70, exact to the wei, on every fill.
    function testFuzz_FeeSplitIsExactOnEveryFill(uint96 amountIn, uint16 feeSeed, bool sellSome)
        public
    {
        uint16 feeBps = uint16(100 + (uint256(feeSeed) % 401));
        // Bounded by the curve's total capacity: past `gradMcapBase / 5` the
        // fill is capped and the coin completes, which is its own test.
        uint256 amount = 1 + (uint256(amountIn) % (5_000 * ONE));
        base.mint(trader, amount);

        address token = _launch("FUZZ", feeBps, false);

        uint256 padBase0 = base.balanceOf(address(pad));
        StonkzLaunchpad.Coin memory c0 = pad.coinInfo(token);

        (CurveMath.BuyFill memory q,,) = pad.quoteBuy(token, amount);
        vm.assume(q.tokensOut > 0);
        _buy(token, trader, amount);

        uint256 fee = _assertSplit(token, c0);
        // Everything the trader paid is still here: the fee is a routing
        // decision inside this contract, not a transfer out of it.
        assertEq(base.balanceOf(address(pad)) - padBase0, q.grossBase, "gross pulled once");
        assertEq(fee, q.fee, "fee matches the quote");

        if (sellSome) {
            uint256 held = StonkzToken(token).balanceOf(trader);
            vm.assume(held > 1);
            // A sell too small to return a single atom of base reverts rather
            // than burning the seller's tokens for nothing. That is its own
            // test; here it just means there is no fill to check.
            try pad.quoteSell(token, held / 2) returns (
                CurveMath.SellFill memory, CurveMath.FeeShares memory, uint16
            ) {
                StonkzLaunchpad.Coin memory c1 = pad.coinInfo(token);
                _sell(token, trader, held / 2);
                _assertSplit(token, c1);
            } catch {}
        }
    }

    /// @dev Holds the three per-coin fee ledgers to `splitFee` across one fill.
    function _assertSplit(address token, StonkzLaunchpad.Coin memory before_)
        internal
        view
        returns (uint256)
    {
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        uint256 dProtocol = c.protocolAccrued - before_.protocolAccrued;
        uint256 dOps = c.opsAccrued - before_.opsAccrued;
        uint256 dBucket = c.creatorBucketAccrued - before_.creatorBucketAccrued;
        uint256 fee = dProtocol + dOps + dBucket;

        CurveMath.FeeShares memory want = CurveMath.splitFee(fee);
        assertEq(dProtocol, want.protocol, "protocol is exactly 20%");
        assertEq(dOps, want.stonkzOps, "ops is exactly 10%");
        assertEq(dBucket, want.creatorBucket, "creator bucket is the remainder");
        assertEq(dProtocol + dOps + dBucket, fee, "the three reconstruct the fee");
        // The two floors can only ever lose to the bucket, never to the fee.
        assertLe(dProtocol * 10_000, fee * 2_000);
        assertLe(dOps * 10_000, fee * 1_000);
        return fee;
    }

    function test_MinOutIsEnforcedOnTheCurveHopAlone() public {
        address token = _launch("SLIP", 250, false);
        uint256 amount = FILL / 8;
        (CurveMath.BuyFill memory q,,) = pad.quoteBuy(token, amount);

        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        pad.buy(token, amount, q.tokensOut + 1);

        vm.prank(trader);
        uint256 got = pad.buy(token, amount, q.tokensOut);
        assertEq(got, q.tokensOut, "the quote is the fill");
    }

    function test_RoundTripNeverProfitsTheTrader() public {
        address token = _launch("RT", 250, false);
        uint256 spend = FILL / 2;
        uint256 before_ = base.balanceOf(trader);
        uint256 got = _buy(token, trader, spend);
        _sell(token, trader, got);
        assertLt(base.balanceOf(trader), before_, "a round trip must cost the trader");
    }

    /* ------------------------------------------------------- creator claim */

    function test_ClaimDrainsOnlyTheCreatorLedger() public {
        address token = _launch("CLAIM", 500, false);
        _buy(token, trader, FILL);

        uint256 protocolBefore = pad.protocolRevenue(address(base));
        uint256 opsBefore = pad.stonkzOps(address(base));
        uint256 creatorBefore = base.balanceOf(creator);

        vm.prank(creator);
        pad.claimCreatorFees(token);

        assertGt(base.balanceOf(creator), creatorBefore, "creator got paid");
        assertEq(pad.protocolRevenue(address(base)), protocolBefore, "protocol untouched");
        assertEq(pad.stonkzOps(address(base)), opsBefore, "ops untouched");

        vm.prank(creator);
        vm.expectRevert(bytes("nothing"));
        pad.claimCreatorFees(token);
    }

    function test_NonCreatorCannotClaim() public {
        address token = _launch("NOPE", 250, false);
        _buy(token, trader, FILL / 8);
        vm.prank(trader);
        vm.expectRevert(bytes("not creator"));
        pad.claimCreatorFees(token);
    }

    /* -------------------------------------------------------- 4.A cashback */

    function test_CashbackDecaysFrom50PctAndConvertsOnlyTheBucket() public {
        address token = _launch("CB", 100, true);

        // t=0: the effective fee is the 50% opening rate, not the creator's 1%.
        (,, uint16 bps0) = pad.quoteBuy(token, ONE);
        assertEq(bps0, 5_000, "cashback opens at 50%");

        uint256 p0 = pad.protocolRevenue(address(base));
        uint256 o0 = pad.stonkzOps(address(base));
        _buy(token, trader, FILL / 4);

        // The elevated fee still splits 20/10/70 — cashback changes the size of
        // the fee, never its division.
        uint256 dProtocol = pad.protocolRevenue(address(base)) - p0;
        uint256 dOps = pad.stonkzOps(address(base)) - o0;
        assertEq(dOps * 2, dProtocol, "ops is half of protocol at any fee level");

        // Protocol and ops stayed in the base token; only the bucket converted.
        assertGt(pad.coinInfo(token).creatorClaimableToken, 0, "the bucket came back as the token");

        // Halfway through: 1% + 49% * 150/300 = 2550 bps.
        vm.warp(block.timestamp + 150);
        (,, uint16 bpsMid) = pad.quoteBuy(token, ONE);
        assertEq(bpsMid, 2_550, "linear decay to the creator's own fee");

        // Past the window: the creator's own fee, forever.
        vm.warp(block.timestamp + 151);
        (,, uint16 bpsEnd) = pad.quoteBuy(token, ONE);
        assertEq(bpsEnd, 100, "settles at the creator fee");
        vm.warp(block.timestamp + 400 days);
        (,, uint16 bpsLater) = pad.quoteBuy(token, ONE);
        assertEq(bpsLater, 100, "and stays there");
    }

    function test_ANonCashbackCoinIsFlatFromTheFirstBlock() public {
        address token = _launch("FLAT", 300, false);
        (,, uint16 bps) = pad.quoteBuy(token, ONE);
        assertEq(bps, 300);
        assertEq(pad.coinInfo(token).creatorClaimableToken, 0, "no conversion without cashback");
    }

    function test_SellsInsideTheWindowAccrueInBaseNotTheToken() public {
        address token = _launch("CBS", 100, true);
        uint256 got = _buy(token, trader, FILL / 4);
        uint256 tokenBucketBefore = pad.coinInfo(token).creatorClaimableToken;

        _sell(token, trader, got / 2);
        // Converting a sell's bucket would be buy pressure the seller never
        // asked for, so it accrues in base.
        assertEq(
            pad.coinInfo(token).creatorClaimableToken,
            tokenBucketBefore,
            "a sell adds no token to the bucket"
        );
    }

    function test_NothingCanMoveCbStart() public {
        address token = _launch("CBFIX", 100, true);
        assertEq(pad.coinInfo(token).cbStart, uint64(block.timestamp));
        // No setter exists on any of the three privileged roles.
        (bool ok,) = address(pad).call(abi.encodeWithSignature("setCbStart(address,uint64)", token, 0));
        assertFalse(ok, "no instruction may extend the cashback window");
    }

    /* --------------------------------------------------------- 4.B staking */

    function test_FlexCarriesNoPoolWeightAndUnlocksImmediately() public {
        address token = _launch("FLEX", 250, false);
        uint256 got = _buy(token, staker, FILL);

        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        pad.stake(token, got / 2, 0);
        vm.stopPrank();

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.totalWeight, 0, "FLEX must carry zero pool weight");
        assertEq(c.eligibleStaked, 0, "and is excluded from poolFrac");
        assertEq(c.flexStaked, got / 2, "but it is escrowed");

        // A fill therefore routes the entire bucket to the creator.
        uint256 creatorBefore = c.creatorClaimableBase;
        _buy(token, trader, FILL / 4);
        StonkzLaunchpad.Coin memory c2 = pad.coinInfo(token);
        assertEq(c2.stakerAccruedBase, 0, "a FLEX-only pool accrues nothing");
        assertGt(c2.creatorClaimableBase, creatorBefore);

        // Zero-day term, so it leaves whenever.
        vm.prank(staker);
        pad.unstake(token, got / 2);
    }

    function test_LockHoldsToTheSecondAndOffGridTermsAreRefused() public {
        address token = _launch("LOCK", 250, false);
        uint256 got = _buy(token, staker, FILL);

        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        pad.stake(token, got / 4, 7);

        assertEq(pad.coinInfo(token).eligibleStaked, got / 4);
        assertEq(pad.coinInfo(token).totalWeight, (got / 4) * 12_500 / 10_000, "7D weighs 1.25x");

        vm.expectRevert(bytes("still locked"));
        pad.unstake(token, got / 4);

        vm.expectRevert(bytes("lock term"));
        pad.stake(token, 1, 3);

        vm.expectRevert(bytes("lock mismatch"));
        pad.stake(token, 1, 30);
        vm.stopPrank();

        // One second short is still locked; the boundary itself is open.
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(staker);
        vm.expectRevert(bytes("still locked"));
        pad.unstake(token, got / 4);

        vm.warp(block.timestamp + 1);
        vm.prank(staker);
        pad.unstake(token, got / 4);
    }

    function test_StakersDrawFromTheCreatorBucketOnlyCappedAtHalf() public {
        address token = _launch("POOL", 500, false);
        uint256 got = _buy(token, staker, FILL);

        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        // Stake the whole circulating float, which pins poolFrac at its cap.
        pad.stake(token, got, 30);
        vm.stopPrank();

        StonkzLaunchpad.Coin memory b0 = pad.coinInfo(token);

        _buy(token, trader, FILL / 2);

        StonkzLaunchpad.Coin memory b1 = pad.coinInfo(token);
        uint256 dProtocol = b1.protocolAccrued - b0.protocolAccrued;
        uint256 dOps = b1.opsAccrued - b0.opsAccrued;
        uint256 dCreator = b1.creatorClaimableBase - b0.creatorClaimableBase;
        uint256 dStakers = b1.stakerAccruedBase - b0.stakerAccruedBase;
        uint256 fee = dProtocol + dOps + dCreator + dStakers;
        CurveMath.FeeShares memory want = CurveMath.splitFee(fee);

        assertEq(dProtocol, want.protocol, "the peel does not touch protocol");
        assertEq(dOps, want.stonkzOps, "the peel does not touch ops");
        assertEq(dCreator + dStakers, want.creatorBucket, "stakers are paid from the 70% only");
        assertLe(dStakers, want.creatorBucket / 2, "capped at half the bucket");
        // Which is 35% of the fee at the cap, and never more.
        assertLe(dStakers * 100, fee * 35 + 100);

        // And it is really withdrawable, not just an accrual.
        uint256 held = base.balanceOf(staker);
        vm.prank(staker);
        pad.claimStake(token);
        assertGt(base.balanceOf(staker), held, "the staker can take it out");
    }

    /// Regression. At the Solana program's `ACC_PRECISION = 1e12` this pool
    /// resolved to zero: an 18-decimal float weighs ~1e27, so a 6-decimal base
    /// reward divided by it truncated away entirely and the staker earned
    /// nothing while the pool banked the whole share as dust. Silent, with no
    /// error raised anywhere, which is why it gets an explicit test.
    function testFuzz_AStakerAlwaysResolvesAFill(uint96 stakeSeed, uint8 termSeed) public {
        uint16[7] memory terms = [uint16(0), 1, 7, 30, 90, 180, 365];
        uint16 term = terms[1 + (uint256(termSeed) % 6)]; // skip FLEX: zero weight by design

        address token = _launch("ACC", 500, false);
        uint256 got = _buy(token, staker, FILL);
        // At least 1% of the float. A dust stake really is entitled to zero —
        // `poolFrac` is `staked / (2 * circulating)` and it floors — so pinning
        // the accrual above zero only means something for a real position.
        uint256 floor_ = got / 100;
        uint256 amount = floor_ + (uint256(stakeSeed) % (got - floor_));

        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        pad.stake(token, amount, term);
        vm.stopPrank();

        _buy(token, trader, FILL / 2);

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertGt(c.stakerAccruedBase, 0, "the pool was owed something");
        (uint256 pending,) = pad.pendingStakeRewards(token, staker);
        // The sole staker must be able to see essentially all of it. Some dust
        // is carried forward by design; losing the whole accrual is the bug.
        assertGt(pending * 100, c.stakerAccruedBase * 90, "the accrual must reach the staker");
        assertLe(pending, c.stakerAccruedBase, "and never exceed what was accrued");
    }

    function test_TwoCoinsDoNotShareAStakePool() public {
        address a = _launch("AAA", 250, false);
        address b = _launch("BBB", 250, false);

        uint256 gotA = _buy(a, staker, FILL);
        _buy(b, staker, FILL);

        vm.startPrank(staker);
        StonkzToken(a).approve(address(pad), type(uint256).max);
        StonkzToken(b).approve(address(pad), type(uint256).max);
        pad.stake(a, gotA, 30);
        vm.stopPrank();

        // Volume on B must not reach A's staker, who staked nothing on B.
        (uint256 pendingA0,) = pad.pendingStakeRewards(a, staker);
        _buy(b, trader, FILL / 2);
        (uint256 pendingA1,) = pad.pendingStakeRewards(a, staker);
        assertEq(pendingA1, pendingA0, "B's volume cannot reach A's pool");
        assertEq(pad.coinInfo(b).stakerAccruedBase, 0, "B has no eligible stake at all");

        // Volume on A does.
        _buy(a, trader, FILL / 2);
        (uint256 pendingA2,) = pad.pendingStakeRewards(a, staker);
        assertGt(pendingA2, pendingA1, "A's own volume pays A's staker");
    }

    /* ------------------------------------------------------ 4.C treasuries */

    function test_TreasuriesHaveNoUserFacingClaimPath() public {
        address token = _launch("TRE", 500, false);
        _buy(token, trader, FILL);
        assertGt(pad.protocolRevenue(address(base)), 0, "fills funded the treasury");

        // The two user-facing claim calls read different ledgers entirely.
        uint256 p = pad.protocolRevenue(address(base));
        uint256 o = pad.stonkzOps(address(base));
        vm.prank(creator);
        pad.claimCreatorFees(token);
        assertEq(pad.protocolRevenue(address(base)), p);
        assertEq(pad.stonkzOps(address(base)), o);

        // And nothing but the cold key can reach them.
        vm.prank(trader);
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(0, address(base), 1, trader);
        vm.prank(admin);
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(0, address(base), 1, admin);
    }

    function test_OnlyTheMatchingColdKeyWithdrawsAndOnlyWhenUnpaused() public {
        address token = _launch("WD", 500, false);
        _buy(token, trader, FILL);

        // The ops key cannot reach protocol money, and vice versa.
        vm.prank(opsCold);
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(0, address(base), 1, opsCold);
        vm.prank(protocolCold);
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(1, address(base), 1, protocolCold);

        vm.prank(protocolCold);
        pad.withdrawTreasury(0, address(base), 1000, protocolCold);
        assertEq(base.balanceOf(protocolCold), 1000);

        // Ops withdrawals can be frozen without touching protocol or trading.
        vm.prank(admin);
        pad.setPause(false, false, false, true, false);
        vm.prank(opsCold);
        vm.expectRevert(bytes("withdrawals paused"));
        pad.withdrawTreasury(1, address(base), 1, opsCold);

        _buy(token, trader, ONE);
        vm.prank(protocolCold);
        pad.withdrawTreasury(0, address(base), 1, protocolCold);

        vm.prank(admin);
        pad.setPause(false, false, false, false, false);
        vm.prank(opsCold);
        pad.withdrawTreasury(1, address(base), 500, opsCold);
        assertEq(base.balanceOf(opsCold), 500);
    }

    function test_TradingPauseHaltsFillsWithoutTouchingClaims() public {
        address token = _launch("PAUSE", 250, false);
        _buy(token, trader, FILL / 2);

        vm.prank(admin);
        pad.setPause(true, false, false, false, false);

        vm.prank(trader);
        vm.expectRevert(bytes("trading paused"));
        pad.buy(token, 1_000, 0);

        // Money already earned stays reachable.
        vm.prank(creator);
        pad.claimCreatorFees(token);
    }

    function test_AdminHandoverIsTwoStep() public {
        address next = address(0xBEEF);
        vm.prank(admin);
        pad.proposeAdmin(next);
        assertEq(pad.admin(), admin, "proposing does not transfer");

        vm.prank(trader);
        vm.expectRevert(bytes("not pending"));
        pad.acceptAdmin();

        vm.prank(next);
        pad.acceptAdmin();
        assertEq(pad.admin(), next);
    }

    /* --------------------------------------------------------- graduation */

    function test_ExhaustionGraduatesEvenWithADeadOracle() public {
        address token = _launch("GRAD", 250, false);
        _exhaust(token);

        // A second coin, mid-curve, with the same dead oracle: it cannot use
        // the price trigger, which is exactly the point — the oracle trigger is
        // the one that can be lost, and losing it must not strand a coin whose
        // curve is already finished.
        address midCurve = _launch("MID", 250, false);
        _buy(midCurve, trader, ONE);

        vm.warp(block.timestamp + 400_000);
        vm.expectRevert(bytes("stale oracle"));
        pad.graduate(midCurve);

        pad.graduate(token);
        assertTrue(pad.coinInfo(token).graduated, "an exhausted curve graduates regardless");
        assertEq(pad.coinInfo(token).graduationReason, 0, "exhaustion, not price");
    }

    function test_RefusesToGraduateACurveBelowBothTriggers() public {
        address token = _launch("EARLY", 250, false);
        _buy(token, trader, ONE);
        vm.expectRevert(bytes("not graduable"));
        pad.graduate(token);
    }

    function test_TradingStopsOnceTheCurveIsComplete() public {
        address token = _launch("DONE", 250, false);
        _exhaust(token);
        vm.prank(trader);
        vm.expectRevert(bytes("curve complete"));
        pad.buy(token, 1_000, 0);
    }

    function test_ExhaustedCurveClosesAt69k() public {
        address token = _launch("K69", 250, false);
        _exhaust(token);
        (, uint256 usd) = pad.marketCap(token);
        // Within a part per million of $69,000.
        assertApproxEqRel(usd, CurveMath.GRAD_MCAP_USD_1E6, 1e12, "closes at $69,000");
    }

    /// Drive the curve to zero sellable reserve.
    function _exhaust(address token) internal {
        for (uint256 i = 0; i < 40; i++) {
            if (pad.coinInfo(token).realToken == 0) break;
            uint256 amount = 2_000 * ONE;
            base.mint(trader, amount);
            (CurveMath.BuyFill memory q,,) = pad.quoteBuy(token, amount);
            if (q.tokensOut == 0) break;
            _buy(token, trader, amount);
        }
        assertEq(pad.coinInfo(token).realToken, 0, "the script must exhaust the curve");
    }

}
