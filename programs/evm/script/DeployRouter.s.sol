// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";
import {IPyth} from "../src/oracle/IPyth.sol";

/// @title Redeploy only the immutable `StonkzRouter`, on RH testnet or Base Sepolia.
///
/// The launchpad proxy is untouched: the router is a stateless adapter bound to
/// it, so a router bug (2026-09-27: unspent base stranded on a curve-capping
/// buy, permits not tolerant of a front-run replay) is fixed by deploying a new
/// one and pointing the API / indexer / web at it.
///
/// ```
/// export PRIVATE_KEY=0x...
/// LAUNCHPAD_ADDRESS=0x... EXPECT_CHAIN_ID=46630 forge script \
///   script/DeployRouter.s.sol:DeployRouter --rpc-url $RPC --broadcast -vvv
/// ```
/// `MAX_BUY_NATIVE` (wei, optional) sets the per-buy cap; 0 = none (testnets).
contract DeployRouter is Script {
    function run() external {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "DeployRouter: unexpected chain id");

        address launchpad = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(launchpad != address(0), "DeployRouter: set LAUNCHPAD_ADDRESS");
        require(launchpad.code.length > 0, "DeployRouter: no code at launchpad");
        // The router itself has no admin, but on mainnet it may only be bound
        // to a launchpad that is already under the timelock.
        if (MainnetGuard.isMainnet()) MainnetGuard.requireTimelockAdmin(StonkzLaunchpad(launchpad), gov);
        uint256 cap = vm.envOr("MAX_BUY_NATIVE", uint256(0));
        uint256 pk = vm.envUint("PRIVATE_KEY");

        (address ur, address weth, address sr02, address pyth) = RouterWiring.forChain();
        pyth = vm.envOr("PYTH_ADDRESS", pyth);

        vm.startBroadcast(pk);
        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(ur),
            StonkzLaunchpad(launchpad),
            IWETH9(weth),
            ISwapRouter02(sr02),
            cap,
            IPyth(pyth),
            IStockAttestationSink(address(0))
        );
        vm.stopBroadcast();

        require(address(router.launchpad()) == launchpad, "DeployRouter: router not bound to launchpad");
        console2.log("chain        ", block.chainid);
        console2.log("StonkzRouter ", address(router));
        console2.log("launchpad    ", launchpad);
        console2.log("maxBuyNative ", cap);
        console2.log("Next: *_ROUTER_ADDRESS on Railway, deployments/<chainId>.json, then emit-chains.");
        // `createAndBuyWithEth` only works through the router the launchpad
        // implementation trusts. A router deployed here on its own is not it —
        // use script/UpgradeAtomicLaunch.s.sol to deploy the pair together.
        try StonkzLaunchpad(launchpad).trustedRouter() returns (address trusted) {
            if (trusted != address(router)) {
                console2.log(
                    "NOTE: launchpad trusts", trusted, "- createAndBuyWithEth will revert on this router."
                );
            }
        } catch {
            console2.log("NOTE: launchpad implementation predates createTokenFor.");
        }
    }
}
