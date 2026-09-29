// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {FullMath} from "../oracle/uniswap/FullMath.sol";
import {TickMath} from "../oracle/uniswap/TickMath.sol";

interface IERC20Seeder {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IUniswapV3PoolSeeder {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title Operator helper: seed an **empty** Uniswap V3 pool at a reference
/// price with a full-range position, where no NFPM is deployed (RH 46630).
/// @notice Two steps, each callable on its own:
/// - `reprice`: move an empty pool's price to a target for free. A pool with
///   no liquidity anywhere on the path swaps nothing, so a swap with a price
///   limit just walks the price there. If any liquidity is crossed, something
///   would be owed and the callback reverts instead of paying.
/// - `mintFullRange`: the most liquidity `amount0Max`/`amount1Max` buy at the
///   pool's current price, full range for its tick spacing, owned by
///   `recipient` (who can later `burn`/`collect` on the pool directly).
///
/// The seeder never holds funds or standing approvals it can use: the mint
/// callback only pays the pool this call is minting on, only from the caller
/// of that mint, and only up to the caller's stated maxima.
contract V3PoolSeeder {
    uint256 private constant Q96 = 1 << 96;

    address private _pool;
    address private _payer;
    uint256 private _max0;
    uint256 private _max1;

    error PoolNotEmpty();

    /// @notice Move an empty pool to `targetSqrtPriceX96`. No-op if already there.
    function reprice(address pool, uint160 targetSqrtPriceX96) external {
        IUniswapV3PoolSeeder p = IUniswapV3PoolSeeder(pool);
        require(p.liquidity() == 0, "pool has in-range liquidity");
        (uint160 current,,,,,,) = p.slot0();
        if (current == targetSqrtPriceX96) return;
        _pool = pool;
        p.swap(address(this), targetSqrtPriceX96 < current, 1, targetSqrtPriceX96, "");
        _pool = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external view {
        require(msg.sender == _pool && _pool != address(0), "pool");
        if (amount0Delta > 0 || amount1Delta > 0) revert PoolNotEmpty();
    }

    /// @notice Mint full-range liquidity from `msg.sender`'s tokens (approve
    /// this contract for up to `amount0Max` / `amount1Max` first).
    function mintFullRange(address pool, uint256 amount0Max, uint256 amount1Max, address recipient)
        external
        returns (uint128 liquidity, uint256 paid0, uint256 paid1)
    {
        IUniswapV3PoolSeeder p = IUniswapV3PoolSeeder(pool);
        (int24 lower, int24 upper) = fullRange(p.tickSpacing());
        (uint160 sqrtP,,,,,,) = p.slot0();
        liquidity = liquidityForAmounts(
            sqrtP,
            TickMath.getSqrtRatioAtTick(lower),
            TickMath.getSqrtRatioAtTick(upper),
            amount0Max,
            amount1Max
        );
        require(liquidity > 0, "zero liquidity");
        (_pool, _payer, _max0, _max1) = (pool, msg.sender, amount0Max, amount1Max);
        (paid0, paid1) = p.mint(recipient, lower, upper, liquidity, "");
        (_pool, _payer, _max0, _max1) = (address(0), address(0), 0, 0);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        address pool = _pool;
        require(msg.sender == pool && pool != address(0), "pool");
        require(amount0Owed <= _max0 && amount1Owed <= _max1, "over max");
        if (amount0Owed > 0) {
            require(
                IERC20Seeder(IUniswapV3PoolSeeder(pool).token0()).transferFrom(_payer, pool, amount0Owed),
                "t0"
            );
        }
        if (amount1Owed > 0) {
            require(
                IERC20Seeder(IUniswapV3PoolSeeder(pool).token1()).transferFrom(_payer, pool, amount1Owed),
                "t1"
            );
        }
    }

    /* ---------------------------------------------------------------- math */

    function fullRange(int24 spacing) public pure returns (int24 lower, int24 upper) {
        require(spacing > 0, "spacing");
        // forge-lint: disable-next-line(divide-before-multiply)
        lower = (TickMath.MIN_TICK / spacing) * spacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        upper = (TickMath.MAX_TICK / spacing) * spacing;
    }

    /// @dev Uniswap v3-periphery `LiquidityAmounts.getLiquidityForAmounts`.
    function liquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) public pure returns (uint128) {
        uint256 l;
        if (sqrtP <= sqrtA) {
            l = _forAmount0(sqrtA, sqrtB, amount0);
        } else if (sqrtP < sqrtB) {
            uint256 l0 = _forAmount0(sqrtP, sqrtB, amount0);
            uint256 l1 = _forAmount1(sqrtA, sqrtP, amount1);
            l = l0 < l1 ? l0 : l1;
        } else {
            l = _forAmount1(sqrtA, sqrtB, amount1);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    function _forAmount0(uint160 a, uint160 b, uint256 amount0) private pure returns (uint256) {
        uint256 intermediate = FullMath.mulDiv(a, b, Q96);
        return FullMath.mulDiv(amount0, intermediate, b - a);
    }

    function _forAmount1(uint160 a, uint160 b, uint256 amount1) private pure returns (uint256) {
        return FullMath.mulDiv(amount1, Q96, b - a);
    }
}
