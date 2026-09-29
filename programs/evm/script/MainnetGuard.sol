// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";

/// @dev Mainnet deploys and upgrades must end — or already be — under the
/// multisig + timelock, with an instant pauser beside it. Testnets may skip
/// all of it; mainnet may not. Every deploy/upgrade script that can target a
/// mainnet chain calls `requireOnMainnet()` **before reading anything else**,
/// so a mainnet run with the governance env missing stops at the first line
/// with a message naming the missing variable.
///
/// Required on mainnet (4663 RH, 8453 Base, 5042 Arc):
///   `PROPOSERS` (the Safe; comma-separated, no zero entry),
///   `MIN_DELAY` (>= 24 h), `PAUSER`, `NEW_OPS_WITHDRAW_AUTHORITY`,
///   `NEW_MIGRATION_AUTHORITY`. `EXECUTORS` is optional (default `PROPOSERS`).
library MainnetGuard {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant MIN_MAINNET_DELAY = 24 hours;

    struct Governance {
        address[] proposers;
        address[] executors;
        uint256 minDelay;
        address pauser;
        address opsAuthority;
        address migrationAuthority;
    }

    function isMainnet() internal view returns (bool) {
        return isMainnet(block.chainid);
    }

    function isMainnet(uint256 id) internal pure returns (bool) {
        return id == 4663 || id == 8453 || id == 5042;
    }

    /// @notice The governance env, never reverting on a missing variable.
    function fromEnv() internal view returns (Governance memory g) {
        g.proposers = vm.envOr("PROPOSERS", ",", new address[](0));
        g.executors = vm.envOr("EXECUTORS", ",", g.proposers);
        g.minDelay = vm.envOr("MIN_DELAY", uint256(0));
        g.pauser = vm.envOr("PAUSER", address(0));
        g.opsAuthority = vm.envOr("NEW_OPS_WITHDRAW_AUTHORITY", address(0));
        g.migrationAuthority = vm.envOr("NEW_MIGRATION_AUTHORITY", address(0));
    }

    /// @notice On mainnet: read and validate the governance env (reverting
    /// with the name of whatever is missing). Elsewhere: whatever is set.
    function requireOnMainnet() internal view returns (Governance memory g) {
        g = fromEnv();
        if (isMainnet()) validate(g);
    }

    function validate(Governance memory g) internal pure {
        require(g.proposers.length > 0, "MainnetGuard: PROPOSERS (the Safe) is required on mainnet");
        for (uint256 i = 0; i < g.proposers.length; i++) {
            require(g.proposers[i] != address(0), "MainnetGuard: PROPOSERS has a zero address");
        }
        require(g.executors.length > 0, "MainnetGuard: EXECUTORS is empty");
        require(g.minDelay >= MIN_MAINNET_DELAY, "MainnetGuard: MIN_DELAY must be >= 86400 (24h) on mainnet");
        require(g.pauser != address(0), "MainnetGuard: PAUSER is required on mainnet");
        require(
            g.opsAuthority != address(0), "MainnetGuard: NEW_OPS_WITHDRAW_AUTHORITY is required on mainnet"
        );
        require(
            g.migrationAuthority != address(0), "MainnetGuard: NEW_MIGRATION_AUTHORITY is required on mainnet"
        );
    }

    /// @notice For upgrade scripts on mainnet: the launchpad must already be
    /// governed — admin a TimelockController with at least the mainnet delay,
    /// driven by `PROPOSERS`, with the authorities and pauser the env names.
    /// The script then prints timelock calldata instead of calling.
    function requireTimelockAdmin(StonkzLaunchpad pad, Governance memory g) internal view {
        address admin = pad.admin();
        require(
            admin.code.length > 0, "MainnetGuard: launchpad admin is an EOA; run GovernanceHandover first"
        );
        (bool ok, bytes memory ret) = admin.staticcall(abi.encodeCall(TimelockController.getMinDelay, ()));
        require(ok && ret.length == 32, "MainnetGuard: launchpad admin is not a TimelockController");
        require(abi.decode(ret, (uint256)) >= MIN_MAINNET_DELAY, "MainnetGuard: timelock delay is under 24h");
        TimelockController tl = TimelockController(payable(admin));
        for (uint256 i = 0; i < g.proposers.length; i++) {
            require(
                tl.hasRole(tl.PROPOSER_ROLE(), g.proposers[i]),
                "MainnetGuard: PROPOSERS is not the timelock's"
            );
        }
        require(
            pad.opsWithdrawAuthority() == g.opsAuthority,
            "MainnetGuard: NEW_OPS_WITHDRAW_AUTHORITY is not the launchpad's"
        );
        require(
            pad.migrationAuthority() == g.migrationAuthority,
            "MainnetGuard: NEW_MIGRATION_AUTHORITY is not the launchpad's"
        );
        (ok, ret) = address(pad).staticcall(abi.encodeWithSignature("pauser()"));
        if (ok && ret.length == 32) {
            require(abi.decode(ret, (address)) == g.pauser, "MainnetGuard: PAUSER is not the launchpad's");
        }
    }
}
