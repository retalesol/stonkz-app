// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {GovernanceHandover} from "../script/GovernanceHandover.s.sol";
import {GovernanceLib} from "../script/GovernanceLib.sol";
import {LegacyPushPriceSource} from "./mocks/LegacyPushPriceSource.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @notice The single-EOA admin (also ops-withdraw and migration authority)
/// hands every power to a TimelockController driven by a multisig, through
/// `script/GovernanceHandover.s.sol` — the same code path the broadcast runs.
contract GovernanceTest is Test {
    uint256 constant EOA_KEY = 0xE0A11CE; // test-only key standing in for the live admin EOA
    address eoa;
    address safe = address(0x5AFE);
    address protocolCold = address(0xC01D1);
    address newOps = address(0x0B5);
    address newMigration = address(0x316);
    address oracleAuth = address(0x0AC1E);
    address migrator = address(0x1316);
    address pauser = address(0x9A05E);
    uint256 constant DELAY = 2 days;

    StonkzLaunchpad pad;
    address oracle;
    GovernanceHandover script;

    function setUp() public {
        vm.warp(1_800_000_000);
        eoa = vm.addr(EOA_KEY);
        // The price source as it is live today: the pre-handover implementation.
        LegacyPushPriceSource legacy = new LegacyPushPriceSource();
        oracle = address(
            new ERC1967Proxy(
                address(legacy), abi.encodeCall(LegacyPushPriceSource.initialize, (eoa, oracleAuth, 90_000))
            )
        );
        // Admin, ops-withdraw and migration authority all on one EOA, as live.
        pad = DeployPad.launchpad(eoa, protocolCold, eoa, IPriceSource(oracle), eoa);
        vm.prank(oracleAuth);
        PushPriceSource(oracle).pushPrice(address(0xBA5E), 3_000e6, 0);
        script = new GovernanceHandover();
    }

    function _config(bool atomic) internal view returns (GovernanceLib.Config memory c) {
        c.launchpad = address(pad);
        c.priceSources = new address[](1);
        c.priceSources[0] = oracle;
        c.proposers = new address[](1);
        c.proposers[0] = safe;
        c.executors = new address[](1);
        c.executors[0] = safe;
        c.minDelay = DELAY;
        c.protocolAuthority = protocolCold;
        c.opsAuthority = newOps;
        c.migrationAuthority = newMigration;
        c.migrator = migrator;
        c.pauser = pauser;
        c.atomic = atomic;
    }

    /// Everything the old EOA could do as admin, and must no longer.
    function _assertEoaHasNoPower(TimelockController tl) internal {
        address newPadImpl = address(new StonkzLaunchpad(address(0)));
        address newPsImpl = address(new PushPriceSource());
        bytes32 proposerRole = tl.PROPOSER_ROLE();
        IGraduationMigrator currentMigrator = pad.migrator();
        vm.startPrank(eoa);
        vm.expectRevert(bytes("not admin"));
        pad.setPause(true, true, true, true, true);
        vm.expectRevert(bytes("not admin"));
        pad.upgradeToAndCall(newPadImpl, "");
        vm.expectRevert(bytes("not admin"));
        pad.proposeAdmin(eoa);
        vm.expectRevert(bytes("not admin"));
        pad.setMigrator(currentMigrator, eoa);
        vm.expectRevert(bytes("not admin"));
        pad.setWithdrawAuthorities(eoa, eoa);
        vm.expectRevert(bytes("not admin"));
        PushPriceSource(oracle).setOracleAuthority(eoa);
        vm.expectRevert(bytes("not admin"));
        PushPriceSource(oracle).upgradeToAndCall(newPsImpl, "");
        // Nor through the timelock.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, eoa, proposerRole
            )
        );
        tl.schedule(
            address(pad), 0, abi.encodeCall(pad.setPause, (true, true, true, true, true)), 0, 0, DELAY
        );
        // And the rotated authorities are gone from it too.
        vm.expectRevert(bytes("not migration authority"));
        pad.migrateLiquidity(address(1));
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(1, address(0xBA5E), 1, eoa);
        vm.stopPrank();
    }

    /// The multisig can govern through the timelock, and only after the delay.
    function _assertSafeGovernsWithDelay(TimelockController tl) internal {
        bytes memory pause = abi.encodeCall(pad.setPause, (false, true, false, false, false));
        vm.prank(safe);
        tl.schedule(address(pad), 0, pause, 0, bytes32("p"), DELAY);
        vm.prank(safe);
        vm.expectRevert(); // TimelockUnexpectedOperationState: not ready
        tl.execute(address(pad), 0, pause, 0, bytes32("p"));
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        tl.execute(address(pad), 0, pause, 0, bytes32("p"));
        assertTrue(pad.launchPaused(), "the timelock governs the launchpad");
        // A shorter delay than MIN_DELAY is refused outright.
        vm.prank(safe);
        vm.expectRevert();
        tl.schedule(address(pad), 0, pause, 0, bytes32("q"), DELAY - 1);
    }

    function test_AtomicHandoverLeavesTheEoaWithNothing() public {
        TimelockController tl = script.execute(_config(true), EOA_KEY);

        assertEq(pad.admin(), address(tl), "launchpad admin is the timelock");
        assertEq(pad.pendingAdmin(), address(0));
        assertEq(PushPriceSource(oracle).admin(), address(tl), "price source admin is the timelock");
        assertEq(tl.getMinDelay(), DELAY, "real delay in force");
        assertEq(pad.opsWithdrawAuthority(), newOps, "ops-withdraw rotated");
        assertEq(pad.migrationAuthority(), newMigration, "migration rotated");
        assertEq(pad.protocolWithdrawAuthority(), protocolCold, "protocol authority unchanged");
        assertEq(address(pad.migrator()), migrator);
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), safe));
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), eoa));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), eoa));
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), eoa));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), eoa));
        assertTrue(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(tl)), "self-administered");

        // The price source kept its data through its handover upgrade.
        (uint256 price,,) = PushPriceSource(oracle).priceUsd1e6(address(0xBA5E));
        assertEq(price, 3_000e6);
        assertEq(PushPriceSource(oracle).oracleAuthority(), oracleAuth);

        _assertEoaHasNoPower(tl);
        _assertSafeGovernsWithDelay(tl);
        _assertPauserIsInstantAndTimelockUnpauses(tl);
    }

    /// The pauser stops the launchpad at once — no timelock — and only the
    /// timelock (after its delay) can start it again.
    function _assertPauserIsInstantAndTimelockUnpauses(TimelockController tl) internal {
        assertEq(pad.pauser(), pauser, "pauser set by the handover");
        vm.prank(pauser);
        pad.pause(true, true, true, true, true);
        assertTrue(pad.tradingPaused() && pad.launchPaused(), "instant");
        vm.prank(pauser);
        vm.expectRevert(bytes("not admin"));
        pad.setPause(false, false, false, false, false);

        bytes memory unpause = abi.encodeCall(pad.setPause, (false, false, false, false, false));
        vm.prank(safe);
        tl.schedule(address(pad), 0, unpause, 0, bytes32("u"), DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        tl.execute(address(pad), 0, unpause, 0, bytes32("u"));
        assertFalse(pad.tradingPaused() || pad.launchPaused(), "the timelock unpaused");
    }

    /// The two-step handover as the task describes it: the multisig accepts.
    function test_ProposeModeTheMultisigAccepts() public {
        GovernanceLib.Config memory c = _config(false);
        TimelockController tl = script.execute(c, EOA_KEY);

        // Nothing has moved yet except the proposals.
        assertEq(pad.admin(), eoa);
        assertEq(pad.pendingAdmin(), address(tl));
        assertEq(PushPriceSource(oracle).pendingAdmin(), address(tl));

        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            script.acceptanceBatch(c, tl);
        bytes32 salt = script.SALT();
        vm.prank(safe);
        tl.scheduleBatch(targets, values, payloads, 0, salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        tl.executeBatch(targets, values, payloads, 0, salt);

        assertEq(pad.admin(), address(tl));
        assertEq(PushPriceSource(oracle).admin(), address(tl));
        _assertEoaHasNoPower(tl);
        _assertSafeGovernsWithDelay(tl);
    }

    /// After the Pyth rollout the launchpad's source is a `PythPriceSource`
    /// with the old push oracle behind it: both move to the timelock.
    function test_HandsOverAPythSourceAndItsFallback() public {
        PythPriceSource pythSource = new PythPriceSource(eoa, IPyth(address(new MockPyth(0))));
        vm.startPrank(eoa);
        pythSource.setFallbackSource(IPriceSource(oracle));
        pad.setPriceSource(pythSource);
        vm.stopPrank();

        GovernanceLib.Config memory c = _config(true);
        c.priceSources = script.defaultPriceSources(pad);
        assertEq(c.priceSources.length, 2);
        assertEq(c.priceSources[0], address(pythSource));
        assertEq(c.priceSources[1], oracle);

        TimelockController tl = script.execute(c, EOA_KEY);
        assertEq(pad.admin(), address(tl));
        assertEq(pythSource.admin(), address(tl));
        assertEq(PushPriceSource(oracle).admin(), address(tl));
        vm.prank(eoa);
        vm.expectRevert(bytes("not admin"));
        pythSource.setFallbackSource(IPriceSource(address(0)));
    }

    /// Only the timelock can accept; nobody can accept for it.
    function test_OnlyThePendingAdminCanAccept() public {
        TimelockController tl = script.execute(_config(false), EOA_KEY);
        vm.prank(safe);
        vm.expectRevert(bytes("not pending"));
        pad.acceptAdmin();
        vm.prank(eoa);
        vm.expectRevert(bytes("not pending"));
        PushPriceSource(oracle).acceptAdmin();
        assertEq(pad.pendingAdmin(), address(tl));
    }

    function test_RefusesToKeepTheEoaInPower() public {
        GovernanceLib.Config memory c = _config(true);
        c.proposers[0] = eoa;
        vm.expectRevert(bytes("Governance: the admin EOA cannot be a proposer"));
        script.execute(c, EOA_KEY);

        c = _config(true);
        c.opsAuthority = eoa;
        vm.expectRevert(bytes("Governance: rotate away from the EOA"));
        script.execute(c, EOA_KEY);
    }

    function test_RequiresAPauserThatIsNotTheEoa() public {
        GovernanceLib.Config memory c = _config(true);
        c.pauser = address(0);
        vm.expectRevert(bytes("Governance: PAUSER is required"));
        script.execute(c, EOA_KEY);
        c.pauser = eoa;
        vm.expectRevert(bytes("Governance: rotate away from the EOA"));
        script.execute(c, EOA_KEY);
    }

    function test_RefusesAKeyThatIsNotAdmin() public {
        vm.expectRevert(bytes("Governance: PRIVATE_KEY is not the launchpad admin"));
        script.execute(_config(true), 0xBAD);
    }

    /// `PushPriceSource` gained `pendingAdmin`: it packs into the unused high
    /// bytes of `defaultMaxAge`'s slot, which live proxies never wrote, and
    /// moves nothing that was already there.
    function test_PushPriceSourceLayoutIsAppendOnly() public {
        // Upgrade the legacy proxy exactly as the handover does.
        address impl = address(new PushPriceSource());
        vm.prank(eoa);
        PushPriceSource(oracle).upgradeToAndCall(impl, "");
        PushPriceSource ps = PushPriceSource(oracle);

        assertEq(address(uint160(uint256(vm.load(oracle, bytes32(uint256(0)))))), eoa, "slot 0 = admin");
        assertEq(address(uint160(uint256(vm.load(oracle, bytes32(uint256(1)))))), oracleAuth, "slot 1");
        assertEq(
            uint256(vm.load(oracle, bytes32(uint256(4)))), 90_000, "slot 4 = defaultMaxAge, nothing else"
        );
        assertEq(ps.defaultMaxAge(), 90_000);

        vm.prank(eoa);
        ps.proposeAdmin(address(0xB0B));
        bytes32 slot4 = vm.load(oracle, bytes32(uint256(4)));
        assertEq(uint64(uint256(slot4)), 90_000, "defaultMaxAge intact");
        assertEq(address(uint160(uint256(slot4) >> 64)), address(0xB0B), "pendingAdmin at slot 4, offset 8");
        assertEq(uint256(vm.load(oracle, bytes32(uint256(5)))), 0, "slot 5 untouched");
    }
}
