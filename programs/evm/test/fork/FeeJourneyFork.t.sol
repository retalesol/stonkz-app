// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {CurveMath} from "../../src/CurveMath.sol";
import {StonkzLaunchpad} from "../../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../../src/StonkzToken.sol";

interface IWETHLike {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice The whole fee journey against a **live** coin on a fork: the split
/// on a buy and a sell, the creator's claim, a locked staker's accrual and
/// claim, FLEX earning nothing, and the lock being held to the second. Runs
/// against MEMEMAN on Base Sepolia by default; skipped unless `FEE_FORK_RPC`
/// is set, e.g.
///
/// ```
/// FEE_FORK_RPC=https://sepolia.base.org \
///   forge test --match-path test/fork/FeeJourneyFork.t.sol -vv
/// ```
///
/// Nothing here broadcasts. The creator key is never used: `vm.prank` stands
/// in for it on the fork only.
contract FeeJourneyForkTest is Test {
    address constant BASE_PROXY = 0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35;
    address constant MEMEMAN = 0x847eb6311333f8F7F2cd0E9A89379214302aB2c9;

    StonkzLaunchpad pad;
    address token;
    address weth;
    address creator;
    address staker = address(0x57A4E5);
    address trader = address(0x7A4DE5);

    function _setUp() internal returns (bool ready) {
        string memory rpc = vm.envOr("FEE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        pad = StonkzLaunchpad(vm.envOr("FEE_FORK_PROXY", BASE_PROXY));
        token = vm.envOr("FEE_FORK_TOKEN", MEMEMAN);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        require(c.token == token, "fork: unknown token");
        require(!c.graduated && !c.complete, "fork: coin is off the curve");
        weth = c.baseToken;
        creator = c.creator;
        return true;
    }

    function _fund(address who, uint256 amount) internal {
        vm.deal(who, amount);
        vm.startPrank(who);
        IWETHLike(weth).deposit{value: amount}();
        IWETHLike(weth).approve(address(pad), type(uint256).max);
        vm.stopPrank();
    }

    function _buy(address who, uint256 amount) internal returns (uint256 got, uint256 fee) {
        (CurveMath.BuyFill memory q,,) = pad.quoteBuy(token, amount);
        vm.prank(who);
        got = pad.buy(token, amount, q.tokensOut);
        fee = q.fee;
    }

    struct Vaults {
        uint256 protocol;
        uint256 ops;
        uint256 burn;
        uint256 held;
    }

    function _vaults() internal view returns (Vaults memory v) {
        v.protocol = pad.protocolRevenue(weth);
        v.ops = pad.stonkzOps(weth);
        v.burn = pad.stonkzBurn(weth);
        v.held = IWETHLike(weth).balanceOf(address(pad));
    }

    /// One fill's deltas across the three treasuries, the coin's four accrual
    /// ledgers and the creator/staker peel must be exactly `splitFee(fee)`.
    function _assertFillSplit(
        StonkzLaunchpad.Coin memory c0,
        Vaults memory v0,
        uint256 fee
    ) internal view {
        StonkzLaunchpad.Coin memory c1 = pad.coinInfo(token);
        Vaults memory v1 = _vaults();
        CurveMath.FeeShares memory want = CurveMath.splitFee(fee);

        assertEq(v1.protocol - v0.protocol, want.protocol, "protocol vault +15%");
        assertEq(v1.ops - v0.ops, want.stonkzOps, "buyback vault +10%");
        assertEq(v1.burn - v0.burn, want.burn, "RWA vault +6%");
        assertEq(c1.protocolAccrued - c0.protocolAccrued, want.protocol, "protocolAccrued");
        assertEq(c1.opsAccrued - c0.opsAccrued, want.stonkzOps, "opsAccrued");
        assertEq(c1.burnAccrued - c0.burnAccrued, want.burn, "burnAccrued");
        assertEq(c1.creatorBucketAccrued - c0.creatorBucketAccrued, want.creatorBucket, "bucket 69%");
        assertEq(c1.bucketBase - c0.bucketBase, want.creatorBucket, "bucket ledger");
        uint256 dCreator = c1.creatorClaimableBase - c0.creatorClaimableBase;
        uint256 dStakers = c1.stakerAccruedBase - c0.stakerAccruedBase;
        assertEq(dCreator + dStakers, want.creatorBucket, "creator + stakers = bucket");
        assertLe(dStakers, want.creatorBucket / 2, "stakers capped at half");
        assertEq(want.protocol + want.stonkzOps + want.burn + want.creatorBucket, fee, "identity");
    }

    /* ------------------------------------------------------------ link 1 */

    function test_Fork_SplitOnBuyAndSellIsExactToTheWei() public {
        if (!_setUp()) return vm.skip(true);
        _fund(trader, 1 ether);

        StonkzLaunchpad.Coin memory c0 = pad.coinInfo(token);
        Vaults memory v0 = _vaults();
        (uint256 got, uint256 fee) = _buy(trader, 0.05 ether);
        assertGt(got, 0, "bought");
        _assertFillSplit(c0, v0, fee);
        // The gross stays in the contract: the split is bookkeeping, not a transfer out.
        assertEq(_vaults().held - v0.held, 0.05 ether, "gross pulled once");

        // Sell half back. The sell fee comes off the pool's base.
        vm.startPrank(trader);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        (CurveMath.SellFill memory sq,,) = pad.quoteSell(token, got / 2);
        StonkzLaunchpad.Coin memory c1 = pad.coinInfo(token);
        Vaults memory v1 = _vaults();
        uint256 out = pad.sell(token, got / 2, sq.netBase);
        vm.stopPrank();
        assertEq(out, sq.netBase, "sell paid the quote");
        _assertFillSplit(c1, v1, sq.fee);
    }

    /// The live coin's lifetime ledgers are an exact v2 split of everything it
    /// has ever taken (floors can only shave a leg by < 1 wei per fill).
    function test_Fork_LifetimeLedgersAreAV2Split() public {
        if (!_setUp()) return vm.skip(true);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        uint256 total = c.protocolAccrued + c.opsAccrued + c.burnAccrued + c.creatorBucketAccrued;
        assertGt(total, 0, "the coin has taken fees");
        assertLe(c.protocolAccrued * 10_000, total * 1_500, "protocol <= 15%");
        assertLe(c.opsAccrued * 10_000, total * 1_000, "buyback <= 10%");
        assertLe(c.burnAccrued * 10_000, total * 600, "RWA <= 6%");
        assertGe(c.creatorBucketAccrued * 10_000, total * 6_900, "bucket >= 69%");
        // A single v1 fill (20/10/10/60) in the history would push protocol
        // above 15% of the total; none has.
        // The bucket ledger always covers the creator's claimable balance, and
        // the contract really holds the bucket plus the three treasuries.
        assertGe(c.bucketBase, c.creatorClaimableBase, "bucket covers the creator");
        Vaults memory v = _vaults();
        assertGe(
            v.held, v.protocol + v.ops + v.burn + c.bucketBase + c.realBase, "WETH backs every ledger"
        );
    }

    /* ------------------------------------------------------------ link 3 */

    function test_Fork_CreatorClaimPaysExactlyTheLedger() public {
        if (!_setUp()) return vm.skip(true);
        StonkzLaunchpad.Coin memory c0 = pad.coinInfo(token);
        Vaults memory v0 = _vaults();
        uint256 owed = c0.creatorClaimableBase;
        assertGt(owed, 0, "MEMEMAN's creator has fees to claim");

        uint256 before = IWETHLike(weth).balanceOf(creator);
        vm.expectEmit(true, true, false, true, address(pad));
        emit StonkzLaunchpad.CreatorFeesClaimed(token, creator, owed, c0.creatorClaimableToken);
        vm.prank(creator);
        pad.claimCreatorFees(token);

        assertEq(IWETHLike(weth).balanceOf(creator) - before, owed, "paid to the wei");
        StonkzLaunchpad.Coin memory c1 = pad.coinInfo(token);
        assertEq(c1.creatorClaimableBase, 0, "ledger drained");
        assertEq(c1.bucketBase, c0.bucketBase - owed, "bucket reduced by the claim only");
        Vaults memory v1 = _vaults();
        assertEq(v1.protocol, v0.protocol, "protocol untouched");
        assertEq(v1.ops, v0.ops, "buyback untouched");
        assertEq(v1.burn, v0.burn, "RWA untouched");
        assertEq(c1.stakerAccruedBase, c0.stakerAccruedBase, "staker share untouched");

        vm.prank(creator);
        vm.expectRevert(bytes("nothing"));
        pad.claimCreatorFees(token);

        vm.prank(trader);
        vm.expectRevert(bytes("not creator"));
        pad.claimCreatorFees(token);
    }

    /* ------------------------------------------------------------ link 4 */

    function test_Fork_LockedStakeEarnsFlexDoesNotAndLockHolds() public {
        if (!_setUp()) return vm.skip(true);
        _fund(staker, 1 ether);
        _fund(trader, 1 ether);

        // The live FLEX position (the creator's) has zero weight and zero pending.
        StonkzLaunchpad.Position memory flex = pad.positionInfo(token, creator);
        if (flex.amount > 0) {
            assertEq(flex.lockDays, 0, "live position is FLEX");
            assertEq(flex.weight, 0, "FLEX carries no weight");
        }
        (uint256 flexPending0,) = pad.pendingStakeRewards(token, creator);
        assertEq(flexPending0, 0, "FLEX has earned nothing");

        (uint256 got,) = _buy(staker, 0.1 ether);
        vm.startPrank(staker);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        pad.stake(token, got, 30);
        vm.stopPrank();

        StonkzLaunchpad.Coin memory c0 = pad.coinInfo(token);
        assertEq(c0.eligibleStaked, got, "only the locked stake is eligible");
        assertEq(c0.totalWeight, (got * 15_000) / 10_000, "30d weight is 1.5x");
        StonkzLaunchpad.Position memory p = pad.positionInfo(token, staker);
        assertEq(p.lockUntil, block.timestamp + 30 days, "lock stamped");

        // A fill: stakers take bucket * eligible / (2 * circulating), capped at half.
        (CurveMath.BuyFill memory q,,) = pad.quoteBuy(token, 0.05 ether);
        CurveMath.FeeShares memory s = CurveMath.splitFee(q.fee);
        uint256 circAfter = CurveMath.circulating(c0.tokensForSale, c0.realToken - q.tokensOut);
        (uint256 wantCreator, uint256 wantStakers) =
            CurveMath.splitCreatorBucket(s.creatorBucket, c0.eligibleStaked, circAfter);
        assertGt(wantStakers, 0, "a real position is owed something");
        _buy(trader, 0.05 ether);

        StonkzLaunchpad.Coin memory c1 = pad.coinInfo(token);
        assertEq(c1.stakerAccruedBase - c0.stakerAccruedBase, wantStakers, "staker peel");
        assertEq(c1.creatorClaimableBase - c0.creatorClaimableBase, wantCreator, "creator rest");

        (uint256 pending,) = pad.pendingStakeRewards(token, staker);
        assertGt(pending * 100, wantStakers * 90, "the sole staker sees the accrual");
        assertLe(pending, wantStakers, "never more than accrued");
        (uint256 flexPending1,) = pad.pendingStakeRewards(token, creator);
        assertEq(flexPending1, 0, "FLEX still earns nothing");

        // Unstake before the lock is refused to the second.
        vm.prank(staker);
        vm.expectRevert(bytes("still locked"));
        pad.unstake(token, got);

        // Claim pays exactly the pending amount and resets the position.
        uint256 before = IWETHLike(weth).balanceOf(staker);
        vm.expectEmit(true, true, false, true, address(pad));
        emit StonkzLaunchpad.StakeClaimed(token, staker, pending, 0);
        vm.prank(staker);
        pad.claimStake(token);
        assertEq(IWETHLike(weth).balanceOf(staker) - before, pending, "claim paid to the wei");
        (uint256 after_,) = pad.pendingStakeRewards(token, staker);
        assertEq(after_, 0, "position rewards reset");
        assertEq(pad.coinInfo(token).bucketBase, c1.bucketBase - pending, "bucket reduced by the claim");

        vm.prank(staker);
        vm.expectRevert(bytes("nothing"));
        pad.claimStake(token);

        // Past the lock the whole position comes back.
        vm.warp(p.lockUntil);
        uint256 held = StonkzToken(token).balanceOf(staker);
        vm.prank(staker);
        pad.unstake(token, got);
        assertEq(StonkzToken(token).balanceOf(staker) - held, got, "unstaked in full");
        assertEq(pad.coinInfo(token).eligibleStaked, 0, "pool empty again");
    }
}
