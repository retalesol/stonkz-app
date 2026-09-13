// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";

/// Smoke: oracle-graduate BETADOG + migrateLiquidity; LP should sit at 0x…dEaD.
contract SmokeGraduate is Script {
    address constant PAD = 0x2588E500B1e5fCF18253F44b6f2607BF2B14161C;
    address constant ORACLE = 0x64fd37034F271aB8c9C316D9339302241d8Be714;
    address constant TOKEN = 0x7Fb46AFa7aD4835Be52C02d26541174b2A09070D;
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant V2_FACTORY = 0x7eab3F59a16B1203111862188C3aa8fdE2E0737C;

    function run() external {
        StonkzLaunchpad pad = StonkzLaunchpad(PAD);
        PushPriceSource oracle = PushPriceSource(ORACLE);

        (uint256 mcapBase,) = pad.marketCap(TOKEN);
        // Price the base high enough that mcap clears $69,000 (1e6-scaled).
        uint256 needed = (69_000_000_000 * 1e18) / mcapBase + 1;
        console2.log("mcapBase", mcapBase);
        console2.log("pushPrice1e6", needed);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        oracle.pushPrice(WETH, needed, 0);
        pad.graduate(TOKEN);
        pad.migrateLiquidity(TOKEN);

        vm.stopBroadcast();

        StonkzLaunchpad.Coin memory c = pad.coinInfo(TOKEN);
        console2.log("graduated", c.graduated);
        console2.log("graduationReason", c.graduationReason);
        console2.log("realBase", c.realBase);
        console2.log("lpReserve", c.lpReserve);

        address pair = IUniswapV2FactoryLike(V2_FACTORY).getPair(TOKEN, WETH);
        console2.log("pair", pair);
        uint256 deadLp = IERC20(pair).balanceOf(DEAD);
        console2.log("deadLp", deadLp);
        require(c.graduated, "not graduated");
        require(deadLp > 0, "no LP at dead");
    }
}

interface IUniswapV2FactoryLike {
    function getPair(address, address) external view returns (address);
}
