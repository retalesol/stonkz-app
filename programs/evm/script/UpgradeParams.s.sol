// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzLens} from "../src/StonkzLens.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Ship the runtime-parameter store: upgrade the `StonkzLaunchpad`
/// proxy in place to the implementation with `setParams` / `setTrustedRouter`
/// (slots 17 and 18, appended), deploy a `StonkzLens` for the reads the
/// launchpad gave up (`quoteBuy` / `quoteSell` / `marketCap`), and — when
/// asked — a `StonkzRouter` with `setConfig`.
///
/// **No migration.** The new implementation reads slot 17 as "defaults" while
/// it is zero (`CurveMath.DEFAULT_PARAMS`: the 15/10/6/69 split, 100–500 bps,
/// 5000 bps over 300 s, $69,000, 1e12), so `upgradeToAndCall(impl, "")` with
/// no init data changes nothing a user can see. The implementation is built
/// with the proxy's **current** `trustedRouter()` as its constructor default,
/// so slot 18 stays zero and launches keep flowing through today's router.
///
/// **The live routers predate `setConfig`** (their cap / Pyth / sink are
/// immutables). `DEPLOY_ROUTER=1` deploys a new `StonkzRouter` with the same
/// Pyth and attestation sink the current router has (read from it; override
/// with `PYTH_ADDRESS` / `ATTESTATION_SINK` / `MAX_BUY_NATIVE`) and points the
/// proxy at it with `setTrustedRouter(newRouter)` — the first use of slot 18.
/// The previous router stops launching the moment that lands
/// (`createTokenFor` → "not router"); its trade paths keep working. Point the
/// app's `*_ROUTER_ADDRESS` at the new router in the same window and add the
/// old one to the indexer's `LEGACY_ROUTERS`.
///
/// ```
/// read -s PRIVATE_KEY && export PRIVATE_KEY          # launchpad admin, never pasted
/// LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
///   forge script script/UpgradeParams.s.sol:UpgradeParams --rpc-url $RH_RPC -vvv   # dry run
/// # ...then the same with --broadcast
/// ```
/// Optional env: `PARAMS_WORD` (a packed word from `SetParams.s.sol`; 0 =
/// leave the defaults in force), `DEPLOY_ROUTER` (false), `MAX_BUY_NATIVE` /
/// `PYTH_ADDRESS` / `ATTESTATION_SINK` (for the new router; default: the
/// current router's), `SMOKE_TOKEN` (an existing coin whose `coinInfo` is
/// read back through the new implementation), `EXPECT_CHAIN_ID`.
///
/// **Mainnet** (`MainnetGuard`): the launchpad must already be under the
/// timelock; the script deploys the implementation (and lens / router) and
/// prints the batch for the timelock, and never calls the proxy. The same
/// happens on a testnet when the signer is not the admin.
contract UpgradeParams is Script {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    struct Params {
        address proxy;
        /// Packed `CurveMath.Params`; zero leaves slot 17 untouched (defaults).
        uint256 paramsWord;
        /// Deploy a `setConfig`-capable router and `setTrustedRouter` it.
        bool deployRouter;
        uint256 cap;
        address pyth;
        address attestationSink;
        /// Optional: an existing coin to read back after the upgrade.
        address smokeToken;
        MainnetGuard.Governance gov;
    }

    struct Result {
        address impl;
        address lens;
        /// The router the proxy trusts afterwards: new when `deployRouter`, else the current one.
        address router;
        address previousRouter;
        bool upgraded;
    }

    function run() external returns (Result memory) {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "UpgradeParams: unexpected chain id");
        require(
            block.chainid == 46630 || block.chainid == 4663 || block.chainid == 84532
                || block.chainid == 8453,
            "UpgradeParams: unknown chain"
        );
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "UpgradeParams: set LAUNCHPAD_ADDRESS");
        Params memory p = defaults(proxy);
        p.paramsWord = vm.envOr("PARAMS_WORD", uint256(0));
        p.deployRouter = vm.envOr("DEPLOY_ROUTER", false);
        p.cap = vm.envOr("MAX_BUY_NATIVE", p.cap);
        p.pyth = vm.envOr("PYTH_ADDRESS", p.pyth);
        p.attestationSink = vm.envOr("ATTESTATION_SINK", p.attestationSink);
        p.smokeToken = vm.envOr("SMOKE_TOKEN", address(0));
        p.gov = gov;
        return execute(p, vm.envUint("PRIVATE_KEY"));
    }

    /// The current router's cap, Pyth and sink, so a new router is a pure
    /// capability add (the chain pin for Pyth where there is no router yet).
    function defaults(address proxy) public view returns (Params memory p) {
        p.proxy = proxy;
        if (RouterWiring.isPinned()) (,,, p.pyth) = RouterWiring.forChain();
        address current = StonkzLaunchpad(proxy).trustedRouter();
        if (current.code.length > 0) {
            p.cap = _readUint(current, "maxBuyNative()", p.cap);
            p.pyth = _readAddress(current, "pyth()", p.pyth);
            p.attestationSink = _readAddress(current, "attestationSink()", address(0));
        }
    }

    function execute(Params memory p, uint256 pk) public returns (Result memory r) {
        require(p.proxy.code.length > 0, "UpgradeParams: no code at proxy");
        require(
            p.paramsWord == 0 || CurveMath.validParams(p.paramsWord), "UpgradeParams: PARAMS_WORD invalid"
        );
        address me = vm.addr(pk);
        StonkzLaunchpad pad = StonkzLaunchpad(p.proxy);
        address admin = pad.admin();
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, p.gov);
        bool direct = admin == me && !mainnet;

        // Pre-upgrade view of the live layout. A pre-parameter implementation
        // never wrote 17 or 18; both must read zero or the proxy is not what
        // this script expects.
        r.previousRouter = pad.trustedRouter();
        bytes32[19] memory before;
        for (uint256 i = 0; i < 19; i++) {
            before[i] = vm.load(p.proxy, bytes32(i));
        }
        require(uint256(before[15]) == 1, "UpgradeParams: _lock is not 1 (slot 15)");

        vm.startBroadcast(pk);
        // Constructor default = the router the proxy trusts today, so slot 18
        // can stay zero and nothing about launches changes with the upgrade.
        r.impl = address(new StonkzLaunchpad(r.previousRouter));
        r.lens = address(new StonkzLens());
        r.router = r.previousRouter;
        if (p.deployRouter) {
            (address ur, address weth, address sr02,) = RouterWiring.forChain();
            r.router = address(
                new StonkzRouter(
                    IUniversalRouter(ur),
                    pad,
                    IWETH9(weth),
                    ISwapRouter02(sr02),
                    p.cap,
                    IPyth(p.pyth),
                    IStockAttestationSink(p.attestationSink)
                )
            );
        }
        if (direct) {
            pad.upgradeToAndCall(r.impl, "");
            if (p.deployRouter) pad.setTrustedRouter(r.router);
            if (p.paramsWord != 0) pad.setParams(p.paramsWord);
        }
        vm.stopBroadcast();

        require(StonkzLaunchpad(r.impl).trustedRouter() == r.previousRouter, "impl default router");
        if (p.deployRouter) {
            StonkzRouter nr = StonkzRouter(payable(r.router));
            require(address(nr.launchpad()) == p.proxy, "router not bound to proxy");
            require(address(nr.pyth()) == p.pyth, "router pyth");
            require(address(nr.attestationSink()) == p.attestationSink, "router attestation sink");
            require(nr.maxBuyNative() == p.cap, "router cap");
        }

        console2.log("chain            ", block.chainid);
        console2.log("proxy            ", p.proxy);
        console2.log("new impl         ", r.impl);
        console2.log("StonkzLens       ", r.lens);
        console2.log("router (before)  ", r.previousRouter);
        if (p.deployRouter) {
            console2.log("NEW StonkzRouter ", r.router);
            console2.log("  maxBuyNative   ", p.cap);
            console2.log("  pyth           ", p.pyth);
            console2.log("  attestationSink", p.attestationSink);
        }
        console2.log("PARAMS_WORD      ", p.paramsWord);

        if (direct) {
            r.upgraded = true;
            _verifyDirect(pad, p, r, before);
        } else {
            console2.log("not calling the proxy (signer is not admin, or mainnet); admin is", admin);
            console2.log("schedule this batch through the admin (timelock), all value 0, target = proxy:");
            console2.logBytes(abi.encodeCall(pad.upgradeToAndCall, (r.impl, "")));
            if (p.deployRouter) console2.logBytes(abi.encodeCall(pad.setTrustedRouter, (r.router)));
            if (p.paramsWord != 0) console2.logBytes(abi.encodeCall(pad.setParams, (p.paramsWord)));
        }
        _printCast(p, r);
    }

    function _verifyDirect(StonkzLaunchpad pad, Params memory p, Result memory r, bytes32[19] memory before)
        internal
        view
    {
        require(address(uint160(uint256(vm.load(p.proxy, IMPL_SLOT)))) == r.impl, "proxy implementation slot");
        for (uint256 i = 0; i < 19; i++) {
            if (i == 17 && p.paramsWord != 0) continue;
            if (i == 18 && p.deployRouter) continue;
            require(vm.load(p.proxy, bytes32(i)) == before[i], "a storage slot moved");
        }
        require(uint256(vm.load(p.proxy, bytes32(uint256(15)))) == 1, "_lock is not 1");
        uint256 wantWord = p.paramsWord == 0 ? CurveMath.DEFAULT_PARAMS : p.paramsWord;
        require(uint256(vm.load(p.proxy, bytes32(uint256(17)))) == p.paramsWord, "slot 17 (_params)");
        require(pad.paramsWord() == wantWord, "paramsWord()");
        require(pad.trustedRouter() == r.router, "trustedRouter()");
        if (!p.deployRouter) {
            require(uint256(vm.load(p.proxy, bytes32(uint256(18)))) == 0, "slot 18 (_router) must stay zero");
        }
        if (p.smokeToken != address(0)) {
            StonkzLaunchpad.Coin memory c = pad.coinInfo(p.smokeToken);
            require(c.token == p.smokeToken, "SMOKE_TOKEN is not a coin of this launchpad");
            (uint256 mcapBase,) = StonkzLens(r.lens).marketCap(pad, p.smokeToken);
            console2.log("smoke coinInfo   ", p.smokeToken);
            console2.log("  realBase       ", c.realBase);
            console2.log("  realToken      ", c.realToken);
            console2.log("  mcapBase (lens)", mcapBase);
        }
        console2.log("upgraded in place; layout unchanged; paramsWord =", pad.paramsWord());
        console2.log(
            p.paramsWord == 0 ? "defaults in force (slot 17 = 0)" : "PARAMS_WORD set (slot 17 = PARAMS_WORD)"
        );
    }

    function _printCast(Params memory p, Result memory r) internal pure {
        console2.log("");
        console2.log("verify with cast (RPC=<your rpc url>):");
        console2.log(
            string.concat(
                "  cast storage ", vm.toString(p.proxy), " ", vm.toString(IMPL_SLOT), " --rpc-url $RPC"
            )
        );
        console2.log(string.concat("    # expect ", vm.toString(r.impl)));
        console2.log(
            string.concat("  cast call ", vm.toString(p.proxy), ' "paramsWord()(uint256)" --rpc-url $RPC')
        );
        console2.log(
            string.concat("  cast call ", vm.toString(p.proxy), ' "trustedRouter()(address)" --rpc-url $RPC')
        );
        console2.log(string.concat("    # expect ", vm.toString(r.router)));
        console2.log(
            string.concat(
                "  cast call ",
                vm.toString(r.lens),
                ' "params(address)((uint16,uint16,uint16,uint16,uint16,uint16,uint32,uint64,uint64))" ',
                vm.toString(p.proxy),
                " --rpc-url $RPC"
            )
        );
        if (p.deployRouter) {
            console2.log(
                string.concat(
                    "  cast call ", vm.toString(r.router), ' "maxBuyNative()(uint256)" --rpc-url $RPC'
                )
            );
            console2.log(
                string.concat("  cast call ", vm.toString(r.router), ' "pyth()(address)" --rpc-url $RPC')
            );
            console2.log(
                string.concat(
                    "  cast call ", vm.toString(r.router), ' "attestationSink()(address)" --rpc-url $RPC'
                )
            );
            console2.log(
                "Next: *_ROUTER_ADDRESS (RH_/BASE_) -> NEW StonkzRouter on Railway + web (same window);"
            );
            console2.log("      add the previous router to the indexer's LEGACY_ROUTERS; record both in");
            console2.log("      deployments/<chainId>.json.");
        }
        console2.log("Record impl + lens in deployments/<chainId>.json; see docs/parameters.md.");
    }

    function _readUint(address target, string memory sig, uint256 dflt) private view returns (uint256) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(sig));
        return ok && ret.length == 32 ? abi.decode(ret, (uint256)) : dflt;
    }

    function _readAddress(address target, string memory sig, address dflt) private view returns (address) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(sig));
        return ok && ret.length == 32 ? abi.decode(ret, (address)) : dflt;
    }
}
