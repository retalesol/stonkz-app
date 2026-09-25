// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../src/StonkzRouter.sol";
import {UniswapV2Migrator} from "../src/UniswapV2Migrator.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {Arc} from "../src/config/Arc.sol";
import {StonkzV2Factory} from "../src/testnet/StonkzV2Factory.sol";
import {DeployPad} from "./DeployPad.sol";

/// @title Circle Arc (5042) deployment — mainnet, capped.
///
/// Arc has no public testnet any more, so this is a real-funds deployment run
/// with a fresh key (the RH/Base testnet deployer is burned — see
/// `deployments/46630.json`). The router is deployed with `Arc.MAX_BUY_NATIVE`
/// so no single buy can exceed 25 USDC regardless of what the API or UI do.
///
/// ```
/// export PRIVATE_KEY=0x...                       # fresh key, funded with USDC on Arc
/// export STONKZ_ADMIN=0x...
/// export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
/// export STONKZ_OPS_WITHDRAW_AUTHORITY=0x...     # must differ from protocol
/// forge script script/DeployArc.s.sol:DeployArc \
///   --rpc-url $ARC_RPC_URL --broadcast -vvv
/// ```
contract DeployArc is Script {
    function run() external {
        require(Arc.isArc(), "DeployArc: not chain 5042");
        require(Arc.pinned(), "DeployArc: fill in src/config/Arc.sol first (placeholders are zero)");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address admin = vm.envOr("STONKZ_ADMIN", deployer);
        address protocolWithdrawAuthority = vm.envAddress("STONKZ_PROTOCOL_WITHDRAW_AUTHORITY");
        address opsWithdrawAuthority = vm.envAddress("STONKZ_OPS_WITHDRAW_AUTHORITY");
        address migrationAuthority = vm.envOr("STONKZ_MIGRATION_AUTHORITY", admin);
        address oracleAuthority = vm.envOr("STONKZ_ORACLE_AUTHORITY", admin);

        require(protocolWithdrawAuthority != address(0), "zero protocol");
        require(opsWithdrawAuthority != address(0), "zero ops");
        require(
            protocolWithdrawAuthority != opsWithdrawAuthority,
            "protocol and ops withdraw authorities must differ"
        );

        _requireCode(Arc.WRAPPED_NATIVE, "WRAPPED_NATIVE");
        _requireCode(Arc.USDC_ERC20, "USDC_ERC20");
        _requireCode(Arc.UNIVERSAL_ROUTER, "UniversalRouter");
        _requireCode(Arc.UNISWAP_V3_SWAP_ROUTER02, "SwapRouter02");

        // USDC is the unit of account: both faces are one dollar.
        uint256 usdcUsd1e6 = 1_000_000;

        vm.startBroadcast(pk);

        PushPriceSource priceSource =
            DeployPad.pushOracle(admin, oracleAuthority, Arc.ORACLE_MAX_AGE_SECS);

        StonkzLaunchpad launchpad = DeployPad.launchpad(
            admin, protocolWithdrawAuthority, opsWithdrawAuthority, priceSource, migrationAuthority
        );

        // Same Stonkz-owned V2 factory as the testnets until a public V2 on
        // Arc is confirmed; graduation migrates into it and burns the LP.
        StonkzV2Factory v2Factory = new StonkzV2Factory();
        UniswapV2Migrator migrator =
            new UniswapV2Migrator(IUniswapV2Factory(address(v2Factory)), address(launchpad));

        launchpad.setMigrator(IGraduationMigrator(address(migrator)), migrationAuthority);
        launchpad.setMaxOracleStaleness(Arc.ORACLE_MAX_AGE_SECS);

        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(Arc.UNIVERSAL_ROUTER),
            StonkzLaunchpad(address(launchpad)),
            IWETH9(Arc.WRAPPED_NATIVE),
            ISwapRouter02(Arc.UNISWAP_V3_SWAP_ROUTER02),
            Arc.MAX_BUY_NATIVE
        );

        priceSource.pushPrice(Arc.WRAPPED_NATIVE, usdcUsd1e6, 0);
        priceSource.pushPrice(Arc.USDC_ERC20, usdcUsd1e6, 0);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Arc 5042 deployed (MAINNET, capped) ===");
        console2.log("PushPriceSource      :", address(priceSource));
        console2.log("StonkzLaunchpad      :", address(launchpad));
        console2.log("StonkzV2Factory      :", address(v2Factory));
        console2.log("UniswapV2Migrator    :", address(migrator));
        console2.log("StonkzRouter         :", address(router));
        console2.log("router.maxBuyNative  :", router.maxBuyNative());
        console2.log("deployer/admin       :", deployer);
        console2.log("");
        console2.log("=== apps/api + indexer env ===");
        console2.log("ARC_CHAIN_ID=5042");
        console2.log("ARC_LAUNCHPAD_ADDRESS=%s", address(launchpad));
        console2.log("ARC_ROUTER_ADDRESS=%s", address(router));
        console2.log("ARC_V3_FACTORY_ADDRESS=%s", Arc.UNISWAP_V3_FACTORY);
        console2.log("ARC_V3_QUOTER_ADDRESS=%s", Arc.UNISWAP_V3_QUOTER_V2);
        console2.log("BASE_MINT_OVERRIDES_ARC=USDC:%s", Arc.USDC_ERC20);
        console2.log("Then: record deployments/5042.json and run scripts/emit-chains.mjs");
    }

    function _requireCode(address a, string memory what) internal view {
        if (a.code.length == 0) {
            console2.log("DeployArc: no code at", what, a);
            revert("DeployArc: pinned dependency has no code");
        }
    }
}
