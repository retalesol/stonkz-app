// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad} from "../../src/StonkzLaunchpad.sol";

/// @notice Replays `script/RecoverLaunchpadLayout.s.sol` on a fork of a live
/// proxy that is still behind the shifted implementation, with pranks in place
/// of keys. Skipped unless `RECOVER_FORK_RPC` and `RECOVER_FORK_PROXY` are set.
contract RecoverLayoutForkTest is Test {
    function test_RecoveryRestoresEveryShiftedSlot() public {
        string memory rpc = vm.envOr("RECOVER_FORK_RPC", string(""));
        address proxy = vm.envOr("RECOVER_FORK_PROXY", address(0));
        if (bytes(rpc).length == 0 || proxy == address(0)) return;
        vm.createSelectFork(rpc);

        StonkzLaunchpad pad = StonkzLaunchpad(proxy);
        assertEq(pad.admin(), address(0), "fork is not on the shifted implementation");

        address realAdmin = address(uint160(uint256(vm.load(proxy, bytes32(uint256(5))))));
        address protocolAuth = address(uint160(uint256(vm.load(proxy, bytes32(uint256(7))))));
        address opsAuth = address(uint160(uint256(vm.load(proxy, bytes32(uint256(8))))));
        address migrationAuth = address(uint160(uint256(vm.load(proxy, bytes32(uint256(9))))));
        address migrator = address(uint160(uint256(vm.load(proxy, bytes32(uint256(10))))));
        uint256 tokenCount = uint256(vm.load(proxy, bytes32(uint256(13))));
        assertEq(pad.pendingAdmin(), protocolAuth, "shift: pendingAdmin reads slot 7");
        assertEq(pad.protocolWithdrawAuthority(), opsAuth, "shift: protocol reads slot 8");

        // Step 1, signed by the old protocol authority.
        StonkzLaunchpad impl = new StonkzLaunchpad();
        vm.startPrank(protocolAuth);
        pad.acceptAdmin();
        assertEq(pad.admin(), protocolAuth, "acceptAdmin wrote slot 6");
        pad.upgradeToAndCall(address(impl), "");
        vm.stopPrank();

        assertEq(pad.admin(), realAdmin, "admin back in slot 5");
        assertEq(pad.pendingAdmin(), protocolAuth, "stray pendingAdmin from acceptAdmin");
        assertEq(pad.protocolWithdrawAuthority(), address(0), "protocol authority cleared by acceptAdmin");

        // Step 2, signed by the real admin.
        vm.startPrank(realAdmin);
        pad.setWithdrawAuthorities(protocolAuth, opsAuth);
        pad.proposeAdmin(address(0));
        vm.stopPrank();

        assertEq(pad.pendingAdmin(), address(0));
        assertEq(pad.protocolWithdrawAuthority(), protocolAuth);
        assertEq(pad.opsWithdrawAuthority(), opsAuth);
        assertEq(pad.migrationAuthority(), migrationAuth);
        assertEq(address(pad.migrator()), migrator);
        assertEq(pad.maxOracleStaleness(), 90_000);
        assertEq(pad.tokenCount(), tokenCount);
        assertFalse(pad.tradingPaused());
        assertFalse(pad.launchPaused());
        assertEq(pad.stonkzBurn(address(0)), 0);

        // The admin can still upgrade afterwards: the proxy is not bricked.
        StonkzLaunchpad again = new StonkzLaunchpad();
        vm.prank(realAdmin);
        pad.upgradeToAndCall(address(again), "");
        assertEq(pad.admin(), realAdmin);
    }
}
