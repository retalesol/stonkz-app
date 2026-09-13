// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console2} from "forge-std/Script.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
contract ReadCoin is Script {
    function run() external view {
        address token = vm.envAddress("TOKEN");
        StonkzLaunchpad pad = StonkzLaunchpad(0x2588E500B1e5fCF18253F44b6f2607BF2B14161C);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        console2.log("token", c.token);
        console2.log("baseToken", c.baseToken);
        console2.log("baseDecimals", c.baseDecimals);
        console2.log("feeBps", c.feeBps);
        console2.log("supply", c.supply);
        console2.log("virtualBase", c.virtualBase);
        console2.log("virtualToken", c.virtualToken);
        console2.log("realBase", c.realBase);
        console2.log("realToken", c.realToken);
        console2.log("k", c.k);
        console2.log("tokensForSale", c.tokensForSale);
        console2.log("gradMcapBase", c.gradMcapBase);
        console2.log("creationPrice1e6", c.creationPrice1e6);
        console2.log("graduated", c.graduated);
    }
}
