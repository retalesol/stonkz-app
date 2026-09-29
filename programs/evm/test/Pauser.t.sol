// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice The emergency pauser: a key (or 1-of-N Safe) deliberately *not*
/// behind the timelock, so a stop is instant. It can only stop things.
/// Everything that could move money or change behaviour back — unpausing,
/// withdrawals, upgrades, configuration — stays with `admin`.
contract PauserTest is Test {
    StonkzLaunchpad pad;
    PushPriceSource oracle;
    MockERC20 base;

    address admin = address(0xA11CE);
    address pauser = address(0x9A05E);
    address oracleAuth = address(0x0AC1E);
    address user = address(0xC4EA7);

    function setUp() public {
        vm.warp(1_800_000_000);
        base = new MockERC20("USDG", "USDG", 6);
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, admin, admin, oracle, admin);
        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);
        vm.expectEmit(address(pad));
        emit StonkzLaunchpad.PauserSet(pauser);
        vm.prank(admin);
        pad.setPauser(pauser);
    }

    function _flags() internal view returns (bool, bool, bool, bool, bool) {
        return (
            pad.tradingPaused(),
            pad.launchPaused(),
            pad.protocolWithdrawalsPaused(),
            pad.opsWithdrawalsPaused(),
            pad.oracleGraduationPaused()
        );
    }

    function test_ThePauserCanPauseEachSwitchAlone() public {
        bool[5] memory want;
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(admin);
            pad.setPause(false, false, false, false, false);
            want = [i == 0, i == 1, i == 2, i == 3, i == 4];
            vm.prank(pauser);
            pad.pause(want[0], want[1], want[2], want[3], want[4]);
            (bool a, bool b, bool c, bool d, bool e) = _flags();
            assertEq(a, want[0], "trading");
            assertEq(b, want[1], "launch");
            assertEq(c, want[2], "protocol withdrawals");
            assertEq(d, want[3], "ops withdrawals");
            assertEq(e, want[4], "oracle graduation");
        }
    }

    /// `false` means "leave it", never "clear it": the pauser cannot unpause
    /// by passing `false`, even for a flag it set itself.
    function test_ThePauserCannotUnpause() public {
        vm.startPrank(pauser);
        pad.pause(true, true, true, true, true);
        pad.pause(false, false, false, false, false);
        (bool a, bool b, bool c, bool d, bool e) = _flags();
        assertTrue(a && b && c && d && e, "still paused");
        vm.expectRevert(bytes("not admin"));
        pad.setPause(false, false, false, false, false);
        vm.stopPrank();
    }

    function test_AdminUnpauses() public {
        vm.prank(pauser);
        pad.pause(true, true, true, true, true);
        vm.prank(admin);
        pad.setPause(false, false, false, false, false);
        (bool a, bool b, bool c, bool d, bool e) = _flags();
        assertFalse(a || b || c || d || e);
        // And the admin can use the pauser's entry point too.
        vm.prank(admin);
        pad.pause(false, true, false, false, false);
        assertTrue(pad.launchPaused());
    }

    /// A pause actually stops the thing it names.
    function test_APauseTakesEffect() public {
        vm.prank(pauser);
        pad.pause(false, true, false, false, false);
        vm.prank(user);
        vm.expectRevert(bytes("launch paused"));
        pad.createToken("Coin", "PAUSE", "u", 1_000_000_000, address(base), 250, false);
    }

    /// Everything else the admin can do, the pauser cannot.
    function test_ThePauserCannotDoAnythingElse() public {
        address impl = address(new StonkzLaunchpad(address(0)));
        vm.startPrank(pauser);
        vm.expectRevert(bytes("not admin"));
        pad.upgradeToAndCall(impl, "");
        vm.expectRevert(bytes("not admin"));
        pad.setPauser(user);
        vm.expectRevert(bytes("not admin"));
        pad.proposeAdmin(pauser);
        vm.expectRevert(bytes("not admin"));
        pad.setMigrator(IGraduationMigrator(address(0)), pauser);
        vm.expectRevert(bytes("not admin"));
        pad.setWithdrawAuthorities(pauser, pauser);
        vm.expectRevert(bytes("not admin"));
        pad.setPriceSource(IPriceSource(address(1)));
        vm.expectRevert(bytes("not admin"));
        pad.setMaxOracleStaleness(1);
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(0, address(base), 1, pauser);
        vm.expectRevert(bytes("not authority"));
        pad.withdrawTreasury(1, address(base), 1, pauser);
        vm.expectRevert(bytes("not migration authority"));
        pad.migrateLiquidity(address(1));
        vm.stopPrank();
    }

    function test_OnlyTheAdminSetsThePauserAndZeroMeansNone() public {
        vm.prank(user);
        vm.expectRevert(bytes("not admin"));
        pad.setPauser(user);

        vm.prank(user);
        vm.expectRevert(bytes("not pauser"));
        pad.pause(true, false, false, false, false);

        vm.prank(admin);
        pad.setPauser(address(0));
        assertEq(pad.pauser(), address(0));
        vm.prank(pauser);
        vm.expectRevert(bytes("not pauser"));
        pad.pause(true, false, false, false, false);
    }
}
