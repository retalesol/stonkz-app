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
import {Arc} from "../src/config/Arc.sol";
import {StonkzV2Factory} from "../src/testnet/StonkzV2Factory.sol";
import {DeployPad} from "./DeployPad.sol";
import {GovernanceLib} from "./GovernanceLib.sol";
import {MainnetGuard} from "./MainnetGuard.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title Circle Arc (5042) deployment — mainnet, capped.
///
/// Arc has no public testnet any more, so this is a real-funds deployment run
/// with a fresh key (the RH/Base testnet deployer is burned — see
/// `deployments/46630.json`). The router is deployed with `Arc.MAX_BUY_NATIVE`
/// so no single buy can exceed 25 USDC regardless of what the API or UI do.
///
/// ```
/// export PRIVATE_KEY=0x...                       # fresh key, funded with USDC on Arc; admin only during the broadcast
/// export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
/// # governance (MainnetGuard; Arc is mainnet):
/// export PROPOSERS=0xSAFE MIN_DELAY=86400 PAUSER=0x...
/// export NEW_OPS_WITHDRAW_AUTHORITY=0x...        # must differ from protocol
/// export NEW_MIGRATION_AUTHORITY=0x...
/// export STONKZ_ORACLE_AUTHORITY=0x...           # optional price pusher; default: the deployer
/// forge script script/DeployArc.s.sol:DeployArc \
///   --rpc-url $ARC_RPC_URL --broadcast -vvv
/// ```
contract DeployArc is Script {
    function run() external {
        require(Arc.isArc(), "DeployArc: not chain 5042");
        // Arc is mainnet: the governance env is checked before anything else.
        MainnetGuard.Governance memory g = MainnetGuard.requireOnMainnet();
        require(Arc.pinned(), "DeployArc: fill in src/config/Arc.sol first (placeholders are zero)");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address protocolWithdrawAuthority = vm.envAddress("STONKZ_PROTOCOL_WITHDRAW_AUTHORITY");
        address oracleAuthority = vm.envOr("STONKZ_ORACLE_AUTHORITY", deployer);

        require(protocolWithdrawAuthority != address(0), "zero protocol");
        require(
            protocolWithdrawAuthority != g.opsAuthority, "protocol and ops withdraw authorities must differ"
        );

        _requireCode(Arc.WRAPPED_NATIVE, "WRAPPED_NATIVE");
        _requireCode(Arc.USDC_ERC20, "USDC_ERC20");
        _requireCode(Arc.UNIVERSAL_ROUTER, "UniversalRouter");
        _requireCode(Arc.UNISWAP_V3_SWAP_ROUTER02, "SwapRouter02");

        // USDC is the unit of account: both faces are one dollar.
        uint256 usdcUsd1e6 = 1_000_000;

        vm.startBroadcast(pk);

        // The deployer is admin (and oracle authority) only for this broadcast.
        PushPriceSource priceSource = DeployPad.pushOracle(deployer, deployer, Arc.ORACLE_MAX_AGE_SECS);

        StonkzLaunchpad launchpad = DeployPad.launchpad(
            deployer, protocolWithdrawAuthority, g.opsAuthority, priceSource, g.migrationAuthority
        );

        // Same Stonkz-owned V2 factory as the testnets until a public V2 on
        // Arc is confirmed; graduation migrates into it and burns the LP.
        StonkzV2Factory v2Factory = new StonkzV2Factory();
        UniswapV2Migrator migrator =
            new UniswapV2Migrator(IUniswapV2Factory(address(v2Factory)), address(launchpad));

        launchpad.setMigrator(IGraduationMigrator(address(migrator)), g.migrationAuthority);
        launchpad.setMaxOracleStaleness(Arc.ORACLE_MAX_AGE_SECS);

        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(Arc.UNIVERSAL_ROUTER),
            StonkzLaunchpad(address(launchpad)),
            IWETH9(Arc.WRAPPED_NATIVE),
            ISwapRouter02(Arc.UNISWAP_V3_SWAP_ROUTER02),
            Arc.MAX_BUY_NATIVE,
            IPyth(address(0)), // no Pyth pin on Arc
            IStockAttestationSink(address(0))
        );
        // The implementation that trusts this router for atomic launches.
        launchpad.upgradeToAndCall(address(new StonkzLaunchpad(address(router))), "");

        priceSource.pushPrice(Arc.WRAPPED_NATIVE, usdcUsd1e6, 0);
        priceSource.pushPrice(Arc.USDC_ERC20, usdcUsd1e6, 0);
        if (oracleAuthority != deployer) priceSource.setOracleAuthority(oracleAuthority);

        // Every admin power to the timelock; the pauser beside it.
        GovernanceLib.Config memory c;
        c.launchpad = address(launchpad);
        c.priceSources = new address[](1);
        c.priceSources[0] = address(priceSource);
        c.proposers = g.proposers;
        c.executors = g.executors;
        c.minDelay = g.minDelay;
        c.protocolAuthority = protocolWithdrawAuthority;
        c.opsAuthority = g.opsAuthority;
        c.migrationAuthority = g.migrationAuthority;
        c.migrator = address(migrator);
        c.pauser = g.pauser;
        c.atomic = true;
        GovernanceLib.preflight(c, deployer);
        TimelockController timelock = GovernanceLib.handover(c, deployer);

        vm.stopBroadcast();

        GovernanceLib.verify(c, deployer, timelock);

        console2.log("");
        console2.log("=== Arc 5042 deployed (MAINNET, capped, governed) ===");
        console2.log("PushPriceSource      :", address(priceSource));
        console2.log("StonkzLaunchpad      :", address(launchpad));
        console2.log("StonkzV2Factory      :", address(v2Factory));
        console2.log("UniswapV2Migrator    :", address(migrator));
        console2.log("StonkzRouter         :", address(router));
        console2.log("router.maxBuyNative  :", router.maxBuyNative());
        console2.log("oracle authority     :", oracleAuthority);
        GovernanceLib.report(c, timelock);
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
