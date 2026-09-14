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
import {BaseSepolia} from "../src/config/BaseSepolia.sol";
import {StonkzV2Factory} from "../src/testnet/StonkzV2Factory.sol";
import {DeployPad} from "./DeployPad.sol";

/// @title Coinbase Base Sepolia (84532) deployment — Robinhood-parity EVM stack.
///
/// ```
/// export PRIVATE_KEY=0x...
/// export STONKZ_ADMIN=0x...                 # same as deployer on testnet
/// export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
/// export STONKZ_OPS_WITHDRAW_AUTHORITY=0x...  # must differ from protocol
/// forge script script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
///   --rpc-url https://sepolia.base.org --broadcast -vvv
/// ```
contract DeployBaseSepolia is Script {
    function run() external {
        require(BaseSepolia.isTestnet(), "DeployBaseSepolia: not chain 84532");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address admin = vm.envOr("STONKZ_ADMIN", deployer);
        address protocolWithdrawAuthority = vm.envAddress("STONKZ_PROTOCOL_WITHDRAW_AUTHORITY");
        address opsWithdrawAuthority = vm.envAddress("STONKZ_OPS_WITHDRAW_AUTHORITY");
        address migrationAuthority = vm.envOr("STONKZ_MIGRATION_AUTHORITY", admin);
        address oracleAuthority = vm.envOr("STONKZ_ORACLE_AUTHORITY", admin);

        require(admin == deployer, "DeployBaseSepolia: admin must be the broadcaster on testnet");
        require(protocolWithdrawAuthority != address(0), "zero protocol");
        require(opsWithdrawAuthority != address(0), "zero ops");
        require(
            protocolWithdrawAuthority != opsWithdrawAuthority,
            "protocol and ops withdraw authorities must differ"
        );

        _requireCode(BaseSepolia.WETH9, "WETH9");
        _requireCode(BaseSepolia.UNIVERSAL_ROUTER, "UniversalRouter");
        _requireCode(BaseSepolia.UNISWAP_V3_SWAP_ROUTER02, "SwapRouter02");

        uint256 ethUsd1e6 = vm.envOr("STONKZ_ETH_USD_1E6", uint256(3_000_000_000));
        uint256 usdcUsd1e6 = vm.envOr("STONKZ_USDC_USD_1E6", uint256(1_000_000));

        vm.startBroadcast(pk);

        PushPriceSource priceSource =
            DeployPad.pushOracle(admin, oracleAuthority, BaseSepolia.ORACLE_MAX_AGE_SECS);

        StonkzLaunchpad launchpad = DeployPad.launchpad(
            admin, protocolWithdrawAuthority, opsWithdrawAuthority, priceSource, migrationAuthority
        );

        // No public Uniswap V2 factory on Base Sepolia at the mainnet pin —
        // self-deploy the same Stonkz V2 factory used on RH 46630.
        StonkzV2Factory v2Factory = new StonkzV2Factory();
        UniswapV2Migrator migrator =
            new UniswapV2Migrator(IUniswapV2Factory(address(v2Factory)), address(launchpad));

        launchpad.setMigrator(IGraduationMigrator(address(migrator)), migrationAuthority);
        launchpad.setMaxOracleStaleness(BaseSepolia.ORACLE_MAX_AGE_SECS);

        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(BaseSepolia.UNIVERSAL_ROUTER),
            StonkzLaunchpad(address(launchpad)),
            IWETH9(BaseSepolia.WETH9),
            ISwapRouter02(BaseSepolia.UNISWAP_V3_SWAP_ROUTER02)
        );

        priceSource.pushPrice(BaseSepolia.WETH9, ethUsd1e6, 0);
        if (BaseSepolia.USDC.code.length > 0) {
            priceSource.pushPrice(BaseSepolia.USDC, usdcUsd1e6, 0);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Base Sepolia 84532 deployed ===");
        console2.log("PushPriceSource      :", address(priceSource));
        console2.log("StonkzLaunchpad      :", address(launchpad));
        console2.log("StonkzV2Factory      :", address(v2Factory));
        console2.log("UniswapV2Migrator    :", address(migrator));
        console2.log("StonkzRouter         :", address(router));
        console2.log("deployer/admin       :", deployer);
        console2.log("WETH9                :", BaseSepolia.WETH9);
        console2.log("USDC                 :", BaseSepolia.USDC);
        console2.log("UniversalRouter      :", BaseSepolia.UNIVERSAL_ROUTER);
        console2.log("SwapRouter02         :", BaseSepolia.UNISWAP_V3_SWAP_ROUTER02);
        console2.log("");
        console2.log("=== apps/api + indexer env ===");
        console2.log("BASE_CHAIN_ID=84532");
        console2.log("BASE_RPC_URL=https://sepolia.base.org");
        console2.log("BASE_LAUNCHPAD_ADDRESS=%s", address(launchpad));
        console2.log("BASE_ROUTER_ADDRESS=%s", address(router));
        console2.log("BASE_V3_FACTORY_ADDRESS=%s", BaseSepolia.UNISWAP_V3_FACTORY);
        console2.log("BASE_V3_QUOTER_ADDRESS=%s", BaseSepolia.UNISWAP_V3_QUOTER_V2);
        console2.log("BASE_V3_FEE_TIER_OVERRIDES=USDC:<fee>");
    }

    function _requireCode(address a, string memory what) internal view {
        if (a.code.length == 0) {
            console2.log("DeployBaseSepolia: no code at", what, a);
            revert("DeployBaseSepolia: pinned dependency has no code");
        }
    }
}
