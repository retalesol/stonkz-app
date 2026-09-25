// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../src/StonkzRouter.sol";
import {UniswapV2Migrator} from "../src/UniswapV2Migrator.sol";
import {ChainlinkPriceSource} from "../src/oracle/ChainlinkPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {DeployPad} from "./DeployPad.sol";

/// @title Robinhood Chain deployment for the Stonkz launchpad.
///
/// Ordering is forced by two immutables: `UniswapV2Migrator` and
/// `StonkzRouter` both take the launchpad address at construction, and the
/// launchpad in turn needs to be told about the migrator afterwards. So:
/// price source -> launchpad -> migrator -> `setMigrator` -> router.
///
/// Everything privileged is an explicit env var with **no default**. A
/// deployment that silently pointed the protocol treasury at the deployer key
/// because an env var was unset is exactly the class of mistake this refuses
/// to make; `vm.envAddress` reverts on a missing key.
///
/// Usage (see `docs/deployment.md` for the full runbook):
///
/// ```
/// forge script script/Deploy.s.sol:Deploy \
///   --rpc-url "$RH_RPC_URL" --broadcast --verify -vvv
/// ```
///
/// Dry-run first by omitting `--broadcast`. The script prints the exact
/// `apps/api` env lines to copy at the end.
contract Deploy is Script {
    /// @dev Sanity band for the ETH/USD answer, in 1e6 USD. An answer outside
    /// it is treated as no answer at all, which stops graduations rather than
    /// pricing them off a haywire feed. Wide enough to survive a real market,
    /// narrow enough to catch a feed returning a decimals-scaling artefact.
    uint128 internal constant ETH_MIN_USD_1E6 = 100e6; // $100
    uint128 internal constant ETH_MAX_USD_1E6 = 100_000e6; // $100,000

    /// @dev USDG is a dollar stablecoin; a reading outside this band means the
    /// feed or the peg is broken, and either way graduations should stop.
    uint128 internal constant USDG_MIN_USD_1E6 = 0.9e6;
    uint128 internal constant USDG_MAX_USD_1E6 = 1.1e6;

    function run() external {
        // Chain guard. This script pins Robinhood Chain addresses from
        // `RobinhoodChain.sol`; running it against any other chain would
        // deploy contracts wired to addresses that hold no code there.
        require(RobinhoodChain.isRobinhoodChain(), "Deploy: not Robinhood Chain (expected 4663/46630)");

        address admin = vm.envAddress("STONKZ_ADMIN");
        address protocolWithdrawAuthority = vm.envAddress("STONKZ_PROTOCOL_WITHDRAW_AUTHORITY");
        address opsWithdrawAuthority = vm.envAddress("STONKZ_OPS_WITHDRAW_AUTHORITY");
        address migrationAuthority = vm.envAddress("STONKZ_MIGRATION_AUTHORITY");

        require(admin != address(0), "Deploy: zero admin");
        require(protocolWithdrawAuthority != address(0), "Deploy: zero protocol authority");
        require(opsWithdrawAuthority != address(0), "Deploy: zero ops authority");
        require(migrationAuthority != address(0), "Deploy: zero migration authority");

        // The protocol treasury (20%) and the $STONKZ ops vault (10%) must not
        // share a key. They are structurally separate vaults on-chain
        // specifically so ops spend cannot reach protocol revenue; giving them
        // one signer throws that away off-chain.
        require(
            protocolWithdrawAuthority != opsWithdrawAuthority,
            "Deploy: protocol and ops withdraw authorities must differ"
        );

        // Verify the third-party addresses this deployment hard-depends on
        // actually hold code on the chain we are pointed at. A typo or a
        // chain-fork mismatch otherwise surfaces as an unexplained revert on a
        // user's first trade instead of here.
        _requireCode(RobinhoodChain.UNIVERSAL_ROUTER, "UniversalRouter");
        _requireCode(RobinhoodChain.UNISWAP_V2_FACTORY, "UniswapV2Factory");
        _requireCode(RobinhoodChain.WETH9, "WETH9");
        _requireCode(RobinhoodChain.CHAINLINK_ETH_USD, "Chainlink ETH/USD");

        vm.startBroadcast();

        // 1) Price source. Admin is the Stonkz admin, not the deployer, so the
        //    deployer key holds no lasting privilege.
        ChainlinkPriceSource priceSource = new ChainlinkPriceSource(admin);

        // 2) Feeds, at heartbeat + grace. `CHAINLINK_HEARTBEAT_SECS` is 24h on
        //    this chain; a mainnet-Ethereum-style short bound here makes
        //    graduation permanently unreachable.
        //
        //    Only callable while the deployer is still admin — it is not, since
        //    step 1 set `admin` directly. So these are queued for the admin to
        //    execute; printed as calldata at the end rather than attempted and
        //    reverted. See `docs/deployment.md` step 4.

        // 3) Launchpad (UUPS proxy). Migrator is wired in step 5, so pass zero here.
        StonkzLaunchpad launchpad = DeployPad.launchpad(
            admin,
            protocolWithdrawAuthority,
            opsWithdrawAuthority,
            IPriceSource(address(priceSource)),
            address(0)
        );

        // 4) Migrator. Takes the launchpad as its only permitted caller, and
        //    burns 100% of minted LP with no withdrawal path of its own.
        UniswapV2Migrator migrator =
            new UniswapV2Migrator(IUniswapV2Factory(RobinhoodChain.UNISWAP_V2_FACTORY), address(launchpad));

        // 5) Router. Both of its targets are immutable at construction.
        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(RobinhoodChain.UNIVERSAL_ROUTER),
            StonkzLaunchpad(address(launchpad)),
            IWETH9(RobinhoodChain.WETH9),
            ISwapRouter02(RobinhoodChain.UNISWAP_V3_SWAP_ROUTER02),
            0 // no per-buy cap
        );

        vm.stopBroadcast();

        _report(address(priceSource), address(launchpad), address(migrator), address(router), migrationAuthority);
    }

    function _requireCode(address a, string memory what) internal view {
        if (a.code.length == 0) {
            console2.log("Deploy: no code at pinned address for", what);
            console2.log("  address:", a);
            revert("Deploy: pinned dependency has no code on this chain");
        }
    }

    /// @dev Everything the admin must still do, and everything the API must be
    /// configured with. Printed rather than executed because the admin key is
    /// deliberately not the deployer key.
    function _report(
        address priceSource,
        address launchpad,
        address migrator,
        address router,
        address migrationAuthority
    ) internal view {
        console2.log("");
        console2.log("=== Deployed (chain %s) ===", block.chainid);
        console2.log("ChainlinkPriceSource :", priceSource);
        console2.log("StonkzLaunchpad      :", launchpad);
        console2.log("UniswapV2Migrator    :", migrator);
        console2.log("StonkzRouter         :", router);

        console2.log("");
        console2.log("=== Admin must execute (admin key, not deployer) ===");
        console2.log("1) ChainlinkPriceSource.setFeed(WETH9, ETH/USD, %s, ...)", RobinhoodChain.ORACLE_MAX_AGE_SECS);
        console2.log("   baseToken :", RobinhoodChain.WETH9);
        console2.log("   aggregator:", RobinhoodChain.CHAINLINK_ETH_USD);
        console2.log("   minPrice1e6 / maxPrice1e6:", ETH_MIN_USD_1E6, ETH_MAX_USD_1E6);
        console2.log("2) ChainlinkPriceSource.setFeed(USDG, USDG/USD, ...)");
        console2.log("   baseToken :", RobinhoodChain.USDG);
        console2.log("   aggregator:", RobinhoodChain.CHAINLINK_USDG_USD);
        console2.log("   minPrice1e6 / maxPrice1e6:", USDG_MIN_USD_1E6, USDG_MAX_USD_1E6);
        console2.log("3) StonkzLaunchpad.setMigrator(migrator, migrationAuthority)");
        console2.log("   migrator          :", migrator);
        console2.log("   migrationAuthority:", migrationAuthority);
        console2.log("4) StonkzLaunchpad.setMaxOracleStaleness(%s)", RobinhoodChain.ORACLE_MAX_AGE_SECS);
        console2.log("   NOT a minute-scale value. 24h heartbeat + 1h grace.");

        console2.log("");
        console2.log("=== apps/api env ===");
        console2.log("RH_LAUNCHPAD_ADDRESS=", launchpad);
        console2.log("RH_ROUTER_ADDRESS=", router);
        console2.log("RH_V3_FEE_TIER_OVERRIDES=  # per aggregator-hop base asset; see docs/deployment.md");

        console2.log("");
        console2.log("=== apps/indexer env ===");
        console2.log("INDEXER_RH_LAUNCHPAD_ADDRESS=", launchpad);
        console2.log("INDEXER_RH_ROUTER_ADDRESS=", router);
    }
}
