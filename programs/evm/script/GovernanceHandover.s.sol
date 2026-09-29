// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {GovernanceLib} from "./GovernanceLib.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Move every admin power off the single EOA onto a TimelockController
/// driven by a multisig, and rotate the ops-withdraw and migration authorities.
///
/// Signed by the **current admin EOA** (`PRIVATE_KEY`). The logic lives in
/// `GovernanceLib`, shared with the mainnet paths of the deploy scripts. The
/// launchpad must already run an implementation with `pauser`
/// (`UpgradeAtomicLaunch`). In order:
///
///  1. Deploy an OpenZeppelin `TimelockController` (`lib/openzeppelin-contracts`,
///     v5.7) with `PROPOSERS` (the Safe; also made cancellers), `EXECUTORS`,
///     and no admin role — the timelock administers itself.
///  2. Launchpad: `setWithdrawAuthorities(PROTOCOL, NEW_OPS)`,
///     `setMigrator(MIGRATOR, NEW_MIGRATION)`, `setPauser(PAUSER)` — the
///     pauser is deliberately *not* behind the timelock, so a stop is instant.
///  3. Price sources (the launchpad's and, for a `PythPriceSource`, its
///     fallback): a `PushPriceSource` from before the two-step admin existed
///     is upgraded (append-only) so it has one.
///  4. `proposeAdmin(timelock)` on the launchpad and every price source.
///  5. Acceptance — `HANDOVER_MODE`:
///     - `atomic` (default): the timelock is created with a zero delay and
///       this EOA as a temporary proposer/executor; in the same broadcast it
///       schedules and executes `[launchpad.acceptAdmin(),
///       priceSource.acceptAdmin()..., timelock.updateDelay(MIN_DELAY)]`, then
///       the EOA renounces every timelock role. The EOA is out of power when
///       the broadcast lands — no window in which a leaked key is still admin.
///     - `propose`: the timelock is created with `MIN_DELAY` and only the env
///       roles. The EOA stays admin until the multisig schedules and, after
///       `MIN_DELAY`, executes the same acceptance batch (calldata printed;
///       see `docs/governance-handover.md`).
///
/// Env: `PRIVATE_KEY`, `LAUNCHPAD_ADDRESS`, `EXPECT_CHAIN_ID` (optional guard),
/// `PROPOSERS` (comma-separated), `EXECUTORS` (comma-separated; default =
/// `PROPOSERS`; `0x0000000000000000000000000000000000000000` = anyone),
/// `MIN_DELAY` (seconds; >= 24h on mainnet), `NEW_OPS_WITHDRAW_AUTHORITY`,
/// `NEW_MIGRATION_AUTHORITY`, `PAUSER` (required: a hot ops key or a separate
/// 1-of-N Safe),
/// optional `PROTOCOL_WITHDRAW_AUTHORITY` (default: unchanged), `MIGRATOR`
/// (default: unchanged), `PRICE_SOURCES` (comma-separated; default: the
/// launchpad's and its fallback),
/// `HANDOVER_MODE` (`atomic` | `propose`).
contract GovernanceHandover is Script {
    bytes32 public constant SALT = GovernanceLib.SALT;

    function run() external returns (TimelockController timelock) {
        MainnetGuard.requireOnMainnet(); // first: a mainnet run without the env stops here
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "Governance: unexpected chain id");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        timelock = execute(configFromEnv(), pk);
    }

    function configFromEnv() public view returns (GovernanceLib.Config memory c) {
        c.launchpad = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(c.launchpad.code.length > 0, "Governance: set LAUNCHPAD_ADDRESS");
        StonkzLaunchpad pad = StonkzLaunchpad(c.launchpad);
        c.priceSources = vm.envOr("PRICE_SOURCES", ",", GovernanceLib.defaultPriceSources(pad));
        c.proposers = vm.envAddress("PROPOSERS", ",");
        c.executors = vm.envOr("EXECUTORS", ",", c.proposers);
        c.minDelay = vm.envUint("MIN_DELAY");
        c.protocolAuthority = vm.envOr("PROTOCOL_WITHDRAW_AUTHORITY", pad.protocolWithdrawAuthority());
        c.opsAuthority = vm.envAddress("NEW_OPS_WITHDRAW_AUTHORITY");
        c.migrationAuthority = vm.envAddress("NEW_MIGRATION_AUTHORITY");
        c.migrator = vm.envOr("MIGRATOR", address(pad.migrator()));
        c.pauser = vm.envAddress("PAUSER");
        string memory mode = vm.envOr("HANDOVER_MODE", string("atomic"));
        c.atomic = keccak256(bytes(mode)) == keccak256("atomic");
        require(c.atomic || keccak256(bytes(mode)) == keccak256("propose"), "Governance: HANDOVER_MODE");
    }

    function defaultPriceSources(StonkzLaunchpad pad) public view returns (address[] memory) {
        return GovernanceLib.defaultPriceSources(pad);
    }

    function acceptanceBatch(GovernanceLib.Config memory c, TimelockController timelock)
        public
        pure
        returns (address[] memory, uint256[] memory, bytes[] memory)
    {
        return GovernanceLib.acceptanceBatch(c, timelock);
    }

    /// @notice Everything, signed by `pk` (the current admin). Public so the
    /// test suite drives the exact code path the broadcast takes.
    function execute(GovernanceLib.Config memory c, uint256 pk) public returns (TimelockController timelock) {
        address eoa = vm.addr(pk);
        GovernanceLib.preflight(c, eoa);
        vm.startBroadcast(pk);
        timelock = GovernanceLib.handover(c, eoa);
        vm.stopBroadcast();
        GovernanceLib.verify(c, eoa, timelock);
        GovernanceLib.report(c, timelock);
    }
}
