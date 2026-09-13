// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 mint callback helper for seeding a WETH/USDG pool
/// on Robinhood testnet (46630), where the mainnet NFPM has no code.
interface IERC20Pay {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IUniswapV3PoolMint {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
}

contract V3LiquidityHelper {
    /// @dev Full-range ticks for fee tier 3000 (tick spacing 60).
    int24 internal constant TICK_LOWER = -887_220;
    int24 internal constant TICK_UPPER = 887_220;

    address public payer;

    /// @notice Mint full-range liquidity. Caller must have approved this contract
    /// for both tokens; `liquidity` is the V3 liquidity units to mint.
    function mintFullRange(address pool, uint128 liquidity) external returns (uint256 amount0, uint256 amount1) {
        require(liquidity > 0, "liq");
        payer = msg.sender;
        (amount0, amount1) = IUniswapV3PoolMint(pool).mint(msg.sender, TICK_LOWER, TICK_UPPER, liquidity, abi.encode(msg.sender));
        payer = address(0);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address from = abi.decode(data, (address));
        require(from == payer, "payer");
        address token0 = IUniswapV3PoolMint(msg.sender).token0();
        address token1 = IUniswapV3PoolMint(msg.sender).token1();
        if (amount0Owed > 0) {
            require(IERC20Pay(token0).transferFrom(from, msg.sender, amount0Owed), "t0");
        }
        if (amount1Owed > 0) {
            require(IERC20Pay(token1).transferFrom(from, msg.sender, amount1Owed), "t1");
        }
    }
}
