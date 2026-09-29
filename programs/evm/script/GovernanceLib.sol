// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @dev The two-step admin surface shared by `StonkzLaunchpad`,
/// `ChainlinkPriceSource`, `PythPriceSource` and (after its handover upgrade)
/// `PushPriceSource`.
interface IAdmin2Step {
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function proposeAdmin(address a) external;
    function acceptAdmin() external;
}

interface IUUPS {
    function upgradeToAndCall(address impl, bytes calldata data) external payable;
}

/// @title The handover of every admin power to a multisig-driven timelock.
/// @dev Shared by `GovernanceHandover.s.sol` (existing deployments) and the
/// mainnet paths of `Deploy.s.sol` / `DeployArc.s.sol` (fresh deployments,
/// which must end with no EOA admin). `handover` performs calls and
/// deployments from the calling script, so it must run inside an active
/// `vm.startBroadcast` whose sender is `eoa`, the current admin.
library GovernanceLib {
    bytes32 internal constant SALT = keccak256("stonkz.governance-handover.v1");

    struct Config {
        address launchpad;
        /// Every price source whose admin must move: the launchpad's, and its
        /// fallback if it has one (a `PythPriceSource` over the old push oracle).
        address[] priceSources;
        address[] proposers;
        address[] executors;
        uint256 minDelay;
        address protocolAuthority;
        address opsAuthority;
        address migrationAuthority;
        address migrator;
        /// Emergency pauser, set on the launchpad and deliberately **not**
        /// behind the timelock: a stop must be instant.
        address pauser;
        bool atomic;
    }

    /// @notice The launchpad's price source, plus its `fallbackSource()` if it
    /// has one (a `PythPriceSource` over the previous push oracle).
    function defaultPriceSources(StonkzLaunchpad pad) internal view returns (address[] memory list) {
        address ps = address(pad.priceSource());
        (bool ok, bytes memory ret) = ps.staticcall(abi.encodeWithSignature("fallbackSource()"));
        address fb = ok && ret.length == 32 ? abi.decode(ret, (address)) : address(0);
        list = new address[](fb == address(0) ? 1 : 2);
        list[0] = ps;
        if (fb != address(0)) list[1] = fb;
    }

    function preflight(Config memory c, address eoa) internal view {
        StonkzLaunchpad pad = StonkzLaunchpad(c.launchpad);
        require(pad.admin() == eoa, "Governance: PRIVATE_KEY is not the launchpad admin");
        (bool ok, bytes memory ret) = c.launchpad.staticcall(abi.encodeWithSignature("pauser()"));
        require(
            ok && ret.length == 32,
            "Governance: launchpad implementation has no pauser; run UpgradeAtomicLaunch first"
        );
        require(c.priceSources.length > 0, "Governance: no price source");
        for (uint256 i = 0; i < c.priceSources.length; i++) {
            require(
                IAdmin2Step(c.priceSources[i]).admin() == eoa,
                "Governance: PRIVATE_KEY is not the price source admin"
            );
        }
        require(c.proposers.length > 0 && c.executors.length > 0, "Governance: PROPOSERS / EXECUTORS");
        require(c.minDelay > 0, "Governance: MIN_DELAY must be > 0");
        require(c.pauser != address(0), "Governance: PAUSER is required");
        require(
            c.opsAuthority != address(0) && c.migrationAuthority != address(0)
                && c.protocolAuthority != address(0),
            "Governance: zero authority"
        );
        for (uint256 i = 0; i < c.proposers.length; i++) {
            require(c.proposers[i] != address(0), "Governance: zero proposer");
            // The whole point is to take this key out of power.
            require(c.proposers[i] != eoa, "Governance: the admin EOA cannot be a proposer");
        }
        for (uint256 i = 0; i < c.executors.length; i++) {
            require(c.executors[i] != eoa, "Governance: the admin EOA cannot be an executor");
        }
        require(
            c.opsAuthority != eoa && c.migrationAuthority != eoa && c.pauser != eoa,
            "Governance: rotate away from the EOA"
        );
        if (MainnetGuard.isMainnet()) {
            require(c.atomic, "Governance: mainnet hands over atomically");
            MainnetGuard.validate(
                MainnetGuard.Governance(
                    c.proposers, c.executors, c.minDelay, c.pauser, c.opsAuthority, c.migrationAuthority
                )
            );
        }
    }

    /// @notice Everything, from inside the caller's broadcast as `eoa`.
    function handover(Config memory c, address eoa) internal returns (TimelockController timelock) {
        StonkzLaunchpad pad = StonkzLaunchpad(c.launchpad);

        // 1. Timelock. No admin role: it administers itself.
        if (c.atomic) {
            timelock = new TimelockController(0, _with(c.proposers, eoa), _with(c.executors, eoa), address(0));
        } else {
            timelock = new TimelockController(c.minDelay, c.proposers, c.executors, address(0));
        }

        // 2. Authorities and the pauser, while the EOA can still set them.
        pad.setWithdrawAuthorities(c.protocolAuthority, c.opsAuthority);
        pad.setMigrator(IGraduationMigrator(c.migrator), c.migrationAuthority);
        pad.setPauser(c.pauser);

        // 3. A pre-handover PushPriceSource has no two-step admin: add it.
        for (uint256 i = 0; i < c.priceSources.length; i++) {
            if (!_hasPendingAdmin(c.priceSources[i])) {
                IUUPS(c.priceSources[i]).upgradeToAndCall(address(new PushPriceSource()), "");
            }
        }

        // 4. Step one of every handover.
        pad.proposeAdmin(address(timelock));
        for (uint256 i = 0; i < c.priceSources.length; i++) {
            IAdmin2Step(c.priceSources[i]).proposeAdmin(address(timelock));
        }

        // 5. Step two, now (atomic) or by the multisig (propose).
        if (c.atomic) {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
                acceptanceBatch(c, timelock);
            timelock.scheduleBatch(targets, values, payloads, bytes32(0), SALT, 0);
            timelock.executeBatch(targets, values, payloads, bytes32(0), SALT);
            timelock.renounceRole(timelock.PROPOSER_ROLE(), eoa);
            timelock.renounceRole(timelock.CANCELLER_ROLE(), eoa);
            timelock.renounceRole(timelock.EXECUTOR_ROLE(), eoa);
        }
    }

    /// @notice The batch the timelock executes to take over. In `propose`
    /// mode the multisig schedules exactly this.
    function acceptanceBatch(Config memory c, TimelockController timelock)
        internal
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        uint256 k = c.priceSources.length;
        uint256 n = 1 + k + (c.atomic ? 1 : 0);
        targets = new address[](n);
        values = new uint256[](n);
        payloads = new bytes[](n);
        targets[0] = c.launchpad;
        payloads[0] = abi.encodeCall(IAdmin2Step.acceptAdmin, ());
        for (uint256 i = 0; i < k; i++) {
            targets[1 + i] = c.priceSources[i];
            payloads[1 + i] = abi.encodeCall(IAdmin2Step.acceptAdmin, ());
        }
        if (c.atomic) {
            // Created with a zero delay so the acceptance could run in this
            // broadcast; raise it to the real one in the same operation.
            targets[n - 1] = address(timelock);
            payloads[n - 1] = abi.encodeCall(TimelockController.updateDelay, (c.minDelay));
        }
    }

    function verify(Config memory c, address eoa, TimelockController tl) internal view {
        StonkzLaunchpad pad = StonkzLaunchpad(c.launchpad);
        require(pad.opsWithdrawAuthority() == c.opsAuthority, "ops authority not rotated");
        require(pad.protocolWithdrawAuthority() == c.protocolAuthority, "protocol authority");
        require(pad.migrationAuthority() == c.migrationAuthority, "migration authority not rotated");
        require(address(pad.migrator()) == c.migrator, "migrator");
        require(pad.pauser() == c.pauser, "pauser not set");
        for (uint256 i = 0; i < c.priceSources.length; i++) {
            IAdmin2Step ps = IAdmin2Step(c.priceSources[i]);
            require(ps.pendingAdmin() == (c.atomic ? address(0) : address(tl)), "ps pending");
            require(ps.admin() == (c.atomic ? address(tl) : eoa), "price source admin");
        }
        require(pad.pendingAdmin() == (c.atomic ? address(0) : address(tl)), "pad pending");
        require(tl.getMinDelay() == c.minDelay, "delay");
        for (uint256 i = 0; i < c.proposers.length; i++) {
            require(tl.hasRole(tl.PROPOSER_ROLE(), c.proposers[i]), "proposer");
            require(tl.hasRole(tl.CANCELLER_ROLE(), c.proposers[i]), "canceller");
        }
        require(!tl.hasRole(tl.PROPOSER_ROLE(), eoa), "eoa still proposer");
        require(!tl.hasRole(tl.CANCELLER_ROLE(), eoa), "eoa still canceller");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), eoa), "eoa still executor");
        require(!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), eoa), "eoa timelock admin");
        if (c.atomic) {
            require(pad.admin() == address(tl), "launchpad admin is not the timelock");
        } else {
            require(pad.admin() == eoa, "launchpad admin moved early");
        }
    }

    function report(Config memory c, TimelockController tl) internal pure {
        console2.log("TimelockController      ", address(tl));
        console2.log("minDelay (s)            ", c.minDelay);
        console2.log("launchpad               ", c.launchpad);
        for (uint256 i = 0; i < c.priceSources.length; i++) {
            console2.log("priceSource             ", c.priceSources[i]);
        }
        console2.log("protocolWithdraw        ", c.protocolAuthority);
        console2.log("opsWithdraw (rotated)   ", c.opsAuthority);
        console2.log("migration (rotated)     ", c.migrationAuthority);
        console2.log("pauser (not timelocked) ", c.pauser);
        if (c.atomic) {
            console2.log("mode: atomic - the timelock is admin of all of them now; the EOA holds no role.");
        } else {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
                acceptanceBatch(c, tl);
            console2.log("mode: propose - the EOA is still admin until the multisig runs, on the timelock:");
            console2.log("  1) scheduleBatch(targets, values, payloads, 0x0, SALT, minDelay):");
            console2.logBytes(
                abi.encodeCall(
                    TimelockController.scheduleBatch,
                    (targets, values, payloads, bytes32(0), SALT, c.minDelay)
                )
            );
            console2.log("  2) after minDelay, executeBatch(targets, values, payloads, 0x0, SALT):");
            console2.logBytes(
                abi.encodeCall(TimelockController.executeBatch, (targets, values, payloads, bytes32(0), SALT))
            );
        }
    }

    function _hasPendingAdmin(address source) private view returns (bool) {
        (bool ok, bytes memory ret) = source.staticcall(abi.encodeCall(IAdmin2Step.pendingAdmin, ()));
        return ok && ret.length == 32;
    }

    function _with(address[] memory xs, address x) private pure returns (address[] memory ys) {
        ys = new address[](xs.length + 1);
        for (uint256 i = 0; i < xs.length; i++) {
            ys[i] = xs[i];
        }
        ys[xs.length] = x;
    }
}
