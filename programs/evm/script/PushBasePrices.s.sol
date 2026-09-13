// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";

/// Seed PushPriceSource so createToken works for documented testnet bases.
contract PushBasePrices is Script {
    function run() external {
        require(RobinhoodChainTestnet.isTestnet(), "not 46630");
        PushPriceSource oracle = PushPriceSource(vm.envAddress("RH_PRICE_SOURCE"));
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        oracle.pushPrice(RobinhoodChainTestnet.WETH9, 3_000_000_000, 0);
        oracle.pushPrice(RobinhoodChainTestnet.USDG, 1_000_000, 0);
        // Documented testnet stock tokens — USD 1e6-scaled, matches API base-price.ts
        _push(oracle, 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, 250_000_000); // TSLA
        _push(oracle, 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02, 200_000_000); // AMZN
        _push(oracle, 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0, 40_000_000); // PLTR
        _push(oracle, 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93, 700_000_000); // NFLX
        _push(oracle, 0x71178BAc73cBeb415514eB542a8995b82669778d, 160_000_000); // AMD
        vm.stopBroadcast();
        console2.log("pushed WETH/USDG + 5 stock bases");
    }

    function _push(PushPriceSource oracle, address token, uint256 price1e6) internal {
        if (token.code.length == 0) {
            console2.log("skip (no code)", token);
            return;
        }
        oracle.pushPrice(token, price1e6, 0);
        console2.log("price", token, price1e6);
    }
}
