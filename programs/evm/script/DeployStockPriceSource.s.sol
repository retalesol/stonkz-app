// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {StockPriceSource} from "../src/oracle/StockPriceSource.sol";
import {IUniswapV3PoolOracle} from "../src/oracle/uniswap/V3Oracle.sol";
import {StockBases} from "../src/config/StockBases.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Deploy `StockPriceSource` for this chain's stock bases and make it
/// the live `PythPriceSource`'s fallback — 24/7 keyless pricing for stock-base
/// launches, with **no launchpad call and no launchpad storage change**.
///
///   1. `StockPriceSource(signer, pyth, quotePriceSource = PythPriceSource,
///      fallbackSource = PythPriceSource's current fallback (PushPriceSource))`;
///   2. `setStableQuote` for the chain's USD stables (`RouterWiring.stables`);
///   3. `setConfig` for every `StockBases.forChain()` entry (TWAP_SECS,
///      MIN_LIQUIDITY, STOCK_PYTH_MAX_AGE, MAX_DEVIATION_BPS from env; the
///      off-hours anchor from the entry unless ANCHOR_MAX_AGE,
///      OFF_HOURS_MAX_MOVE_BPS or OFF_HOURS_TWAP_SECS override it);
///   4. `pool.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY)` on
///      every configured pool (permissionless; skipped when already there) so
///      `observe()` can reach `twapSecs` back even on a busy pool;
///   5. `PythPriceSource.setFallbackSource(StockPriceSource)`, when the signer
///      is that source's admin (testnets); otherwise the call is printed for
///      its admin and `StockPriceSource` is offered to that admin
///      (`proposeAdmin`, to be accepted in the same batch).
///
/// ```
/// export PRIVATE_KEY=0x...    # PythPriceSource admin (= launchpad admin on RH 46630)
/// LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
///   forge script script/DeployStockPriceSource.s.sol:DeployStockPriceSource --rpc-url $RH_RPC -vvv  # dry run
/// # ...then the same with --broadcast
/// ```
/// Env: `PYTH_PRICE_SOURCE` (default: the launchpad's `priceSource`, which must
/// be a `PythPriceSource`), `STOCK_FALLBACK` (default: that source's current
/// fallback; `0x0` for none), `TWAP_SECS` (1800), `MIN_LIQUIDITY` (1e17),
/// `STOCK_PYTH_MAX_AGE` (120), `MAX_DEVIATION_BPS` (500),
/// `OBSERVATION_CARDINALITY` (64), `SET_PYTH_FALLBACK` (true), and — for
/// every entry, when set — `ANCHOR_MAX_AGE` (entry: 345600 = 4 d),
/// `OFF_HOURS_MAX_MOVE_BPS` (entry: 1500), `OFF_HOURS_TWAP_SECS` (entry: 7200).
/// The off-hours TWAP needs `OFF_HOURS_TWAP_SECS` of observation history, so
/// raise `OBSERVATION_CARDINALITY` for pools that trade most blocks.
///
/// **Mainnet** (`MainnetGuard`): the launchpad must be under the timelock and
/// the timelock must be `PythPriceSource`'s admin; the script deploys and
/// configures, proposes the timelock as admin, and prints the two calls to
/// schedule (`PythPriceSource.setFallbackSource`, `StockPriceSource.acceptAdmin`).
///
/// Order: after this, stock-base launches price from the DEX TWAP whenever a
/// pool is seeded (`SeedStockPool`) and `twapSecs` have passed since.
contract DeployStockPriceSource is Script {
    struct Params {
        address pythPriceSource;
        address fallbackSource;
        uint32 twapSecs;
        uint128 minLiquidity;
        uint64 pythMaxAge;
        uint16 maxDeviationBps;
        uint16 cardinality;
        bool setPythFallback;
        /// Overrides for every entry; 0 = use the `StockBases` entry's value.
        uint64 anchorMaxAge;
        uint16 offHoursMaxMoveBps;
        uint32 offHoursTwapSecs;
        /// Mainnet only.
        address launchpad;
        MainnetGuard.Governance gov;
    }

    struct Result {
        address source;
        uint256 configured;
        bool fallbackSet;
    }

    function run() external returns (Result memory) {
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "DeployStockPriceSource: unexpected chain id");
        address pad = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        address ps = vm.envOr("PYTH_PRICE_SOURCE", address(0));
        if (ps == address(0)) {
            require(pad.code.length > 0, "DeployStockPriceSource: set LAUNCHPAD_ADDRESS or PYTH_PRICE_SOURCE");
            ps = address(StonkzLaunchpad(pad).priceSource());
        }
        Params memory p = defaults(ps);
        p.launchpad = pad;
        p.gov = gov;
        p.fallbackSource = vm.envOr("STOCK_FALLBACK", p.fallbackSource);
        p.twapSecs = uint32(vm.envOr("TWAP_SECS", uint256(p.twapSecs)));
        p.minLiquidity = uint128(vm.envOr("MIN_LIQUIDITY", uint256(p.minLiquidity)));
        p.pythMaxAge = uint64(vm.envOr("STOCK_PYTH_MAX_AGE", uint256(p.pythMaxAge)));
        p.maxDeviationBps = uint16(vm.envOr("MAX_DEVIATION_BPS", uint256(p.maxDeviationBps)));
        p.cardinality = uint16(vm.envOr("OBSERVATION_CARDINALITY", uint256(p.cardinality)));
        p.setPythFallback = vm.envOr("SET_PYTH_FALLBACK", p.setPythFallback);
        p.anchorMaxAge = uint64(vm.envOr("ANCHOR_MAX_AGE", uint256(0)));
        p.offHoursMaxMoveBps = uint16(vm.envOr("OFF_HOURS_MAX_MOVE_BPS", uint256(0)));
        p.offHoursTwapSecs = uint32(vm.envOr("OFF_HOURS_TWAP_SECS", uint256(0)));
        return execute(p, vm.envUint("PRIVATE_KEY"));
    }

    function defaults(address pythPriceSource) public view returns (Params memory p) {
        p.pythPriceSource = pythPriceSource;
        p.twapSecs = 1800;
        p.minLiquidity = 1e17;
        p.pythMaxAge = 120;
        p.maxDeviationBps = 500;
        p.cardinality = 64;
        p.setPythFallback = true;
        // Keep whatever PythPriceSource falls back to today — unless that is
        // already a StockPriceSource (a re-run), in which case keep *its* fallback.
        address current = address(PythPriceSource(pythPriceSource).fallbackSource());
        (bool isStock, bytes memory ret) = current.staticcall(abi.encodeWithSignature("quotePriceSource()"));
        if (isStock && ret.length == 32) current = address(StockPriceSource(current).fallbackSource());
        p.fallbackSource = current;
    }

    function execute(Params memory p, uint256 pk) public returns (Result memory r) {
        PythPriceSource pps = PythPriceSource(p.pythPriceSource);
        require(address(pps).code.length > 0, "DeployStockPriceSource: no PythPriceSource");
        // Must be a PythPriceSource (the stock source reads WETH from it).
        address pyth = address(pps.pyth());
        StockBases.Entry[] memory bases = StockBases.forChain();
        require(bases.length > 0, "DeployStockPriceSource: no stock bases pinned for this chain (StockBases)");

        address me = vm.addr(pk);
        address psAdmin = pps.admin();
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) {
            require(
                p.launchpad.code.length > 0,
                "DeployStockPriceSource: LAUNCHPAD_ADDRESS is required on mainnet"
            );
            MainnetGuard.requireTimelockAdmin(StonkzLaunchpad(p.launchpad), p.gov);
            require(
                psAdmin == StonkzLaunchpad(p.launchpad).admin(),
                "DeployStockPriceSource: PythPriceSource admin is not the timelock"
            );
        }
        bool direct = psAdmin == me && !mainnet;

        vm.startBroadcast(pk);
        StockPriceSource s =
            new StockPriceSource(me, IPyth(pyth), IPriceSource(address(pps)), IPriceSource(p.fallbackSource));
        address[] memory stables = RouterWiring.stables();
        for (uint256 i = 0; i < stables.length; i++) {
            s.setStableQuote(stables[i], true);
        }
        for (uint256 i = 0; i < bases.length; i++) {
            StockBases.Entry memory e = bases[i];
            if (e.token.code.length == 0 || e.pool.code.length == 0) {
                console2.log("skip (no code at token or pool):", e.symbol);
                continue;
            }
            s.setConfig(
                e.token,
                StockPriceSource.Params({
                    pool: e.pool,
                    quoteToken: e.quote,
                    twapSecs: p.twapSecs,
                    minLiquidity: p.minLiquidity,
                    pythFeedId: pyth == address(0) ? bytes32(0) : e.pythFeedId,
                    pythMaxAge: p.pythMaxAge,
                    maxDeviationBps: p.maxDeviationBps,
                    minPrice1e6: e.minPrice1e6,
                    maxPrice1e6: e.maxPrice1e6,
                    anchorMaxAge: p.anchorMaxAge != 0 ? p.anchorMaxAge : e.anchorMaxAge,
                    offHoursMaxMoveBps: p.offHoursMaxMoveBps != 0
                        ? p.offHoursMaxMoveBps
                        : e.offHoursMaxMoveBps,
                    offHoursTwapSecs: p.offHoursTwapSecs != 0 ? p.offHoursTwapSecs : e.offHoursTwapSecs
                })
            );
            (,,,, uint16 next,,) = IUniswapV3PoolOracle(e.pool).slot0();
            if (next < p.cardinality) {
                IUniswapV3PoolOracle(e.pool).increaseObservationCardinalityNext(p.cardinality);
            }
            r.configured++;
        }
        if (direct && p.setPythFallback) {
            pps.setFallbackSource(IPriceSource(address(s)));
            r.fallbackSet = true;
        }
        if (psAdmin != me) s.proposeAdmin(psAdmin);
        vm.stopBroadcast();
        r.source = address(s);

        console2.log("chain                ", block.chainid);
        console2.log("NEW StockPriceSource ", r.source);
        console2.log("quote source (Pyth)  ", address(pps));
        console2.log("fallback (Push)      ", p.fallbackSource);
        console2.log("bases configured     ", r.configured);
        for (uint256 i = 0; i < bases.length; i++) {
            StockBases.Entry memory e = bases[i];
            if (e.pool.code.length == 0) continue;
            (,,,, uint16 next,,) = IUniswapV3PoolOracle(e.pool).slot0();
            StockPriceSource.Legs memory l = s.legs(e.token);
            (uint256 usd,,) = s.priceUsd1e6(e.token);
            console2.log(e.symbol, e.token);
            console2.log("   pool / cardinalityNext", e.pool, next);
            console2.log("   liquidity spot / TWAP-harmonic", l.spotLiquidity, l.harmonicMeanLiquidity);
            console2.log("   twap / pyth (1e6 USD)", l.twapPrice1e6, l.pythPrice1e6);
            console2.log("   anchor (1e6 USD) / twap window (s)", l.anchorPrice1e6, l.twapWindow);
            console2.log("   answer (may be the fallback)", usd);
        }
        if (r.fallbackSet) {
            require(address(pps.fallbackSource()) == r.source, "fallback not set");
            console2.log("PythPriceSource.fallbackSource -> StockPriceSource: done");
        } else {
            console2.log("schedule through the PythPriceSource admin", psAdmin, "(all value 0):");
            console2.log("  target PythPriceSource:", address(pps));
            console2.logBytes(abi.encodeCall(PythPriceSource.setFallbackSource, (IPriceSource(r.source))));
            if (psAdmin != me) {
                console2.log("  target StockPriceSource:", r.source);
                console2.logBytes(abi.encodeCall(StockPriceSource.acceptAdmin, ()));
            }
        }
        console2.log("Next: seed each pool (SeedStockPool), wait TWAP_SECS, then launch; record the");
        console2.log("      StockPriceSource in deployments/<chainId>.json.");
    }
}
