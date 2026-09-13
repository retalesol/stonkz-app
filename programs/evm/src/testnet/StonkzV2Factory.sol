// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V2–compatible factory + pair for Robinhood testnet.
/// @dev Chain 46630 has no public Uniswap V2 factory at the mainnet pin. This
/// pair implements the slice `UniswapV2Migrator` needs (`getPair`/`createPair`,
/// `mint`, `getReserves`, `token0`, `balanceOf`, `totalSupply`) with real v2
/// first-mint / proportional-mint accounting so graduation burns work on-chain.

interface IERC20Balance {
    function balanceOf(address owner) external view returns (uint256);
}

contract StonkzV2Pair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 bal0 = IERC20Balance(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Balance(token1).balanceOf(address(this));
        uint256 amount0 = bal0 - reserve0;
        uint256 amount1 = bal1 - reserve1;

        if (totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            totalSupply += MINIMUM_LIQUIDITY;
            balanceOf[address(0xdead)] += MINIMUM_LIQUIDITY;
        } else {
            uint256 l0 = (amount0 * totalSupply) / reserve0;
            uint256 l1 = (amount1 * totalSupply) / reserve1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

contract StonkzV2Factory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "PAIR_EXISTS");
        pair = address(new StonkzV2Pair(token0, token1));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
