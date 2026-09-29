// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {V3PoolSeeder} from "../src/testnet/V3PoolSeeder.sol";
import {StockBases} from "../src/config/StockBases.sol";
import {StockPriceSource} from "../src/oracle/StockPriceSource.sol";
import {TickMath} from "../src/oracle/uniswap/TickMath.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

interface IERC20SeedStock {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IWETHSeedStock {
    function deposit() external payable;
}

interface IV3PoolSeedStock {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @title Operator helper: make a stock/WETH (or stock/stable) V3 pool usable
/// for `StockPriceSource`'s TWAP by minting a full-range position at a
/// reference price.
///
/// The RH testnet pools exist and are initialized at a placeholder 1:1 price
/// with **zero liquidity**. With `STOCK_TOKEN` balance (Robinhood's testnet
/// faucet) and ETH/WETH in the signer's wallet, this:
///   1. computes the pool price for `STOCK_USD_1E6` / `QUOTE_USD_1E6`;
///   2. if the pool is empty and not already within `MAX_PRICE_GAP_BPS` of
///      it, moves it there for free (`V3PoolSeeder.reprice`: a zero-liquidity
///      swap; reverts rather than pay if any liquidity sits on the path);
///      if the pool already has liquidity it is never moved, and the script
///      refuses to add unless the pool is within `MAX_PRICE_GAP_BPS`;
///   3. mints full-range liquidity with `STOCK_AMOUNT` (default: the whole
///      balance) and the matching quote amount (`QUOTE_AMOUNT`, default the
///      value match at the reference price), wrapping ETH for any WETH
///      shortfall; the position belongs to the signer.
///
/// Wait `twapSecs` (30 min by default) afterwards: `StockPriceSource` ignores
/// a pool until its whole TWAP window has had liquidity in it.
///
/// ```
/// export PRIVATE_KEY=0x...                  # holds the stock tokens + ETH
/// STOCK_TOKEN=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E STOCK_USD_1E6=250000000 \
/// QUOTE_USD_1E6=4000000000 EXPECT_CHAIN_ID=46630 \
///   forge script script/SeedStockPool.s.sol:SeedStockPool --rpc-url $RH_RPC -vvv   # dry run
/// # ...then the same with --broadcast
/// ```
/// Optional: `POOL` (default: the `StockBases` pool), `STOCK_AMOUNT`,
/// `QUOTE_AMOUNT`, `MAX_PRICE_GAP_BPS` (100), `STOCK_PRICE_SOURCE` (to print
/// whether the new liquidity clears its `minLiquidity`). `QUOTE_USD_1E6` may
/// be omitted for a stable quote. Testnet tool: refuses to run on mainnet.
contract SeedStockPool is Script {
    struct Params {
        address stock;
        address pool;
        uint256 stockUsd1e6;
        uint256 quoteUsd1e6;
        uint256 stockAmount;
        /// 0 = value-matched at the reference price.
        uint256 quoteAmount;
        uint256 maxPriceGapBps;
        address stockPriceSource;
    }

    struct Result {
        address seeder;
        bool repriced;
        uint128 liquidity;
        uint256 paidStock;
        uint256 paidQuote;
        int24 tick;
    }

    function run() external returns (Result memory) {
        require(!MainnetGuard.isMainnet(), "SeedStockPool: testnet operator tool");
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "SeedStockPool: unexpected chain id");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Params memory p;
        p.stock = vm.envAddress("STOCK_TOKEN");
        p.pool = vm.envOr("POOL", address(0));
        if (p.pool == address(0)) p.pool = StockBases.find(p.stock).pool;
        p.stockUsd1e6 = vm.envUint("STOCK_USD_1E6");
        p.quoteUsd1e6 = vm.envOr("QUOTE_USD_1E6", uint256(0));
        p.stockAmount = vm.envOr("STOCK_AMOUNT", IERC20SeedStock(p.stock).balanceOf(vm.addr(pk)));
        p.quoteAmount = vm.envOr("QUOTE_AMOUNT", uint256(0));
        p.maxPriceGapBps = vm.envOr("MAX_PRICE_GAP_BPS", uint256(100));
        p.stockPriceSource = vm.envOr("STOCK_PRICE_SOURCE", address(0));
        return execute(p, pk);
    }

