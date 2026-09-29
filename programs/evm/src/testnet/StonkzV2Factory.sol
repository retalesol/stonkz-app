// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeErc20} from "../SafeErc20.sol";

/// @notice Minimal Uniswap V2–compatible factory + pair for Robinhood testnet.
/// @dev Chain 46630 has no public Uniswap V2 factory at the mainnet pin. This
/// pair implements the slice of `UniswapV2Pair` that `UniswapV2Migrator`
/// needs — `getPair`/`createPair`, `mint`, `swap`, `sync`, `skim`,
/// `getReserves`, `token0`, `balanceOf`, `totalSupply` — with real v2
/// accounting (first-mint / proportional-mint, 0.3% fee, `K` check), so the
/// migrator's pool-price correction behaves on testnet exactly as it does
/// against a canonical Uniswap V2 pair on mainnet.
///
/// Deliberately absent: `burn` (LP is only ever minted to the dead address by
/// the migrator), flash-swap callbacks (`swap` refuses non-empty `data`), the
/// ERC-20 surface of the LP token, `permit`, price accumulators and `feeTo`.

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

    uint256 private unlocked = 1;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    modifier lock() {
        require(unlocked == 1, "LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }

    function mint(address to) external lock returns (uint256 liquidity) {
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
        _update(bal0, bal1);
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Uniswap V2 `swap`, without the flash-swap callback: the input
    /// must already be in the pair when this is called.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        require(data.length == 0, "NO_FLASH_SWAP");
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        uint256 r0 = reserve0;
        uint256 r1 = reserve1;
        require(amount0Out < r0 && amount1Out < r1, "INSUFFICIENT_LIQUIDITY");
        require(to != token0 && to != token1, "INVALID_TO");

        if (amount0Out > 0) SafeErc20.safeTransfer(token0, to, amount0Out);
        if (amount1Out > 0) SafeErc20.safeTransfer(token1, to, amount1Out);
        uint256 bal0 = IERC20Balance(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Balance(token1).balanceOf(address(this));

        uint256 in0 = bal0 > r0 - amount0Out ? bal0 - (r0 - amount0Out) : 0;
        uint256 in1 = bal1 > r1 - amount1Out ? bal1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "INSUFFICIENT_INPUT_AMOUNT");
        // 0.3% fee, the v2 invariant check verbatim.
        uint256 adj0 = bal0 * 1000 - in0 * 3;
        uint256 adj1 = bal1 * 1000 - in1 * 3;
        require(adj0 * adj1 >= r0 * r1 * 1_000_000, "K");

        _update(bal0, bal1);
        emit Swap(msg.sender, in0, in1, amount0Out, amount1Out, to);
    }

    /// @notice Force balances to match reserves (send the excess to `to`).
    function skim(address to) external lock {
        SafeErc20.safeTransfer(token0, to, IERC20Balance(token0).balanceOf(address(this)) - reserve0);
        SafeErc20.safeTransfer(token1, to, IERC20Balance(token1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Force reserves to match balances.
    function sync() external lock {
        _update(
            IERC20Balance(token0).balanceOf(address(this)), IERC20Balance(token1).balanceOf(address(this))
        );
    }

    function _update(uint256 bal0, uint256 bal1) private {
        require(bal0 <= type(uint112).max && bal1 <= type(uint112).max, "OVERFLOW");
        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
        emit Sync(reserve0, reserve1);
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
