// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";

/// Redeploy only the immutable StonkzRouter (e.g. after buyWithEth / buyViaV3).
contract DeployRouter is Script {
    function run() external {
        require(RobinhoodChainTestnet.isTestnet(), "not 46630");
        address launchpad = vm.envAddress("RH_LAUNCHPAD_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(RobinhoodChainTestnet.UNIVERSAL_ROUTER),
            StonkzLaunchpad(launchpad),
            IWETH9(RobinhoodChainTestnet.WETH9),
            ISwapRouter02(RobinhoodChainTestnet.UNISWAP_V3_SWAP_ROUTER02)
        );
        vm.stopBroadcast();
        console2.log("StonkzRouter", address(router));
        console2.log("Set RH_ROUTER_ADDRESS=%s", address(router));
    }
}
