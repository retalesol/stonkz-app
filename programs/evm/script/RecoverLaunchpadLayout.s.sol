// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";

/// @title Recover a launchpad proxy from the 2026-09-27 storage-shift upgrade.
///
/// That upgrade declared `stonkzBurn` before `admin`, so every variable from
/// `admin` on reads one slot late behind the proxy: `admin()` returns the old
/// `pendingAdmin` (zero), `pendingAdmin()` returns the old protocol withdraw
/// authority, and so on. Nothing was written under the broken layout (no logs
/// since the upgrade on either chain), so the original values are intact; only
/// the reads are off by one.
///
/// Recovery, two signers:
///  1. `RECOVERY_KEY` — the old protocol withdraw authority, which the broken
///     implementation reads as `pendingAdmin`. It calls `acceptAdmin()` (which
///     writes the old `pendingAdmin` slot and clears the old protocol authority
///     slot) and then upgrades to the fixed implementation, whose layout appends
///     `stonkzBurn` after `tokenCount`.
///  2. `PRIVATE_KEY` — the real admin, readable again after step 1. It restores
///     the protocol withdraw authority that step 1 cleared and clears the stray
///     `pendingAdmin` that step 1 wrote.
///
/// ```
/// export RECOVERY_KEY=0x...   # key for the address pendingAdmin() currently returns
/// export PRIVATE_KEY=0x...    # launchpad admin (0x1FA9…Bdca on both testnets)
/// LAUNCHPAD_ADDRESS=0x... EXPECT_CHAIN_ID=46630 forge script \
///   script/RecoverLaunchpadLayout.s.sol:RecoverLaunchpadLayout --rpc-url $RPC --broadcast -vvv
/// ```
contract RecoverLaunchpadLayout is Script {
    function run() external {
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "Recover: unexpected chain id");
        require(block.chainid == 46630 || block.chainid == 84532, "Recover: only the two shifted testnets");

        address launchpad = vm.envAddress("LAUNCHPAD_ADDRESS");
        StonkzLaunchpad pad = StonkzLaunchpad(launchpad);

        uint256 recoveryPk = vm.envUint("RECOVERY_KEY");
        uint256 adminPk = vm.envUint("PRIVATE_KEY");
        address recovery = vm.addr(recoveryPk);
        address admin = vm.addr(adminPk);

        // Under the broken layout: slot 5 (real admin) is unread, slot 6 (old
        // pendingAdmin) reads as admin, slot 7 (old protocol authority) reads
        // as pendingAdmin, slot 8 (old ops authority) reads as protocol.
        require(pad.admin() == address(0), "Recover: admin readable, layout is not shifted");
        require(
            pad.pendingAdmin() == recovery, "Recover: RECOVERY_KEY is not the address read as pendingAdmin"
        );
        address realAdmin = address(uint160(uint256(vm.load(launchpad, bytes32(uint256(5))))));
        require(realAdmin == admin, "Recover: PRIVATE_KEY is not the admin in slot 5");
        address oldOps = pad.protocolWithdrawAuthority(); // slot 8 = real ops authority
        address oldProtocol = recovery; // slot 7 = real protocol authority
        require(oldOps != address(0) && oldOps != oldProtocol, "Recover: unexpected authorities");

        // Step 1: the address the broken layout calls pendingAdmin takes admin
        // (slot 6), then swaps the implementation for the append-only one.
        vm.startBroadcast(recoveryPk);
        pad.acceptAdmin();
        StonkzLaunchpad impl = new StonkzLaunchpad();
        pad.upgradeToAndCall(address(impl), "");
        vm.stopBroadcast();

        // Fixed layout: slot 5 is admin again.
        require(pad.admin() == admin, "Recover: admin not restored after upgrade");
        require(pad.pendingAdmin() == recovery, "Recover: expected stray pendingAdmin from acceptAdmin");
        require(pad.protocolWithdrawAuthority() == address(0), "Recover: expected cleared protocol authority");
        require(pad.opsWithdrawAuthority() == oldOps, "Recover: ops authority moved");

        // Step 2: the real admin repairs the two slots step 1 touched.
        vm.startBroadcast(adminPk);
        pad.setWithdrawAuthorities(oldProtocol, oldOps);
        pad.proposeAdmin(address(0));
        vm.stopBroadcast();

        require(pad.pendingAdmin() == address(0), "Recover: pendingAdmin not cleared");
        require(pad.protocolWithdrawAuthority() == oldProtocol, "Recover: protocol authority not restored");
        require(pad.migrationAuthority() != address(0), "Recover: migration authority unreadable");
        require(address(pad.migrator()) != address(0), "Recover: migrator unreadable");
        require(
            uint160(address(pad.priceSource())) > 0xFFFFFF, "Recover: priceSource still reads packed bools"
        );
        require(!pad.tradingPaused(), "Recover: tradingPaused flipped");
        pad.stonkzBurn(address(0));

        console2.log("chain   ", block.chainid);
        console2.log("proxy   ", launchpad);
        console2.log("newImpl ", address(impl));
        console2.log("admin   ", pad.admin());
        console2.log("protocol", pad.protocolWithdrawAuthority());
        console2.log("ops     ", pad.opsWithdrawAuthority());
    }
}
