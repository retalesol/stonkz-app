// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Point the launchpad at a price source and set its staleness bound.
/// @notice The deferred half of `UpgradeAtomicLaunch` (run with
/// `SWITCH_PRICE_SOURCE=false`): switch to the `PythPriceSource` it deployed
/// **only after** the API/web send every launch through the new router with a
/// Hermes `priceUpdate` — from this moment a launch without one reads a stale
/// on-chain price and is refused ("stale oracle").
///
/// ```
/// export PRIVATE_KEY=0x...                                  # launchpad admin
/// PRICE_SOURCE=0x<PythPriceSource> LAUNCHPAD_ADDRESS=0x... EXPECT_CHAIN_ID=46630 \
///   forge script script/SwitchPriceSource.s.sol:SwitchPriceSource --rpc-url $RPC -vvv   # dry run
/// ```
/// `MAX_ORACLE_STALENESS` defaults to 120 s. On mainnet (`MainnetGuard`) the
/// admin must be the timelock and the two calls are printed for it instead.
contract SwitchPriceSource is Script {
    function run() external {
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "SwitchPriceSource: unexpected chain id");
        StonkzLaunchpad pad = StonkzLaunchpad(vm.envAddress("LAUNCHPAD_ADDRESS"));
        address source = vm.envAddress("PRICE_SOURCE");
        uint64 staleness = uint64(vm.envOr("MAX_ORACLE_STALENESS", uint256(120)));
        require(address(pad).code.length > 0, "SwitchPriceSource: no code at LAUNCHPAD_ADDRESS");
        require(source.code.length > 0, "SwitchPriceSource: no code at PRICE_SOURCE");
        require(staleness > 0, "SwitchPriceSource: staleness");
        // Must answer (possibly "no price") without reverting, as the launchpad expects.
        IPriceSource(source).priceUsd1e6(address(0));

        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) {
            MainnetGuard.requireTimelockAdmin(pad, gov);
            console2.log("schedule through the timelock, target = launchpad, value = 0:");
            console2.logBytes(abi.encodeCall(pad.setPriceSource, (IPriceSource(source))));
            console2.logBytes(abi.encodeCall(pad.setMaxOracleStaleness, (staleness)));
            return;
        }
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(pad.admin() == vm.addr(pk), "SwitchPriceSource: signer is not launchpad admin");
        vm.startBroadcast(pk);
        pad.setPriceSource(IPriceSource(source));
        pad.setMaxOracleStaleness(staleness);
        vm.stopBroadcast();
        require(address(pad.priceSource()) == source && pad.maxOracleStaleness() == staleness, "not switched");
        console2.log("launchpad  ", address(pad));
        console2.log("priceSource", source);
        console2.log("staleness  ", staleness);
    }
}
