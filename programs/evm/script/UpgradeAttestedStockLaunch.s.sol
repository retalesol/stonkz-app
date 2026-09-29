// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {StockPriceSource} from "../src/oracle/StockPriceSource.sol";
import {StockPriceSourceV2} from "../src/oracle/StockPriceSourceV2.sol";
import {IUniswapV3PoolOracle} from "../src/oracle/uniswap/V3Oracle.sol";
import {StockBases} from "../src/config/StockBases.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Ship signed per-launch stock prices: `StockPriceSourceV2` (the live
/// stock source plus an attested leg), a router that posts `"STKA"` entries
/// of `priceUpdate` to it, a launchpad implementation trusting that router,
/// and `PythPriceSource.setFallbackSource(V2)`.
///
///   1. `StockPriceSourceV2(signer, pyth, quote = PythPriceSource,
///      fallback = the push oracle, launchpad = proxy)`, configured like the
///      live stock source: for every `StockBases` entry, the live source's
///      config when it has one (pool, feed, TWAP, liquidity floor, deviation,
///      band, anchor), else the `StockBases` defaults; plus `ATTEST_MAX_AGE`
///      (default 300 s). `setAttester(ATTESTER)`.
///   2. `StonkzRouter(..., attestationSink = V2)` and `StonkzLaunchpad(router)`;
///      `proxy.upgradeToAndCall(impl, "")` (layout re-checked, slots 0..17).
///   3. `PythPriceSource.setFallbackSource(V2)`.
///
/// Steps 2 and 3 need the signer to be the launchpad / PythPriceSource admin
/// (testnets). Otherwise — and always on mainnet (`MainnetGuard`) — the
/// script deploys and configures, offers V2 to the admin (`proposeAdmin`), and
/// prints the batch for the admin (timelock) to schedule.
///
/// The previous router stops launching as soon as the proxy trusts the new
/// one: switch the app's router address in the same window, and have
/// `/launch/prepare` sign attestations for **this** V2 address (the digest
/// binds `address(this)` and the chain id).
///
/// ```
/// export PRIVATE_KEY=0x...     # launchpad + PythPriceSource admin
/// ATTESTER=0x<API signer address> \
/// LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
///   forge script script/UpgradeAttestedStockLaunch.s.sol:UpgradeAttestedStockLaunch --rpc-url $RH_RPC -vvv
/// # ...then the same with --broadcast
/// ```
/// Optional env: `ATTEST_MAX_AGE` (300), `STOCK_FALLBACK` (default: the push
/// oracle behind the live stock source), `MAX_BUY_NATIVE` / `PYTH_ADDRESS`
/// (default: the current router's), `PAUSER`, `OBSERVATION_CARDINALITY` (64).
contract UpgradeAttestedStockLaunch is Script {
    struct Params {
        address proxy;
        address pythPriceSource;
        /// The live stock source to copy per-base config from; zero for none.
        address previousStock;
        address fallbackSource;
        address attester;
        uint64 attestMaxAge;
        uint256 cap;
        address pyth;
        address pauser;
        uint16 cardinality;
        MainnetGuard.Governance gov;
    }

    struct Result {
        address source;
        address router;
        address impl;
        uint256 configured;
        bool upgraded;
        bool fallbackSet;
    }

    function run() external returns (Result memory) {
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "UpgradeAttestedStockLaunch: unexpected chain id");
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "UpgradeAttestedStockLaunch: set LAUNCHPAD_ADDRESS");
        Params memory p = defaults(proxy);
        p.attester = vm.envOr("ATTESTER", address(0));
        p.attestMaxAge = uint64(vm.envOr("ATTEST_MAX_AGE", uint256(p.attestMaxAge)));
        p.fallbackSource = vm.envOr("STOCK_FALLBACK", p.fallbackSource);
        p.cap = vm.envOr("MAX_BUY_NATIVE", p.cap);
        p.pyth = vm.envOr("PYTH_ADDRESS", p.pyth);
        p.pauser = vm.envOr("PAUSER", address(0));
        p.cardinality = uint16(vm.envOr("OBSERVATION_CARDINALITY", uint256(p.cardinality)));
        p.gov = gov;
        return execute(p, vm.envUint("PRIVATE_KEY"));
    }

    function defaults(address proxy) public view returns (Params memory p) {
        p.proxy = proxy;
        p.attestMaxAge = 300;
        p.cardinality = 64;
        p.pythPriceSource = address(StonkzLaunchpad(proxy).priceSource());
        // PythPriceSource → (live stock source →) push. Keep the push oracle
        // as V2's fallback and remember the stock source to copy config from.
        address current = address(PythPriceSource(p.pythPriceSource).fallbackSource());
        if (_isStockSource(current)) {
            p.previousStock = current;
            p.fallbackSource = address(StockPriceSource(current).fallbackSource());
        } else {
            p.fallbackSource = current;
        }
        (,,, address pyth) = RouterWiring.forChain();
        p.pyth = pyth;
        address router = StonkzLaunchpad(proxy).trustedRouter();
        if (router.code.length > 0) {
            p.cap = StonkzRouter(payable(router)).maxBuyNative();
            p.pyth = address(StonkzRouter(payable(router)).pyth());
        }
    }

    function execute(Params memory p, uint256 pk) public returns (Result memory r) {
        require(p.attester != address(0), "UpgradeAttestedStockLaunch: ATTESTER is required (non-zero)");
        require(p.proxy.code.length > 0, "UpgradeAttestedStockLaunch: no code at proxy");
        PythPriceSource pps = PythPriceSource(p.pythPriceSource);
        require(address(pps).code.length > 0, "UpgradeAttestedStockLaunch: launchpad priceSource has no code");
        StockBases.Entry[] memory bases = StockBases.forChain();
        require(bases.length > 0, "UpgradeAttestedStockLaunch: no stock bases pinned for this chain");

        address me = vm.addr(pk);
        StonkzLaunchpad pad = StonkzLaunchpad(p.proxy);
        address padAdmin = pad.admin();
        address psAdmin = pps.admin();
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) {
            MainnetGuard.requireTimelockAdmin(pad, p.gov);
            require(
                psAdmin == padAdmin, "UpgradeAttestedStockLaunch: PythPriceSource admin is not the timelock"
            );
        }
        bool direct = padAdmin == me && !mainnet;
        bool directFallback = psAdmin == me && !mainnet;
        (address ur, address weth, address sr02,) = RouterWiring.forChain();

        bytes32[18] memory before;
        for (uint256 i = 0; i < 18; i++) {
            before[i] = vm.load(p.proxy, bytes32(i));
        }

        vm.startBroadcast(pk);
        StockPriceSourceV2 s = new StockPriceSourceV2(
            me, pps.pyth(), IPriceSource(address(pps)), IPriceSource(p.fallbackSource), p.proxy
        );
        {
            address[] memory stables = RouterWiring.stables();
            for (uint256 i = 0; i < stables.length; i++) {
                s.setStableQuote(stables[i], true);
            }
        }
        for (uint256 i = 0; i < bases.length; i++) {
            StockBases.Entry memory e = bases[i];
            if (e.token.code.length == 0) {
                console2.log("skip (no code at token):", e.symbol);
                continue;
            }
            StockPriceSourceV2.Params memory c = _paramsFor(p, e, address(s.pyth()) != address(0));
            if (c.pool != address(0) && c.pool.code.length == 0) {
                (c.pool, c.quoteToken) = (address(0), address(0));
            }
            s.setConfig(e.token, c);
            if (c.pool != address(0)) {
                (,,,, uint16 next,,) = IUniswapV3PoolOracle(c.pool).slot0();
                if (next < p.cardinality) {
                    IUniswapV3PoolOracle(c.pool).increaseObservationCardinalityNext(p.cardinality);
                }
            }
            r.configured++;
        }
        s.setAttester(p.attester);
        if (psAdmin != me) s.proposeAdmin(psAdmin);

        r.router = address(
            new StonkzRouter(
                IUniversalRouter(ur),
                pad,
                IWETH9(weth),
                ISwapRouter02(sr02),
                p.cap,
                IPyth(p.pyth),
                IStockAttestationSink(address(s))
            )
        );
        r.impl = address(new StonkzLaunchpad(r.router));
        if (direct) {
            pad.upgradeToAndCall(r.impl, "");
            if (p.pauser != address(0)) pad.setPauser(p.pauser);
            r.upgraded = true;
        }
        if (directFallback) {
            pps.setFallbackSource(IPriceSource(address(s)));
            r.fallbackSet = true;
        }
        vm.stopBroadcast();
        r.source = address(s);

        require(address(StonkzRouter(payable(r.router)).attestationSink()) == r.source, "router sink");
        require(address(StonkzRouter(payable(r.router)).launchpad()) == p.proxy, "router not bound to proxy");
        require(StonkzLaunchpad(r.impl).trustedRouter() == r.router, "impl does not trust router");
        require(s.attester() == p.attester, "attester not set");
        if (r.upgraded) {
            require(pad.trustedRouter() == r.router, "proxy does not trust the new router");
            for (uint256 i = 0; i < 18; i++) {
                if (i == 16 && p.pauser != address(0)) continue;
                require(vm.load(p.proxy, bytes32(i)) == before[i], "a storage slot moved");
            }
        }
        if (r.fallbackSet) require(address(pps.fallbackSource()) == r.source, "fallback not set");

        _log(p, r, s, bases);
        if (!r.upgraded || !r.fallbackSet) _printBatch(p, r, pad, pps, psAdmin != me);
    }

    /// The live source's config for `e.token` if it has one, else the
    /// `StockBases` defaults.
    function _paramsFor(Params memory p, StockBases.Entry memory e, bool hasPyth)
        internal
        view
        returns (StockPriceSourceV2.Params memory c)
    {
        c = StockPriceSourceV2.Params({
            pool: e.pool,
            quoteToken: e.quote,
            twapSecs: 1800,
            minLiquidity: 1e17,
            pythFeedId: hasPyth ? e.pythFeedId : bytes32(0),
            pythMaxAge: 120,
            maxDeviationBps: 500,
            minPrice1e6: e.minPrice1e6,
            maxPrice1e6: e.maxPrice1e6,
            anchorMaxAge: e.anchorMaxAge,
            offHoursMaxMoveBps: e.offHoursMaxMoveBps,
            offHoursTwapSecs: e.offHoursTwapSecs,
            attestMaxAge: p.attestMaxAge
        });
        if (p.previousStock == address(0)) return c;
        if (_isV2(p.previousStock)) {
            StockPriceSourceV2.Config memory v2 = StockPriceSourceV2(p.previousStock).getConfig(e.token);
            if (!v2.set) return c;
            c = v2.p;
            c.attestMaxAge = p.attestMaxAge;
            return c;
        }
        StockPriceSource.Config memory v1 = StockPriceSource(p.previousStock).getConfig(e.token);
        if (v1.p.pool == address(0)) return c;
        c.pool = v1.p.pool;
        c.quoteToken = v1.p.quoteToken;
        c.twapSecs = v1.p.twapSecs;
        c.minLiquidity = v1.p.minLiquidity;
        c.pythFeedId = v1.p.pythFeedId;
        c.pythMaxAge = v1.p.pythMaxAge;
        c.maxDeviationBps = v1.p.maxDeviationBps == 0 ? 500 : v1.p.maxDeviationBps;
        c.minPrice1e6 = v1.p.minPrice1e6;
        c.maxPrice1e6 = v1.p.maxPrice1e6;
        c.anchorMaxAge = v1.p.anchorMaxAge;
        c.offHoursMaxMoveBps = v1.p.offHoursMaxMoveBps;
        c.offHoursTwapSecs = v1.p.offHoursTwapSecs;
    }

    function _isStockSource(address a) internal view returns (bool) {
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeWithSignature("quotePriceSource()"));
        return ok && ret.length == 32;
    }

    function _isV2(address a) internal view returns (bool) {
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeWithSignature("attesterEpoch()"));
        return ok && ret.length == 32;
    }

    function _log(Params memory p, Result memory r, StockPriceSourceV2 s, StockBases.Entry[] memory bases)
        internal
        view
    {
        console2.log("chain                  ", block.chainid);
        console2.log("NEW StockPriceSourceV2 ", r.source);
        console2.log("NEW StonkzRouter       ", r.router);
        console2.log("new impl               ", r.impl);
        console2.log("attester               ", p.attester);
        console2.log("config copied from     ", p.previousStock);
        console2.log("fallback (push)        ", p.fallbackSource);
        console2.log("bases configured       ", r.configured);
        console2.log("upgraded / fallback set", r.upgraded, r.fallbackSet);
        for (uint256 i = 0; i < bases.length; i++) {
            StockPriceSourceV2.Config memory c = s.getConfig(bases[i].token);
            if (!c.set) continue;
            console2.log(bases[i].symbol, bases[i].token, c.p.pool);
            console2.log("   attestMaxAge / maxDeviationBps", c.p.attestMaxAge, c.p.maxDeviationBps);
        }
        console2.log("Next: app router address -> NEW StonkzRouter (same window as the upgrade); API");
        console2.log("      signs attestations for NEW StockPriceSourceV2 on this chain id; record both");
        console2.log("      in deployments/<chainId>.json; indexer AtomicBuy sources += router.");
    }

    function _printBatch(
        Params memory p,
        Result memory r,
        StonkzLaunchpad pad,
        PythPriceSource pps,
        bool accept
    ) internal pure {
        console2.log("schedule this batch through the admin (timelock), all value 0:");
        if (!r.upgraded) {
            console2.log("  target launchpad proxy:", p.proxy);
            console2.logBytes(abi.encodeCall(pad.upgradeToAndCall, (r.impl, "")));
            if (p.pauser != address(0)) {
                console2.log("  target launchpad proxy:", p.proxy);
                console2.logBytes(abi.encodeCall(pad.setPauser, (p.pauser)));
            }
        }
        if (!r.fallbackSet) {
            console2.log("  target PythPriceSource:", address(pps));
            console2.logBytes(abi.encodeCall(PythPriceSource.setFallbackSource, (IPriceSource(r.source))));
        }
        if (accept) {
            console2.log("  target StockPriceSourceV2:", r.source);
            console2.logBytes(abi.encodeCall(StockPriceSourceV2.acceptAdmin, ()));
        }
    }
}
