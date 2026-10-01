// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {FeeLocker, ILaunchpadMigrator} from "../src/FeeLocker.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {UniswapV3Migrator} from "../src/UniswapV3Migrator.sol";
import {IUniswapV3Factory} from "../src/oracle/uniswap/IUniswapV3.sol";
import {Arc} from "../src/config/Arc.sol";
import {MainnetGuard} from "./MainnetGuard.sol";
import {RouterWiring} from "./RouterWiring.sol";

/// @title Deploy `FeeLocker` + `UniswapV3Migrator` and install the migrator
/// with the launchpad's admin `setMigrator`.
///
/// Run **after** the launchpad implementation that has `accrueExternalFees`
/// is live (`UpgradeStockLaunch` with `KEEP_ROUTER=1`): the script checks for
/// the selector and refuses otherwise, because a locker whose `claimFees`
/// cannot reach the ledgers would strand collected fees in a revert.
///
/// Env:
/// - `LAUNCHPAD_ADDRESS` (or `RH_LAUNCHPAD_ADDRESS`), `PRIVATE_KEY`;
/// - `V3_FACTORY` — defaults to the chain's pin (`RouterWiring.v3`: RH
///   4663/46630, Base 8453/84532; Arc 5042 once pinned); required anywhere else;
/// - `V3_FEE` — pool fee tier, default the chain's `GRADUATION_POOL_FEE`
///   (10000 = 1%); must be enabled on the factory;
/// - `FEE_LOCKER` — reuse an existing locker (must be bound to this proxy)
///   instead of deploying one, e.g. when swapping the migrator;
/// - `MIGRATION_AUTHORITY` — defaults to the launchpad's current one;
/// - `EXPECT_CHAIN_ID` — optional guard.
///
/// ```
/// export PRIVATE_KEY=0x...            # launchpad admin (testnet)
/// LAUNCHPAD_ADDRESS=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 EXPECT_CHAIN_ID=84532 \
///   forge script script/DeployV3Migrator.s.sol:DeployV3Migrator --rpc-url $BASE_SEPOLIA_RPC -vvv   # dry run
/// ```
/// If the signer is not the admin (post-governance), both contracts are
/// still deployed and the `setMigrator` calldata is printed for the timelock.
/// On mainnet that is the only mode: `MainnetGuard` requires the governance
/// env and a timelock admin first.
contract DeployV3Migrator is Script {
    struct Result {
        address locker;
        address migrator;
        address factory;
        uint24 fee;
        bool installed;
    }

    function run() external returns (Result memory) {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "DeployV3Migrator: unexpected chain id");
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "DeployV3Migrator: set LAUNCHPAD_ADDRESS");
        (, uint24 defaultFee) = RouterWiring.v3();
        return execute(
            proxy,
            vm.envUint("PRIVATE_KEY"),
            vm.envOr("V3_FACTORY", defaultFactory()),
            uint24(vm.envOr("V3_FEE", uint256(defaultFee == 0 ? 10_000 : defaultFee))),
            vm.envOr("FEE_LOCKER", address(0)),
            vm.envOr("MIGRATION_AUTHORITY", StonkzLaunchpad(proxy).migrationAuthority()),
            gov
        );
    }

    /// The canonical Uniswap V3 factory for chains this repo pins; zero elsewhere.
    function defaultFactory() public view returns (address factory) {
        (factory,) = RouterWiring.v3();
        if (factory == address(0) && block.chainid == Arc.CHAIN_ID) factory = Arc.UNISWAP_V3_FACTORY;
    }

    /// @notice Deploy (and, if `pk` is the admin on a testnet, install). Public
    /// so the test suite drives the exact code path the broadcast takes.
    function execute(
        address proxy,
        uint256 pk,
        address factory,
        uint24 fee,
        address existingLocker,
        address authority,
        MainnetGuard.Governance memory gov
    ) public returns (Result memory r) {
        require(proxy.code.length > 0, "DeployV3Migrator: no code at proxy");
        require(factory.code.length > 0, "DeployV3Migrator: set V3_FACTORY (no code at factory)");
        require(authority != address(0), "DeployV3Migrator: no migration authority");
        require(
            IUniswapV3Factory(factory).feeAmountTickSpacing(fee) > 0,
            "DeployV3Migrator: V3_FEE is not an enabled fee tier"
        );
        require(
            hasAccrueExternalFees(proxy),
            "DeployV3Migrator: upgrade the launchpad first (no accrueExternalFees)"
        );

        StonkzLaunchpad pad = StonkzLaunchpad(proxy);
        address me = vm.addr(pk);
        address admin = pad.admin();
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, gov);
        bool direct = admin == me && !mainnet;

        vm.startBroadcast(pk);
        r.locker = existingLocker;
        if (r.locker == address(0)) r.locker = address(new FeeLocker(ILaunchpadMigrator(proxy)));
        r.migrator =
            address(new UniswapV3Migrator(IUniswapV3Factory(factory), proxy, FeeLocker(r.locker), fee));
        if (direct) pad.setMigrator(IGraduationMigrator(r.migrator), authority);
        vm.stopBroadcast();

        r.factory = factory;
        r.fee = fee;
        require(address(FeeLocker(r.locker).launchpad()) == proxy, "locker not bound to proxy");
        require(UniswapV3Migrator(r.migrator).launchpad() == proxy, "migrator not bound to proxy");
        require(address(UniswapV3Migrator(r.migrator).locker()) == r.locker, "migrator not bound to locker");

        console2.log("chain              ", block.chainid);
        console2.log("proxy              ", proxy);
        console2.log("V3 factory         ", factory);
        console2.log("pool fee tier      ", uint256(fee));
        console2.log("FeeLocker          ", r.locker);
        console2.log("NEW migrator (V3)  ", r.migrator);
        console2.log("migrationAuthority ", authority);
        if (direct) {
            r.installed = true;
            require(address(pad.migrator()) == r.migrator && pad.migrationAuthority() == authority, "not set");
            console2.log("setMigrator done.");
        } else {
            console2.log("not calling the proxy (signer is not admin, or mainnet); admin is", admin);
            console2.log("schedule through the admin (timelock): target = proxy, value = 0, data =");
            console2.logBytes(abi.encodeCall(pad.setMigrator, (IGraduationMigrator(r.migrator), authority)));
        }
        console2.log("Next: record FeeLocker + UniswapV3Migrator in deployments/<chainId>.json;");
        console2.log("      the API discovers the locker from the chain (launchpad.migrator().locker()).");
    }

    /// @dev The selector exists iff the call reverts with the auth string
    /// rather than falling through to an empty revert.
    function hasAccrueExternalFees(address proxy) public returns (bool) {
        (bool ok, bytes memory ret) = proxy.call(
            abi.encodeWithSelector(
                StonkzLaunchpad.accrueExternalFees.selector, address(0), uint256(0), uint256(0)
            )
        );
        if (ok) return true;
        if (ret.length < 4) return false;
        // Error(string) with "not migrator".
        bytes memory want = abi.encodeWithSignature("Error(string)", "not migrator");
        return keccak256(ret) == keccak256(want);
    }
}
