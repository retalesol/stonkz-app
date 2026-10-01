// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title `StonkzRouter.setConfig`: the per-buy native cap, the Pyth contract
/// and the attestation sink, without a router redeploy. Dry run by default.
///
/// Each value defaults to what the router holds today, so the operator names
/// only the knob that changes. `setConfig` is gated by the launchpad's
/// `admin` (the timelock on mainnet): with a signer that is not the admin, or
/// on mainnet, the script prints the calldata (target = router) instead of
/// sending it.
///
/// ```
/// ROUTER_ADDRESS=0x... MAX_BUY_NATIVE=500000000000000000 \
///   forge script script/SetRouterConfig.s.sol:SetRouterConfig --rpc-url $RPC -vvv   # dry run
/// read -s PRIVATE_KEY && export PRIVATE_KEY                                           # launchpad admin
/// ROUTER_ADDRESS=0x... MAX_BUY_NATIVE=500000000000000000 BROADCAST=1 \
///   forge script script/SetRouterConfig.s.sol:SetRouterConfig --rpc-url $RPC --broadcast -vvv
/// ```
/// Optional: `PYTH` (or `PYTH_ADDRESS`), `ATTESTATION_SINK`, `EXPECT_CHAIN_ID`.
/// A router deployed from the pre-`setConfig` bytecode (both live testnet
/// routers) has no such function: the script says so and stops — run
/// `UpgradeParams` with `DEPLOY_ROUTER=1` first.
contract SetRouterConfig is Script {
    function run() external {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "SetRouterConfig: unexpected chain id");
        address routerAddr = vm.envOr("ROUTER_ADDRESS", vm.envOr("RH_ROUTER_ADDRESS", address(0)));
        require(routerAddr.code.length > 0, "SetRouterConfig: set ROUTER_ADDRESS");
        StonkzRouter router = StonkzRouter(payable(routerAddr));
        StonkzLaunchpad pad = router.launchpad();
        require(
            hasSetConfig(routerAddr),
            "SetRouterConfig: this router predates setConfig (immutable cap/pyth/sink); deploy a new one with UpgradeParams DEPLOY_ROUTER=1"
        );

        uint256 cap = vm.envOr("MAX_BUY_NATIVE", router.maxBuyNative());
        address pyth = vm.envOr("PYTH", vm.envOr("PYTH_ADDRESS", address(router.pyth())));
        address sink = vm.envOr("ATTESTATION_SINK", address(router.attestationSink()));

        console2.log("chain           ", block.chainid);
        console2.log("router          ", routerAddr);
        console2.log("launchpad       ", address(pad));
        console2.log("admin (gate)    ", pad.admin());
        console2.log("maxBuyNative    ", router.maxBuyNative(), "->", cap);
        console2.log("pyth            ", address(router.pyth()), "->", pyth);
        console2.log("attestationSink ", address(router.attestationSink()), "->", sink);
        bytes memory data = abi.encodeCall(router.setConfig, (cap, IPyth(pyth), IStockAttestationSink(sink)));
        console2.log("calldata: setConfig(uint256,address,address), target = router, value 0");
        console2.logBytes(data);

        if (!vm.envOr("BROADCAST", false)) {
            console2.log("dry run: nothing sent. BROADCAST=1 --broadcast to send.");
            return;
        }
        uint256 pk = vm.envUint("PRIVATE_KEY");
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, gov);
        if (mainnet || pad.admin() != vm.addr(pk)) {
            console2.log(
                "not calling the router (signer is not the launchpad admin, or mainnet); schedule the calldata above"
            );
            return;
        }
        vm.startBroadcast(pk);
        router.setConfig(cap, IPyth(pyth), IStockAttestationSink(sink));
        vm.stopBroadcast();
        require(router.maxBuyNative() == cap, "cap did not take");
        require(address(router.pyth()) == pyth, "pyth did not take");
        require(address(router.attestationSink()) == sink, "sink did not take");
        console2.log("setConfig sent and verified");
    }

    /// A router from the old bytecode answers `setConfig`'s selector with no
    /// code path at all (its fallback reverts with empty data); a new one
    /// reverts `NotAdmin()` from this unprivileged static probe.
    function hasSetConfig(address routerAddr) public view returns (bool) {
        (bool ok, bytes memory ret) = routerAddr.staticcall(
            abi.encodeCall(StonkzRouter.setConfig, (0, IPyth(address(0)), IStockAttestationSink(address(0))))
        );
        if (ok) return true; // (unreachable unless the probe is the admin)
        return ret.length == 4 && bytes4(ret) == StonkzRouter.NotAdmin.selector;
    }
}
