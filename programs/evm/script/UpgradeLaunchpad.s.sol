// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";

/// @title Upgrade the UUPS StonkzLaunchpad implementation on RH testnet 46630.
/// @dev Keeps the existing proxy address (RH_LAUNCHPAD_ADDRESS) stable.
contract UpgradeLaunchpad is Script {
    function run() external {
        require(RobinhoodChainTestnet.isTestnet(), "not 46630");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address launchpad = vm.envAddress("RH_LAUNCHPAD_ADDRESS");

        StonkzLaunchpad pad = StonkzLaunchpad(launchpad);
        require(pad.admin() == me, "signer is not launchpad admin");

        vm.startBroadcast(pk);
        StonkzLaunchpad impl = new StonkzLaunchpad();
        pad.upgradeToAndCall(address(impl), "");
        vm.stopBroadcast();

        console2.log("proxy", launchpad);
        console2.log("newImpl", address(impl));
        console2.log("admin", pad.admin());
    }
}
