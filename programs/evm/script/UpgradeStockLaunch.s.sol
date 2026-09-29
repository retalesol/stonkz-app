// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Ship `createAndBuyViaV3` (atomic stock-base launch + dev buy): a new
/// `StonkzRouter` and a launchpad implementation whose immutable
/// `trustedRouter` is that router, then `upgradeToAndCall` the proxy in place.
///
/// Same shape as `UpgradeAtomicLaunch`, minus the price source (stock pricing
/// is `DeployStockPriceSource`, which needs no launchpad call at all). The
/// launchpad source is unchanged — this implementation differs from the live
/// one only in the `trustedRouter` immutable — so the pauser (slot 16), the
/// v2 fee split, the supply cap and `createTokenFor` all carry over, and the
/// layout is untouched: the script re-reads slots 0..17 after the upgrade and
/// refuses to finish if any moved (except slot 16 when `PAUSER` sets it).
///
/// **The previous router stops launching** the moment the proxy trusts the
/// new one (`createTokenFor` → "not router"); its trade paths keep working.
/// Point the app's `*_ROUTER_ADDRESS` at the new router in the same window.
///
/// ```
/// export PRIVATE_KEY=0x...            # launchpad admin
/// LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
///   forge script script/UpgradeStockLaunch.s.sol:UpgradeStockLaunch --rpc-url $RH_RPC -vvv   # dry run
/// # ...then the same with --broadcast
/// ```
/// Optional env: `MAX_BUY_NATIVE`, `PYTH_ADDRESS` and `ATTESTATION_SINK`
/// (default: the values of the router the proxy trusts today, else
/// `RouterWiring` / none), `PAUSER`.
///
/// **Mainnet** (`MainnetGuard`): the launchpad must already be under the
/// timelock; the script deploys and prints the batch, and never calls the
/// proxy. The same happens on a testnet when the signer is not the admin.
contract UpgradeStockLaunch is Script {
    struct Params {
        address proxy;
        uint256 cap;
        address pyth;
        /// Optional; zero leaves the pauser as it is.
        address pauser;
        /// `StockPriceSourceV2` to post "STKA" attestations to; zero drops them.
        /// Defaults to the current router's, so a re-run keeps attestations on.
        address attestationSink;
        MainnetGuard.Governance gov;
    }

    struct Result {
        address router;
        address impl;
        bool upgraded;
    }

    function run() external returns (Result memory) {
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "UpgradeStockLaunch: unexpected chain id");
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "UpgradeStockLaunch: set LAUNCHPAD_ADDRESS");
        Params memory p = defaults(proxy);
        p.cap = vm.envOr("MAX_BUY_NATIVE", p.cap);
        p.pyth = vm.envOr("PYTH_ADDRESS", p.pyth);
        p.pauser = vm.envOr("PAUSER", address(0));
        p.attestationSink = vm.envOr("ATTESTATION_SINK", p.attestationSink);
        p.gov = gov;
        return execute(p, vm.envUint("PRIVATE_KEY"));
    }

    /// Carry the current router's cap and Pyth over, so the swap is a pure
    /// feature add.
    function defaults(address proxy) public view returns (Params memory p) {
        (,,, address pyth) = RouterWiring.forChain();
        p.proxy = proxy;
        p.pyth = pyth;
        address current = StonkzLaunchpad(proxy).trustedRouter();
        if (current.code.length > 0) {
            p.cap = StonkzRouter(payable(current)).maxBuyNative();
            p.pyth = address(StonkzRouter(payable(current)).pyth());
            (bool ok, bytes memory ret) = current.staticcall(abi.encodeWithSignature("attestationSink()"));
            if (ok && ret.length == 32) p.attestationSink = abi.decode(ret, (address));
        }
    }

    function execute(Params memory p, uint256 pk) public returns (Result memory r) {
        require(p.proxy.code.length > 0, "UpgradeStockLaunch: no code at proxy");
        address me = vm.addr(pk);
        StonkzLaunchpad pad = StonkzLaunchpad(p.proxy);
        address admin = pad.admin();
        (address ur, address weth, address sr02,) = RouterWiring.forChain();
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, p.gov);
        bool direct = admin == me && !mainnet;

        bytes32[18] memory before;
        for (uint256 i = 0; i < 18; i++) {
            before[i] = vm.load(p.proxy, bytes32(i));
        }

        vm.startBroadcast(pk);
        r.router = address(
            new StonkzRouter(
                IUniversalRouter(ur),
                StonkzLaunchpad(p.proxy),
                IWETH9(weth),
                ISwapRouter02(sr02),
                p.cap,
                IPyth(p.pyth),
                IStockAttestationSink(p.attestationSink)
            )
        );
        r.impl = address(new StonkzLaunchpad(r.router));
        if (direct) {
            pad.upgradeToAndCall(r.impl, "");
            if (p.pauser != address(0)) pad.setPauser(p.pauser);
        }
        vm.stopBroadcast();

        require(address(StonkzRouter(payable(r.router)).launchpad()) == p.proxy, "router not bound to proxy");
        require(address(StonkzRouter(payable(r.router)).weth()) == weth, "router weth");
        require(address(StonkzRouter(payable(r.router)).swapRouter02()) == sr02, "router sr02");
        require(
            address(StonkzRouter(payable(r.router)).attestationSink()) == p.attestationSink,
            "router attestation sink"
        );
        require(StonkzLaunchpad(r.impl).trustedRouter() == r.router, "impl does not trust router");

        console2.log("chain            ", block.chainid);
        console2.log("proxy            ", p.proxy);
        console2.log("NEW StonkzRouter ", r.router);
        console2.log("new impl         ", r.impl);
        console2.log("pyth             ", p.pyth);
        console2.log("maxBuyNative     ", p.cap);
        console2.log("attestationSink  ", p.attestationSink);

        if (direct) {
            r.upgraded = true;
            require(pad.trustedRouter() == r.router, "proxy does not trust the new router");
            for (uint256 i = 0; i < 18; i++) {
                if (i == 16 && p.pauser != address(0)) continue;
                require(vm.load(p.proxy, bytes32(i)) == before[i], "a storage slot moved");
            }
            require(uint256(before[15]) == 1, "_lock is not 1");
            if (p.pauser != address(0)) require(pad.pauser() == p.pauser, "pauser not set");
            console2.log("upgraded in place; layout unchanged");
        } else {
            console2.log("not calling the proxy (signer is not admin, or mainnet); admin is", admin);
            console2.log("schedule this batch through the admin (timelock), all value 0:");
            console2.log("  target proxy:", p.proxy);
            console2.logBytes(abi.encodeCall(pad.upgradeToAndCall, (r.impl, "")));
            if (p.pauser != address(0)) {
                console2.log("  target proxy:", p.proxy);
                console2.logBytes(abi.encodeCall(pad.setPauser, (p.pauser)));
            }
        }
        console2.log("Next: *_ROUTER_ADDRESS (RH_/BASE_) -> NEW StonkzRouter on Railway + web (same window);");
        console2.log(
            "      record router/impl in deployments/<chainId>.json; add the router to the indexer's"
        );
        console2.log("      AtomicBuy/AtomicSell sources (keep the old one for history).");
    }
}
