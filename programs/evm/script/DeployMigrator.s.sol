// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {UniswapV2Migrator, IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {StonkzV2Factory} from "../src/testnet/StonkzV2Factory.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Deploy the griefing-proof `UniswapV2Migrator` (L-1) and swap it in
/// with the launchpad's admin `setMigrator`.
///
/// Factory:
/// - `V2_FACTORY` if set;
/// - else RH mainnet (4663): the canonical Uniswap V2 factory pin;
/// - else (testnets): a **new** `StonkzV2Factory`. The already-deployed one's
///   pairs have no `swap`/`sync`, which the new migrator needs; a new factory
///   is a fresh pair registry, so nothing already graduated is affected.
///
/// `MIGRATION_AUTHORITY` (optional) — defaults to the launchpad's current one.
///
/// ```
/// export PRIVATE_KEY=0x...            # launchpad admin
/// LAUNCHPAD_ADDRESS=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 EXPECT_CHAIN_ID=84532 \
///   forge script script/DeployMigrator.s.sol:DeployMigrator --rpc-url $BASE_SEPOLIA_RPC -vvv   # dry run
/// ```
/// If the signer is not the admin (post-governance), the migrator is still
/// deployed and the `setMigrator` calldata is printed for the timelock. On
/// mainnet that is the only mode: `MainnetGuard` requires the governance env
/// and a timelock admin first.
contract DeployMigrator is Script {
    function run() external returns (address migrator, address factory) {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "DeployMigrator: unexpected chain id");
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "DeployMigrator: set LAUNCHPAD_ADDRESS");
        return execute(
            proxy,
            vm.envUint("PRIVATE_KEY"),
            vm.envOr("V2_FACTORY", address(0)),
            vm.envOr("MIGRATION_AUTHORITY", StonkzLaunchpad(proxy).migrationAuthority()),
            gov
        );
    }

    /// @notice Deploy (and, if `pk` is the admin, install). Public so the test
    /// suite drives the exact code path the broadcast takes.
    function execute(
        address proxy,
        uint256 pk,
        address factory_,
        address authority,
        MainnetGuard.Governance memory gov
    ) public returns (address migrator, address factory) {
        require(proxy.code.length > 0, "DeployMigrator: no code at proxy");
        require(authority != address(0), "DeployMigrator: no migration authority");
        StonkzLaunchpad pad = StonkzLaunchpad(proxy);
        address me = vm.addr(pk);
        address admin = pad.admin();
        // Mainnet: already under the timelock, and only ever print its batch.
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, gov);
        bool direct = admin == me && !mainnet;

        factory = factory_;
        if (factory == address(0) && block.chainid == RobinhoodChain.MAINNET_CHAIN_ID) {
            factory = RobinhoodChain.UNISWAP_V2_FACTORY;
        }

        vm.startBroadcast(pk);
        if (factory == address(0)) {
            require(
                block.chainid != 4663 && block.chainid != 8453, "DeployMigrator: mainnet needs V2_FACTORY"
            );
            factory = address(new StonkzV2Factory());
        }
        migrator = address(new UniswapV2Migrator(IUniswapV2Factory(factory), proxy));
        if (direct) pad.setMigrator(IGraduationMigrator(migrator), authority);
        vm.stopBroadcast();

        require(factory.code.length > 0, "DeployMigrator: no code at factory");
        require(UniswapV2Migrator(migrator).launchpad() == proxy, "migrator not bound to proxy");

        console2.log("chain              ", block.chainid);
        console2.log("proxy              ", proxy);
        console2.log("V2 factory         ", factory);
        console2.log("NEW migrator       ", migrator);
        console2.log("migrationAuthority ", authority);
        if (direct) {
            require(address(pad.migrator()) == migrator && pad.migrationAuthority() == authority, "not set");
            console2.log("setMigrator done.");
        } else {
            console2.log("not calling the proxy (signer is not admin, or mainnet); admin is", admin);
            console2.log("schedule through the admin (timelock): target = proxy, value = 0, data =");
            console2.logBytes(abi.encodeCall(pad.setMigrator, (IGraduationMigrator(migrator), authority)));
        }
        console2.log("Next: record UniswapV2Migrator (and StonkzV2Factory) in deployments/<chainId>.json.");
    }
}
