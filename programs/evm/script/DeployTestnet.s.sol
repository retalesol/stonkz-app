// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../src/StonkzRouter.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {UniswapV2Migrator} from "../src/UniswapV2Migrator.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {StonkzV2Factory} from "../src/testnet/StonkzV2Factory.sol";
import {DeployPad} from "./DeployPad.sol";

/// @title Robinhood Chain **testnet** (46630) deployment.
///
/// ```
/// export PRIVATE_KEY=0x...
/// export STONKZ_ADMIN=0x...                 # same as deployer on testnet
/// export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
/// export STONKZ_OPS_WITHDRAW_AUTHORITY=0x...  # must differ from protocol
/// forge script script/DeployTestnet.s.sol:DeployTestnet \
///   --rpc-url https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/ --broadcast -vvv
/// ```
contract DeployTestnet is Script {
    function run() external {
        require(RobinhoodChainTestnet.isTestnet(), "DeployTestnet: not chain 46630");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address admin = vm.envOr("STONKZ_ADMIN", deployer);
        address protocolWithdrawAuthority = vm.envAddress("STONKZ_PROTOCOL_WITHDRAW_AUTHORITY");
        address opsWithdrawAuthority = vm.envAddress("STONKZ_OPS_WITHDRAW_AUTHORITY");
        address migrationAuthority = vm.envOr("STONKZ_MIGRATION_AUTHORITY", admin);
        address oracleAuthority = vm.envOr("STONKZ_ORACLE_AUTHORITY", admin);

        require(admin == deployer, "DeployTestnet: admin must be the broadcaster on testnet");
        require(protocolWithdrawAuthority != address(0), "zero protocol");
        require(opsWithdrawAuthority != address(0), "zero ops");
        require(
            protocolWithdrawAuthority != opsWithdrawAuthority,
            "protocol and ops withdraw authorities must differ"
        );

        _requireCode(RobinhoodChainTestnet.WETH9, "WETH9");
        _requireCode(RobinhoodChainTestnet.UNIVERSAL_ROUTER, "UniversalRouter");

        uint256 ethUsd1e6 = vm.envOr("STONKZ_ETH_USD_1E6", uint256(3_000_000_000));
        uint256 usdgUsd1e6 = vm.envOr("STONKZ_USDG_USD_1E6", uint256(1_000_000));

        vm.startBroadcast(pk);

        PushPriceSource priceSource =
            DeployPad.pushOracle(admin, oracleAuthority, RobinhoodChainTestnet.ORACLE_MAX_AGE_SECS);

        StonkzLaunchpad launchpad = DeployPad.launchpad(
            admin, protocolWithdrawAuthority, opsWithdrawAuthority, priceSource, migrationAuthority
        );

        StonkzV2Factory v2Factory = new StonkzV2Factory();
        UniswapV2Migrator migrator =
            new UniswapV2Migrator(IUniswapV2Factory(address(v2Factory)), address(launchpad));

        launchpad.setMigrator(IGraduationMigrator(address(migrator)), migrationAuthority);
        launchpad.setMaxOracleStaleness(RobinhoodChainTestnet.ORACLE_MAX_AGE_SECS);

        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(RobinhoodChainTestnet.UNIVERSAL_ROUTER),
            StonkzLaunchpad(address(launchpad)),
            IWETH9(RobinhoodChainTestnet.WETH9),
            ISwapRouter02(RobinhoodChainTestnet.UNISWAP_V3_SWAP_ROUTER02),
            0, // no per-buy cap
            IPyth(RobinhoodChainTestnet.PYTH),
            IStockAttestationSink(address(0))
        );

        priceSource.pushPrice(RobinhoodChainTestnet.WETH9, ethUsd1e6, 0);
        if (RobinhoodChainTestnet.USDG.code.length > 0) {
            priceSource.pushPrice(RobinhoodChainTestnet.USDG, usdgUsd1e6, 0);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Robinhood testnet 46630 deployed ===");
        console2.log("PushPriceSource      :", address(priceSource));
        console2.log("StonkzLaunchpad      :", address(launchpad));
        console2.log("StonkzV2Factory      :", address(v2Factory));
        console2.log("UniswapV2Migrator    :", address(migrator));
        console2.log("StonkzRouter         :", address(router));
        console2.log("deployer/admin       :", deployer);
        console2.log("WETH9                :", RobinhoodChainTestnet.WETH9);
        console2.log("");
        console2.log("=== apps/api + indexer env ===");
        console2.log("RH_CHAIN_ID=46630");
        console2.log("RH_RPC_URL=https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/");
        console2.log("RH_LAUNCHPAD_ADDRESS=%s", address(launchpad));
        console2.log("RH_ROUTER_ADDRESS=%s", address(router));
    }

    function _requireCode(address a, string memory what) internal view {
        if (a.code.length == 0) {
            console2.log("DeployTestnet: no code at", what, a);
            revert("DeployTestnet: pinned dependency has no code");
        }
    }
}