    function execute(Params memory p, uint256 pk) public returns (Result memory r) {
        address me = vm.addr(pk);
        IV3PoolSeedStock pool = IV3PoolSeedStock(p.pool);
        address t0 = pool.token0();
        address t1 = pool.token1();
        require(t0 == p.stock || t1 == p.stock, "SeedStockPool: stock is not in POOL");
        bool stockIs0 = t0 == p.stock;
        address quote = stockIs0 ? t1 : t0;
        if (p.quoteUsd1e6 == 0 && _isStable(quote)) p.quoteUsd1e6 = 1e6;
        require(p.stockUsd1e6 > 0 && p.quoteUsd1e6 > 0, "SeedStockPool: set STOCK_USD_1E6 and QUOTE_USD_1E6");
        require(p.stockAmount > 0, "SeedStockPool: no stock (faucet first, or set STOCK_AMOUNT)");
        uint8 sd = IERC20SeedStock(p.stock).decimals();
        uint8 qd = IERC20SeedStock(quote).decimals();

        // Quote atoms per stock atom = (stockUsd · 10^qd) / (quoteUsd · 10^sd).
        uint256 num = p.stockUsd1e6 * 10 ** qd;
        uint256 den = p.quoteUsd1e6 * 10 ** sd;
        if (p.quoteAmount == 0) p.quoteAmount = Math.mulDiv(p.stockAmount, num, den);
        // price(token1 per token0) · 2^192, then sqrt.
        uint160 target = stockIs0
            ? uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)))
            : uint160(Math.sqrt(Math.mulDiv(den, 1 << 192, num)));
        require(
            target > TickMath.MIN_SQRT_RATIO && target < TickMath.MAX_SQRT_RATIO,
            "SeedStockPool: price out of range"
        );

        (uint160 current,,,,,,) = pool.slot0();
        bool empty = pool.liquidity() == 0;
        bool close = _gapBps(current, target) <= p.maxPriceGapBps;
        require(empty || close, "SeedStockPool: pool has liquidity at a different price; not moving it");

        uint256 amount0 = stockIs0 ? p.stockAmount : p.quoteAmount;
        uint256 amount1 = stockIs0 ? p.quoteAmount : p.stockAmount;

        vm.startBroadcast(pk);
        V3PoolSeeder seeder = new V3PoolSeeder();
        if (!close) {
            seeder.reprice(p.pool, target);
            r.repriced = true;
        }
        // A non-stable quote is WETH (the only other quote `StockPriceSource`
        // prices): wrap whatever the wallet is short.
        if (!_isStable(quote)) {
            uint256 have = IERC20SeedStock(quote).balanceOf(me);
            if (have < p.quoteAmount) IWETHSeedStock(quote).deposit{value: p.quoteAmount - have}();
        }
        require(IERC20SeedStock(t0).approve(address(seeder), amount0), "approve0");
        require(IERC20SeedStock(t1).approve(address(seeder), amount1), "approve1");
        uint256 paid0;
        uint256 paid1;
        (r.liquidity, paid0, paid1) = seeder.mintFullRange(p.pool, amount0, amount1, me);
        require(IERC20SeedStock(t0).approve(address(seeder), 0), "reset0");
        require(IERC20SeedStock(t1).approve(address(seeder), 0), "reset1");
        vm.stopBroadcast();

        r.seeder = address(seeder);
        (r.paidStock, r.paidQuote) = stockIs0 ? (paid0, paid1) : (paid1, paid0);
        (, r.tick,,,,,) = pool.slot0();

        console2.log("pool              ", p.pool);
        console2.log("stock is token0   ", stockIs0);
        console2.log("repriced          ", r.repriced);
        console2.log("tick now          ", r.tick);
        console2.log("liquidity minted  ", r.liquidity);
        console2.log("pool liquidity    ", pool.liquidity());
        console2.log("stock paid        ", r.paidStock);
        console2.log("quote paid        ", r.paidQuote);
        if (p.stockPriceSource != address(0)) {
            StockPriceSource.Config memory c = StockPriceSource(p.stockPriceSource).getConfig(p.stock);
            console2.log("minLiquidity      ", c.p.minLiquidity);
            console2.log("clears the floor  ", pool.liquidity() >= c.p.minLiquidity);
            console2.log("TWAP usable after (s)", c.p.twapSecs);
        }
    }

    function _isStable(address token) private view returns (bool) {
        address[] memory s = RouterWiring.stables();
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i] == token) return true;
        }
        return false;
    }

    /// @dev Relative gap between two sqrt prices, as a price gap in bps (≈ 2× the sqrt gap).
    function _gapBps(uint160 a, uint160 b) private pure returns (uint256) {
        uint256 hi = a > b ? a : b;
        uint256 lo = a > b ? b : a;
        return ((hi - lo) * 20_000) / hi;
    }
}
