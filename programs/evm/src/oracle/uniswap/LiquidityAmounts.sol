// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FullMath} from "./FullMath.sol";

/// @title Liquidity <-> token amounts for a Uniswap v3 range.
/// @notice Two halves of Uniswap's own arithmetic, so a caller can size a
/// `mint` it can pay for exactly:
/// - `getLiquidityForAmounts` is v3-periphery `LiquidityAmounts` (rounds
///   liquidity **down**), the number to ask the pool for;
/// - `getAmountsForLiquidityUp` is what the pool then charges for it —
///   v3-core `SqrtPriceMath.getAmount0Delta/getAmount1Delta` with
///   `roundUp = true`, as `Pool._modifyPosition` calls them on a mint.
/// Because the two round in opposite directions the charge can exceed the
/// amount the liquidity was sized from by a wei or two; a caller that holds
/// exactly the sized amounts checks with the second and shaves.
library LiquidityAmounts {
    uint256 internal constant Q96 = 1 << 96;

    function mulDivRoundingUp(uint256 a, uint256 b, uint256 denominator)
        internal
        pure
        returns (uint256 result)
    {
        result = FullMath.mulDiv(a, b, denominator);
        if (mulmod(a, b, denominator) > 0) {
            require(result < type(uint256).max);
            result++;
        }
    }

    function divRoundingUp(uint256 x, uint256 y) internal pure returns (uint256) {
        return x / y + (x % y > 0 ? 1 : 0);
    }

    /* ------------------------------------------------------- amounts -> L */

    function getLiquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0)
        internal
        pure
        returns (uint256)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = FullMath.mulDiv(sqrtA, sqrtB, Q96);
        return FullMath.mulDiv(amount0, intermediate, sqrtB - sqrtA);
    }

    function getLiquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1)
        internal
        pure
        returns (uint256)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return FullMath.mulDiv(amount1, Q96, sqrtB - sqrtA);
    }

    /// @dev v3-periphery `LiquidityAmounts.getLiquidityForAmounts`, saturating
    /// at `uint128` instead of truncating.
    function getLiquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 l;
        if (sqrtP <= sqrtA) {
            l = getLiquidityForAmount0(sqrtA, sqrtB, amount0);
        } else if (sqrtP < sqrtB) {
            uint256 l0 = getLiquidityForAmount0(sqrtP, sqrtB, amount0);
            uint256 l1 = getLiquidityForAmount1(sqrtA, sqrtP, amount1);
            l = l0 < l1 ? l0 : l1;
        } else {
            l = getLiquidityForAmount1(sqrtA, sqrtB, amount1);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    /* ------------------------------------------------------- L -> amounts */

    /// @dev v3-core `SqrtPriceMath.getAmount0Delta(…, roundUp = true)`.
    function getAmount0ForLiquidityUp(uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = sqrtB - sqrtA;
        require(sqrtA > 0);
        return divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA);
    }

    /// @dev v3-core `SqrtPriceMath.getAmount1Delta(…, roundUp = true)`.
    function getAmount1ForLiquidityUp(uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return mulDivRoundingUp(liquidity, sqrtB - sqrtA, Q96);
    }

    /// @notice What `Pool.mint(…, liquidity)` will ask the callback to pay at
    /// price `sqrtP` for the range `[sqrtA, sqrtB]`.
    function getAmountsForLiquidityUp(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) {
            amount0 = getAmount0ForLiquidityUp(sqrtA, sqrtB, liquidity);
        } else if (sqrtP < sqrtB) {
            amount0 = getAmount0ForLiquidityUp(sqrtP, sqrtB, liquidity);
            amount1 = getAmount1ForLiquidityUp(sqrtA, sqrtP, liquidity);
        } else {
            amount1 = getAmount1ForLiquidityUp(sqrtA, sqrtB, liquidity);
        }
    }
}
