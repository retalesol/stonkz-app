// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title The Stonkz curve, fee split and staking arithmetic.
/// @notice A mirror of `programs/solana/programs/launchpad/src/math.rs`, held to
/// the same table (`programs/parity-vectors.json`) by `test/Parity.t.sol`.
/// Every rounding direction here is deliberate and matches the Rust; see
/// `programs/SPEC.md` §1 and §2 before changing any of it.
///
/// Amounts are `uint256` rather than Solana's `uint64`, so this side accepts
/// curve shapes Solana rejects — notably cheap 18-decimal base tokens, which
/// matters because Robinhood Chain's gas token and stock tokens are both
/// 18-decimal.
library CurveMath {
    uint256 internal constant BPS_DEN = 10_000;

    uint256 internal constant FEE_PROTOCOL_BPS = 2_000;
    uint256 internal constant FEE_OPS_BPS = 1_000;

    uint16 internal constant MIN_FEE_BPS = 100;
    uint16 internal constant MAX_FEE_BPS = 500;

    uint256 internal constant TOKENS_FOR_SALE_NUM = 4;
    uint256 internal constant TOKENS_FOR_SALE_DEN = 5;
    uint256 internal constant VIRTUAL_TOKEN_NUM = 16;
    uint256 internal constant VIRTUAL_TOKEN_DEN = 15;
    uint256 internal constant VIRTUAL_BASE_DEN = 15;

    /// $69,000, scaled 1e6.
    uint256 internal constant GRAD_MCAP_USD_1E6 = 69_000_000_000;

    uint256 internal constant CB_WINDOW_SECS = 300;
    uint256 internal constant CB_START_FEE_BPS = 5_000;

    uint256 internal constant ACC_PRECISION = 1e12;

    struct FeeShares {
        uint256 protocol;
        uint256 stonkzOps;
        uint256 creatorBucket;
    }

    struct CurveParams {
        uint256 tokensForSale;
        uint256 lpReserve;
        uint256 virtualToken;
        uint256 virtualBase;
        uint256 k;
        uint256 gradMcapBase;
    }

    struct State {
        uint256 virtualBase;
        uint256 virtualToken;
        uint256 realBase;
        uint256 realToken;
        uint256 k;
    }

    struct BuyFill {
        uint256 grossBase;
        uint256 fee;
        uint256 netBase;
        uint256 tokensOut;
        bool curveComplete;
    }

    struct SellFill {
        uint256 grossBase;
        uint256 fee;
        uint256 netBase;
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b != 0, "div0");
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /* ------------------------------------------------------------ fee split */

    /// @notice 20% protocol, 10% ops, remainder to the creator bucket.
    /// @dev The bucket is the remainder rather than a third floor, which is
    /// exactly why the three shares reconstruct the fee for every input. At
    /// most 2 wei of floor dust lands in the bucket; none is ever lost.
    function splitFee(uint256 fee) internal pure returns (FeeShares memory s) {
        s.protocol = (fee * FEE_PROTOCOL_BPS) / BPS_DEN;
        s.stonkzOps = (fee * FEE_OPS_BPS) / BPS_DEN;
        s.creatorBucket = fee - s.protocol - s.stonkzOps;
    }

    /// @notice Split the creator bucket between the creator and that token's stakers.
    /// @dev Runs after `splitFee`, on the bucket alone. Protocol and ops have
    /// already been routed elsewhere and are structurally unable to reach here.
    /// `eligibleStaked` excludes zero-weight FLEX positions.
    function splitCreatorBucket(uint256 bucket, uint256 eligibleStaked, uint256 circulatingSupply)
        internal
        pure
        returns (uint256 creator, uint256 stakers)
    {
        if (bucket == 0 || eligibleStaked == 0 || circulatingSupply == 0) return (bucket, 0);
        uint256 half = bucket / 2;
        stakers = (bucket * eligibleStaked) / (circulatingSupply * 2);
        if (stakers > half) stakers = half;
        creator = bucket - stakers;
    }

    /* -------------------------------------------------------------- cashback */

    /// @notice Effective fee in bps, decaying 5000 -> baseBps over 300 seconds.
    /// @dev `block.timestamp` on an Arbitrum Orbit chain is the sequencer clock:
    /// close to wall clock, loose over single seconds. A 300-second window is
    /// far longer than that looseness, so the decay is safe here — but nothing
    /// with a sub-minute deadline should rely on this clock.
    function effFeeBps(uint16 baseBps, bool cashback, uint256 cbStart, uint256 nowSecs)
        internal
        pure
        returns (uint16)
    {
        if (!cashback) return baseBps;
        uint256 end = cbStart + CB_WINDOW_SECS;
        if (nowSecs >= end) return baseBps;
        uint256 remaining = end - nowSecs;
        if (remaining > CB_WINDOW_SECS) remaining = CB_WINDOW_SECS;
        uint256 base = baseBps;
        // Safe: `base <= MAX_FEE_BPS` and the added term is at most
        // `CB_START_FEE_BPS - base`, so the sum never exceeds 5000.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(base + ((CB_START_FEE_BPS - base) * remaining) / CB_WINDOW_SECS);
    }

    /* ----------------------------------------------------------- parameters */

    function gradMcapBaseAtoms(uint256 price1e6, uint8 baseDecimals) internal pure returns (uint256) {
        require(price1e6 > 0, "price");
        require(baseDecimals <= 18, "decimals");
        return (GRAD_MCAP_USD_1E6 * (10 ** uint256(baseDecimals))) / price1e6;
    }

    /// @notice Derive the curve shape. See SPEC.md §1 for why these constants
    /// put graduation at exactly $69,000 with the pool opening at the curve's
    /// closing price.
    function deriveCurve(uint256 supplyAtoms, uint256 price1e6, uint8 baseDecimals)
        internal
        pure
        returns (CurveParams memory p)
    {
        require(supplyAtoms > 0, "supply");
        p.tokensForSale = (supplyAtoms * TOKENS_FOR_SALE_NUM) / TOKENS_FOR_SALE_DEN;
        p.lpReserve = supplyAtoms - p.tokensForSale;
        p.virtualToken = (supplyAtoms * VIRTUAL_TOKEN_NUM) / VIRTUAL_TOKEN_DEN;
        require(p.virtualToken > p.tokensForSale, "shape");

        p.gradMcapBase = gradMcapBaseAtoms(price1e6, baseDecimals);
        // Ceil, matching Rust: graduation mcap is 15x this, so the residue has
        // to land above target rather than below it.
        p.virtualBase = ceilDiv(p.gradMcapBase, VIRTUAL_BASE_DEN);
        require(p.virtualBase > 0, "vb");
        p.k = p.virtualBase * p.virtualToken;
    }

    /* ---------------------------------------------------------------- fills */

    /// @notice Buy against the curve, capping rather than reverting when the
    /// order exceeds the remaining allocation.
    function buyQuote(State memory st, uint16 feeBps, uint256 amountBase)
        internal
        pure
        returns (BuyFill memory f)
    {
        require(amountBase > 0, "amount");
        require(st.realToken > 0, "complete");
        require(feeBps < BPS_DEN, "fee");

        uint256 fee = (amountBase * feeBps) / BPS_DEN;
        uint256 net = amountBase - fee;
        require(net > 0, "dust");

        uint256 newVt = ceilDiv(st.k, st.virtualBase + net);
        uint256 tokensOut = st.virtualToken - newVt;

        if (tokensOut <= st.realToken) {
            return BuyFill(amountBase, fee, net, tokensOut, tokensOut == st.realToken);
        }

        // Capped: solve for the base that takes exactly the rest of the curve,
        // then gross it back up so the fee still leaves that much in the pool.
        uint256 capped = st.realToken;
        uint256 vtAfter = st.virtualToken - capped;
        require(vtAfter > 0, "drain");
        uint256 netNeeded = ceilDiv(st.k, vtAfter) - st.virtualBase;
        require(netNeeded > 0, "noop");
        uint256 gross = ceilDiv(netNeeded * BPS_DEN, BPS_DEN - feeBps);
        return BuyFill(gross, gross - netNeeded, netNeeded, capped, true);
    }

    function sellQuote(State memory st, uint16 feeBps, uint256 amountToken)
        internal
        pure
        returns (SellFill memory)
    {
        require(amountToken > 0, "amount");
        require(feeBps < BPS_DEN, "fee");

        uint256 newVb = ceilDiv(st.k, st.virtualToken + amountToken);
        uint256 gross = st.virtualBase - newVb;
        if (gross > st.realBase) gross = st.realBase;
        require(gross > 0, "dust");

        uint256 fee = (gross * feeBps) / BPS_DEN;
        return SellFill(gross, fee, gross - fee);
    }

    /// @notice The zero-fee cashback swap. Returns 0 when the remaining
    /// allocation cannot cover it, so the caller falls back to accruing in base
    /// rather than partially filling.
    function zeroFeeBuy(State memory st, uint256 amountBase) internal pure returns (uint256) {
        if (amountBase == 0 || st.realToken == 0) return 0;
        uint256 out = st.virtualToken - ceilDiv(st.k, st.virtualBase + amountBase);
        if (out == 0 || out > st.realToken) return 0;
        return out;
    }

    /* ------------------------------------------------------------ valuation */

    function mcapBase(State memory st, uint256 supplyAtoms) internal pure returns (uint256) {
        return (st.virtualBase * supplyAtoms) / st.virtualToken;
    }

    function mcapUsd1e6(uint256 mcap, uint256 price1e6, uint8 baseDecimals)
        internal
        pure
        returns (uint256)
    {
        return (mcap * price1e6) / (10 ** uint256(baseDecimals));
    }

    function circulating(uint256 tokensForSale, uint256 realToken) internal pure returns (uint256) {
        return tokensForSale > realToken ? tokensForSale - realToken : 0;
    }

    /* -------------------------------------------------------------- staking */

    /// @notice Pool weight in bps for a lock term, or reverts on an off-grid term.
    /// @dev FLEX (0 days) is zero: it escrows but earns nothing. Anti-wash.
    function lockWeightBps(uint16 lockDays) internal pure returns (uint256) {
        if (lockDays == 0) return 0;
        if (lockDays == 1) return 11_000;
        if (lockDays == 7) return 12_500;
        if (lockDays == 30) return 15_000;
        if (lockDays == 90) return 25_000;
        if (lockDays == 180) return 50_000;
        if (lockDays == 365) return 80_000;
        revert("lock term");
    }

    function stakeWeight(uint256 amount, uint16 lockDays) internal pure returns (uint256) {
        return (amount * lockWeightBps(lockDays)) / BPS_DEN;
    }

    function pendingReward(uint256 weight, uint256 acc, uint256 debt) internal pure returns (uint256) {
        return (weight * (acc - debt)) / ACC_PRECISION;
    }

    /// @notice Advance a reward accumulator, returning the new value and the
    /// dust the caller must carry into the next accrual.
    /// @dev The commitment rounds **up**. A staker claims
    /// `floor(weight * sum(steps) / ACC)`, and the floor of a sum can exceed the
    /// sum of floors by one unit per step — committing the floored amount would
    /// let the pool promise more than it holds. Same fix as the Rust side.
    function advanceAcc(uint256 acc, uint256 amount, uint256 totalWeight)
        internal
        pure
        returns (uint256 newAcc, uint256 dust)
    {
        if (totalWeight == 0 || amount == 0) return (acc, amount);
        uint256 perWeight = (amount * ACC_PRECISION) / totalWeight;
        if (perWeight == 0) return (acc, amount);
        uint256 committed = ceilDiv(perWeight * totalWeight, ACC_PRECISION);
        dust = amount > committed ? amount - committed : 0;
        newAcc = acc + perWeight;
    }
}
