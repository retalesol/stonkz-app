// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice QuoterV2-style exact-input quote for a single V3 pool. Uses the
/// Uniswap "swap then revert with amount" pattern so the API can `eth_call` it.
interface IUniswapV3FactoryLite {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolSwap {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract V3ExactInputQuoter {
    error QuoteAmount(uint256 amountOut);

    IUniswapV3FactoryLite public immutable factory;

    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    constructor(address factory_) {
        require(factory_ != address(0), "factory");
        factory = IUniswapV3FactoryLite(factory_);
    }

    /// @dev Not `view` — pool.swap mutates then we revert. Call via `eth_call`.
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "amount");
        address pool = factory.getPool(tokenIn, tokenOut, fee);
        require(pool != address(0), "pool");
        bool zeroForOne = tokenIn < tokenOut;

        try IUniswapV3PoolSwap(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            bytes("")
        ) {
            revert("expected revert");
        } catch (bytes memory reason) {
            amountOut = _parseAmountOut(reason);
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external pure {
        require(amount0Delta > 0 || amount1Delta > 0, "delta");
        uint256 amountOut = amount0Delta < 0
            ? uint256(-amount0Delta)
            : (amount1Delta < 0 ? uint256(-amount1Delta) : 0);
        revert QuoteAmount(amountOut);
    }

    function _parseAmountOut(bytes memory reason) private pure returns (uint256 amountOut) {
        // Custom error QuoteAmount(uint256): selector (4) + uint256 (32) = 36
        if (reason.length == 36) {
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
                amountOut := mload(add(reason, 36))
            }
            require(sel == QuoteAmount.selector, "bad sel");
            require(amountOut > 0, "zero out");
            return amountOut;
        }
        // Raw 32-byte assembly revert (legacy)
        if (reason.length == 32) {
            assembly {
                amountOut := mload(add(reason, 32))
            }
            require(amountOut > 0, "zero out");
            return amountOut;
        }
        revert("bad revert");
    }
}
