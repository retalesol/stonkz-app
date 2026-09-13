// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {V3ExactInputQuoter} from "../src/testnet/V3ExactInputQuoter.sol";

contract DeployV3Quoter is Script {
    function run() external {
        require(RobinhoodChainTestnet.isTestnet(), "not 46630");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        V3ExactInputQuoter quoter = new V3ExactInputQuoter(RobinhoodChainTestnet.UNISWAP_V3_FACTORY);
        vm.stopBroadcast();
        console2.log("RH_V3_QUOTER_ADDRESS", address(quoter));
    }
}
