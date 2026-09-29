// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {FullMath} from "./FullMath.sol";
import {TickMath} from "./TickMath.sol";

/// @notice The slice of `IUniswapV3Pool` a TWAP reader needs.
interface IUniswapV3PoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

/// @title Uniswap v3-periphery `OracleLibrary.consult` / `getQuoteAtTick`,
/// ported to Solidity 0.8.
/// @notice The 0.7 original relies on wrapping `int56`/`uint160` subtraction
/// for the cumulative deltas; those are `unchecked` here. `consult` takes the
/// already-observed cumulatives so the caller owns the (reverting) `observe`
/// call and can wrap it in `try`.
library V3Oracle {
    /// @return arithmeticMeanTick Time-weighted mean tick over `secondsAgo`,
    ///         rounded toward negative infinity (as Uniswap does).
    /// @return harmonicMeanLiquidity Time-weighted harmonic mean of in-range
    ///         liquidity over the same window. A stretch with no in-range
    ///         liquidity counts as liquidity 1, so an empty spell anywhere in
    ///         the window drags this toward zero.
    function consult(
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityX128s,
        uint32 secondsAgo
    ) internal pure returns (int24 arithmeticMeanTick, uint128 harmonicMeanLiquidity) {
        require(secondsAgo != 0, "BP");
        unchecked {
            int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
            uint160 secondsPerLiquidityDelta = secondsPerLiquidityX128s[1] - secondsPerLiquidityX128s[0];

            int56 window = int56(uint56(secondsAgo));
            // forge-lint: disable-next-line(unsafe-typecast)
            arithmeticMeanTick = int24(tickCumulativesDelta / window);
            if (tickCumulativesDelta < 0 && (tickCumulativesDelta % window != 0)) arithmeticMeanTick--;

            // Uniswap: (secondsAgo * 2^160 - 1) / (delta << 32). `delta` is zero
            // only for a window with (impossibly) infinite liquidity; report 0.
            if (secondsPerLiquidityDelta == 0) return (arithmeticMeanTick, 0);
            uint192 secondsAgoX160 = uint192(secondsAgo) * type(uint160).max;
            uint256 hml = secondsAgoX160 / (uint256(secondsPerLiquidityDelta) << 32);
            // forge-lint: disable-next-line(unsafe-typecast)
            harmonicMeanLiquidity = hml > type(uint128).max ? type(uint128).max : uint128(hml);
        }
    }

    /// @return quoteAmount `baseAmount` of `baseToken`, in `quoteToken` atoms,
    ///         at `tick` (the price of token0 in token1 is 1.0001^tick).
    function getQuoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        // Square in 256 bits when that cannot overflow, else lose 64 bits of
        // precision to stay in range.
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }
}
