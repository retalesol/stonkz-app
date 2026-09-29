// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Ship atomic, Pyth-priced launches: a `PythPriceSource`, a new
/// `StonkzRouter`, a launchpad implementation that trusts that router — then
/// upgrade the proxy in place and switch its price source.
///
/// The router is immutable and not upgradeable, and the launchpad names the
/// one router allowed to call `createTokenFor` as an `immutable` of its
/// implementation (no storage slot). So they ship together:
///
///   1. `PythPriceSource(signer, pyth)`: ETH/USD → WETH (`PYTH_MAX_AGE`, band
///      `ETH_MIN_PRICE_1E6..ETH_MAX_PRICE_1E6`), fixed $1.00 for the chain's
///      USD stables, and the current price source as fallback for any other
///      base (the RH testnet stock tokens);
///   2. `StonkzRouter(universalRouter, proxy, weth, swapRouter02, cap, pyth)`
///      — same wiring as `DeployRouter.s.sol` (`RouterWiring`);
///   3. `StonkzLaunchpad(router)` — the new implementation;
///   4. `proxy.upgradeToAndCall(impl, "")`;
///   5. `proxy.setPriceSource(pythSource)` and
///      `proxy.setMaxOracleStaleness(MAX_ORACLE_STALENESS)` (default 120 s),
///      unless `SWITCH_PRICE_SOURCE=false`.
///
/// **Order of rollout.** After step 5 a launch needs a Pyth price at most
/// `MAX_ORACLE_STALENESS` old, i.e. an in-tx update: the API/web must already
/// be sending launches through the new router's `createAndBuyWithEth` /
/// `createWithPriceUpdate` with a Hermes `priceUpdate`. Run with
/// `SWITCH_PRICE_SOURCE=false` first to get the addresses, point the app at
/// them, then switch (or run once and accept a short window in which direct
/// `createToken` launches fail preflight as `stale oracle`).
///
/// The proxy address does not change; the router address does. Nothing is
/// migrated and the storage layout is untouched (the script re-reads the
/// pinned slots after the upgrade and refuses to finish if they moved).
///
/// ```
/// export PRIVATE_KEY=0x...            # launchpad admin
/// LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
///   forge script script/UpgradeAtomicLaunch.s.sol:UpgradeAtomicLaunch --rpc-url $RH_RPC -vvv   # dry run
/// # ...then the same with --broadcast
/// ```
/// Optional env: `MAX_BUY_NATIVE` (router per-buy cap, wei; 0 = none),
/// `PYTH_ADDRESS` (default: the chain's pin), `SWITCH_PRICE_SOURCE` (true),
/// `MAX_ORACLE_STALENESS` (120), `PYTH_MAX_AGE` (120), `ETH_MIN_PRICE_1E6`
/// (100e6), `ETH_MAX_PRICE_1E6` (100_000e6), `PRICE_FALLBACK` (default: the
/// launchpad's current source; `0x0` for none), `PAUSER` (default: left
/// unset; `setPauser` is called with the upgrade when given).
///
/// **Mainnet** (`MainnetGuard`): `PROPOSERS`, `MIN_DELAY` >= 24h, `PAUSER`,
/// `NEW_OPS_WITHDRAW_AUTHORITY`, `NEW_MIGRATION_AUTHORITY` are required and
/// must match the launchpad, whose admin must already be the timelock; the
/// script then deploys and prints the timelock batch, and never calls the
/// proxy itself.
///
/// If the signer is **not** the admin (e.g. after the governance handover the
/// admin is a TimelockController), the script still deploys, proposes the
/// launchpad admin as the price source's admin, and prints the batch to
/// schedule through the timelock instead of calling it.
contract UpgradeAtomicLaunch is Script {
    struct Params {
        address proxy;
        uint256 cap;
        address pyth;
        bool switchPriceSource;
        uint64 maxOracleStaleness;
        uint64 pythMaxAge;
        uint64 ethMin1e6;
        uint64 ethMax1e6;
        address fallbackSource;
        /// Optional on testnets (zero leaves it unset); set with the upgrade.
        address pauser;
        /// Mainnet only: the governance the launchpad must already be under.
        MainnetGuard.Governance gov;
    }

    struct Result {
        address router;
        address impl;
        address priceSource;
    }

    function run() external returns (Result memory) {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "UpgradeAtomicLaunch: unexpected chain id");
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "UpgradeAtomicLaunch: set LAUNCHPAD_ADDRESS");
        Params memory p = paramsFromEnv(proxy);
        p.gov = gov;
        return execute(p, vm.envUint("PRIVATE_KEY"));
    }

    function paramsFromEnv(address proxy) public view returns (Params memory p) {
        p = defaults(proxy);
        p.cap = vm.envOr("MAX_BUY_NATIVE", p.cap);
        p.pyth = vm.envOr("PYTH_ADDRESS", p.pyth);
        p.switchPriceSource = vm.envOr("SWITCH_PRICE_SOURCE", p.switchPriceSource);
        p.maxOracleStaleness = uint64(vm.envOr("MAX_ORACLE_STALENESS", uint256(p.maxOracleStaleness)));
        p.pythMaxAge = uint64(vm.envOr("PYTH_MAX_AGE", uint256(p.pythMaxAge)));
        p.ethMin1e6 = uint64(vm.envOr("ETH_MIN_PRICE_1E6", uint256(p.ethMin1e6)));
        p.ethMax1e6 = uint64(vm.envOr("ETH_MAX_PRICE_1E6", uint256(p.ethMax1e6)));
        p.fallbackSource = vm.envOr("PRICE_FALLBACK", p.fallbackSource);
        p.pauser = vm.envOr("PAUSER", address(0));
    }

    function defaults(address proxy) public view returns (Params memory p) {
        (,,, address pyth) = RouterWiring.forChain();
        p.proxy = proxy;
        p.pyth = pyth;
        p.switchPriceSource = true;
        p.maxOracleStaleness = 120;
        p.pythMaxAge = 120;
        p.ethMin1e6 = 100e6;
        p.ethMax1e6 = 100_000e6;
        // Fall back to whatever prices bases today — unless that is itself a
        // PythPriceSource (a re-run), in which case keep its fallback.
        address current = address(StonkzLaunchpad(proxy).priceSource());
        (bool isPyth, bytes memory ret) = current.staticcall(abi.encodeWithSignature("fallbackSource()"));
        p.fallbackSource = isPyth && ret.length == 32 ? abi.decode(ret, (address)) : current;
    }

    /// @notice The whole rollout, signed by `pk`. Public so the test suite
    /// drives the exact code path the broadcast takes.
    function execute(Params memory p, uint256 pk) public returns (Result memory r) {
        require(p.proxy.code.length > 0, "UpgradeAtomicLaunch: no code at proxy");
        require(p.maxOracleStaleness > 0 && p.pythMaxAge > 0, "UpgradeAtomicLaunch: staleness");
        address me = vm.addr(pk);
        StonkzLaunchpad pad = StonkzLaunchpad(p.proxy);
        address admin = pad.admin();
        (address ur, address weth, address sr02,) = RouterWiring.forChain();
        // Mainnet: the launchpad must already be under the timelock, and this
        // script only ever prints the batch for it — never calls the proxy.
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, p.gov);
        bool direct = admin == me && !mainnet;

        // Slots the proxy must still hold afterwards (see test_StorageLayoutIsAppendOnly).
        // Slots 11/12 (priceSource, maxOracleStaleness) are the ones step 5 is meant to change.
        bytes32[4] memory pinned = [
            vm.load(p.proxy, bytes32(uint256(5))),
            vm.load(p.proxy, bytes32(uint256(8))),
            vm.load(p.proxy, bytes32(uint256(13))),
            vm.load(p.proxy, bytes32(uint256(15)))
        ];

        vm.startBroadcast(pk);
        if (p.pyth != address(0)) {
            PythPriceSource ps = new PythPriceSource(me, IPyth(p.pyth));
            ps.setFeed(weth, RouterWiring.PYTH_ETH_USD, p.pythMaxAge, p.ethMin1e6, p.ethMax1e6);
            address[] memory stables = RouterWiring.stables();
            for (uint256 i = 0; i < stables.length; i++) {
                ps.setFixedPrice(stables[i], 1e6, p.pythMaxAge);
            }
            if (p.fallbackSource != address(0)) ps.setFallbackSource(IPriceSource(p.fallbackSource));
            if (admin != me) ps.proposeAdmin(admin);
            r.priceSource = address(ps);
        }
        r.router = address(
            new StonkzRouter(
                IUniversalRouter(ur),
                StonkzLaunchpad(p.proxy),
                IWETH9(weth),
                ISwapRouter02(sr02),
                p.cap,
                IPyth(p.pyth),
                IStockAttestationSink(address(0))
            )
        );
        r.impl = address(new StonkzLaunchpad(r.router));
        bool doSwitch = p.switchPriceSource && r.priceSource != address(0);
        if (direct) {
            pad.upgradeToAndCall(r.impl, "");
            if (p.pauser != address(0)) pad.setPauser(p.pauser);
            if (doSwitch) {
                pad.setPriceSource(IPriceSource(r.priceSource));
                pad.setMaxOracleStaleness(p.maxOracleStaleness);
            }
        }
        vm.stopBroadcast();

        require(address(StonkzRouter(payable(r.router)).launchpad()) == p.proxy, "router not bound to proxy");
        require(address(StonkzRouter(payable(r.router)).weth()) == weth, "router weth");
        require(address(StonkzRouter(payable(r.router)).pyth()) == p.pyth, "router pyth");
        require(StonkzLaunchpad(r.impl).trustedRouter() == r.router, "impl does not trust router");

        console2.log("chain              ", block.chainid);
        console2.log("proxy              ", p.proxy);
        console2.log("NEW StonkzRouter   ", r.router);
        console2.log("new impl           ", r.impl);
        console2.log("NEW PythPriceSource", r.priceSource);
        console2.log("pyth               ", p.pyth);
        console2.log("price fallback     ", p.fallbackSource);
        console2.log("maxBuyNative       ", p.cap);

        if (direct) {
            if (p.pauser != address(0)) require(pad.pauser() == p.pauser, "pauser not set");
            require(pad.trustedRouter() == r.router, "proxy does not trust the new router");
            require(vm.load(p.proxy, bytes32(uint256(5))) == pinned[0], "slot 5 (admin) moved");
            require(vm.load(p.proxy, bytes32(uint256(8))) == pinned[1], "slot 8 (ops authority) moved");
            require(vm.load(p.proxy, bytes32(uint256(13))) == pinned[2], "slot 13 (tokenCount) moved");
            require(vm.load(p.proxy, bytes32(uint256(15))) == pinned[3], "slot 15 (_lock) moved");
            require(uint256(pinned[3]) == 1, "_lock is not 1");
            if (doSwitch) {
                require(address(pad.priceSource()) == r.priceSource, "price source not switched");
                require(pad.maxOracleStaleness() == p.maxOracleStaleness, "staleness not set");
            }
            console2.log("upgraded; priceSource switched:", doSwitch);
        } else {
            console2.log("not calling the proxy (signer is not admin, or mainnet); admin is", admin);
            console2.log("schedule this batch through the admin (timelock), all value 0:");
            console2.log("  target proxy:", p.proxy);
            console2.logBytes(abi.encodeCall(pad.upgradeToAndCall, (r.impl, "")));
            if (p.pauser != address(0)) {
                console2.log("  target proxy:", p.proxy);
                console2.logBytes(abi.encodeCall(pad.setPauser, (p.pauser)));
            }
            if (doSwitch) {
                console2.log("  target proxy:", p.proxy);
                console2.logBytes(abi.encodeCall(pad.setPriceSource, (IPriceSource(r.priceSource))));
                console2.log("  target proxy:", p.proxy);
                console2.logBytes(abi.encodeCall(pad.setMaxOracleStaleness, (p.maxOracleStaleness)));
            }
            if (r.priceSource != address(0)) {
                console2.log("  target PythPriceSource:", r.priceSource);
                console2.logBytes(abi.encodeCall(PythPriceSource.acceptAdmin, ()));
            }
        }
        console2.log("Next: *_ROUTER_ADDRESS (RH_/BASE_) -> NEW StonkzRouter on Railway + web; the app sends");
        console2.log("      launches with a Hermes priceUpdate; record router/impl/PythPriceSource in");
        console2.log("      deployments/<chainId>.json; add the router to the indexer's AtomicBuy sources.");
    }
}
