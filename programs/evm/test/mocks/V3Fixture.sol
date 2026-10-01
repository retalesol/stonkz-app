// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {IUniswapV3Factory, IUniswapV3Pool} from "../../src/oracle/uniswap/IUniswapV3.sol";
import {TickMath} from "../../src/oracle/uniswap/TickMath.sol";

/// @notice The **real** Uniswap V3 factory (and therefore real pools) in a
/// unit test, without a 0.7.6 compiler: the canonical factory's runtime
/// bytecode as deployed on Base Sepolia (`cast code` at
/// `0x4752…aD24`, fixture `test/fixtures/uniswap-v3-factory-84532.hex`) is
/// etched at that same address — same, because `NoDelegateCall` bakes the
/// deployment address into the code as an immutable — and the two storage
/// slots its constructor would have written (`owner` at 3, the fee-tier
/// tick spacings at mapping slot 4) are set by hand. `createPool` then
/// CREATE2-deploys the genuine `UniswapV3Pool` from the init code embedded
/// in that runtime, so every `mint`/`swap`/`burn`/`collect` under test is
/// Uniswap's own.
library V3Fixture {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;

    function deploy() internal returns (IUniswapV3Factory f) {
        return deployAt(FACTORY);
    }

    /// @notice The same runtime at another address — e.g. a mainnet factory
    /// pin — for tests that only read it (`feeAmountTickSpacing`). Only at
    /// `FACTORY` can it also `createPool`: `NoDelegateCall` compares
    /// `address(this)` with the address baked in at deployment.
    function deployAt(address at) internal returns (IUniswapV3Factory f) {
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/uniswap-v3-factory-84532.hex"));
        require(code.length > 20_000, "V3Fixture: fixture missing");
        vm.etch(at, code);
        vm.store(at, bytes32(uint256(3)), bytes32(uint256(uint160(address(0xF0)))));
        _tier(at, 100, 1);
        _tier(at, 500, 10);
        _tier(at, 3000, 60);
        _tier(at, 10_000, 200);
        f = IUniswapV3Factory(at);
        require(f.feeAmountTickSpacing(10_000) == 200, "V3Fixture: tiers");
    }

    function _tier(address at, uint24 fee, int24 spacing) private {
        vm.store(at, keccak256(abi.encode(uint256(fee), uint256(4))), bytes32(uint256(uint24(spacing))));
    }
}

interface IERC20Fixture {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice A trader for tests: exact-input swaps paid from its own balance.
contract V3TestSwapper {
    address private _pool;

    function swapExactIn(address pool, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        _pool = pool;
        (int256 d0, int256 d1) = IUniswapV3Pool(pool)
            .swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                ""
            );
        _pool = address(0);
        amountOut = uint256(-(zeroForOne ? d1 : d0));
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == _pool, "pool");
        if (d0 > 0) IERC20Fixture(IUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        if (d1 > 0) IERC20Fixture(IUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }
}

/// @notice A "sniper" for tests: initialises a pool at any price and mints
/// any range, paid from its own balance; can unwind to value its position.
contract V3TestSeeder {
    address private _pool;

    function initialize(address pool, uint160 sqrtPriceX96) external {
        IUniswapV3Pool(pool).initialize(sqrtPriceX96);
    }

    function mint(address pool, int24 lower, int24 upper, uint128 liquidity)
        external
        returns (uint256 a0, uint256 a1)
    {
        _pool = pool;
        (a0, a1) = IUniswapV3Pool(pool).mint(address(this), lower, upper, liquidity, "");
        _pool = address(0);
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        require(msg.sender == _pool, "pool");
        if (owed0 > 0) IERC20Fixture(IUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, owed0);
        if (owed1 > 0) IERC20Fixture(IUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, owed1);
    }

    /// @dev Burn the whole position and collect: what the seeder walks away with.
    function unwind(address pool, int24 lower, int24 upper) external returns (uint256 got0, uint256 got1) {
        (uint128 liq,,,,) =
            IUniswapV3Pool(pool).positions(keccak256(abi.encodePacked(address(this), lower, upper)));
        if (liq > 0) IUniswapV3Pool(pool).burn(lower, upper, liq);
        (uint128 c0, uint128 c1) =
            IUniswapV3Pool(pool).collect(address(this), lower, upper, type(uint128).max, type(uint128).max);
        return (c0, c1);
    }
}
