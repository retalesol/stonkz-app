// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";

/// @title Upgrade the UUPS `StonkzLaunchpad` implementation in place, on any EVM net.
///
/// The proxy address (the `*_LAUNCHPAD_ADDRESS` every client holds) stays the
/// same; only the implementation behind it changes. Used for the four-leg fee
/// split (Phase 3): the new implementation appends `Coin.burnAccrued` and the
/// `stonkzBurn` mapping, both storage-append-safe, and widens the fee events.
///
/// ```
/// export PRIVATE_KEY=0x...            # must be the launchpad admin
/// export LAUNCHPAD_ADDRESS=0x...      # proxy, from deployments/<chainId>.json
/// forge script script/UpgradeLaunchpad.s.sol:UpgradeLaunchpad \
///   --rpc-url $RPC --broadcast -vvv
/// ```
///
/// `EXPECT_CHAIN_ID` (optional) makes the script refuse any other chain, so a
/// wrong `--rpc-url` cannot upgrade the wrong deployment.
contract UpgradeLaunchpad is Script {
    function run() external {
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "UpgradeLaunchpad: unexpected chain id");
        // Every chain Stonkz has ever deployed to; anything else is a typo.
        require(
            block.chainid == 46630 || block.chainid == 4663 || block.chainid == 84532
                || block.chainid == 8453 || block.chainid == 5042,
            "UpgradeLaunchpad: unknown chain"
        );

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address launchpad = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(launchpad != address(0), "UpgradeLaunchpad: set LAUNCHPAD_ADDRESS");
        require(launchpad.code.length > 0, "UpgradeLaunchpad: no code at proxy");

        StonkzLaunchpad pad = StonkzLaunchpad(launchpad);
        require(pad.admin() == me, "signer is not launchpad admin");

        vm.startBroadcast(pk);
        StonkzLaunchpad impl = new StonkzLaunchpad();
        pad.upgradeToAndCall(address(impl), "");
        vm.stopBroadcast();

        // Read back through the proxy: the new implementation must answer the
        // new getter, or the upgrade did not take.
        pad.stonkzBurn(address(0));

        console2.log("chain  ", block.chainid);
        console2.log("proxy  ", launchpad);
        console2.log("newImpl", address(impl));
        console2.log("admin  ", pad.admin());
        console2.log("Next: record the implementation in deployments/<chainId>.json, then roll the indexer.");
    }
}
