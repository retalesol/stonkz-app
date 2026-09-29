// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReferralVault, ILaunchpadPauser} from "../src/ReferralVault.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockWETH} from "./mocks/MockUniversalRouter.sol";

/// @dev Stands in for the launchpad: the vault only ever reads `pauser()`.
contract MockPauserSource {
    address public pauser;

    function setPauser(address p) external {
        pauser = p;
    }
}

/// @dev A recipient that cannot take ETH, for the fail-closed unwrap path.
contract NoEth {
    function go(ReferralVault v, uint256 cumulative, uint256 deadline, bytes calldata sig) external {
        v.claimAsEth(address(this), cumulative, deadline, sig);
    }
}

/// @notice The referral vault: vouchers are cumulative, domain-bound, capped,
/// pausable by the launchpad's pauser, and every failure leaves nothing half
/// paid.
contract ReferralVaultTest is Test {
    ReferralVault vault;
    MockWETH weth;
    MockERC20 usdc;
    MockPauserSource pad;

    uint256 signerPk = 0xA11CE5;
    address signer;
    address admin = address(0xAD31);
    address pauser = address(0x9A05E);
    address alice = address(0xA71CE);
    address bob = address(0xB0B);
    address funder = address(0xF00D);

    uint256 constant CAP = 5 ether;
    uint256 deadline;

    function setUp() public {
        vm.warp(1_800_000_000);
        deadline = block.timestamp + 30 minutes;
        signer = vm.addr(signerPk);
        weth = new MockWETH();
        usdc = new MockERC20("USDC", "USDC", 6);
        pad = new MockPauserSource();
        pad.setPauser(pauser);
        vault = new ReferralVault(admin, signer, address(weth), address(pad), CAP);

        // Fund the vault the way the protocol authority would: WETH lands in it.
        vm.deal(funder, 100 ether);
        vm.prank(funder);
        weth.deposit{value: 20 ether}();
        vm.prank(funder);
        weth.approve(address(vault), type(uint256).max);
        vm.prank(funder);
        vault.fund(address(weth), 10 ether);
    }

    /* ------------------------------------------------------------ helpers */

    function _sign(uint256 pk, ReferralVault v, address to, address asset, uint256 cumulative, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, v.hashClaim(to, asset, cumulative, dl));
        return abi.encodePacked(r, s, vv);
    }

    function _voucher(address to, uint256 cumulative) internal view returns (bytes memory) {
        return _sign(signerPk, vault, to, address(weth), cumulative, deadline);
    }

    /* ------------------------------------------------------------- basics */

    function test_ClaimPaysTheDeltaAndRecordsTheCumulative() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vm.expectEmit(address(vault));
        emit ReferralVault.ReferralClaimed(alice, address(weth), 1 ether, 1 ether, false, bob);
        vm.prank(bob); // anyone may submit; the money goes to alice
        uint256 paid = vault.claim(alice, address(weth), 1 ether, deadline, sig);
        assertEq(paid, 1 ether);
        assertEq(weth.balanceOf(alice), 1 ether);
        assertEq(vault.claimed(alice, address(weth)), 1 ether);

        // A later voucher for a bigger lifetime pays only the difference.
        bytes memory sig2 = _voucher(alice, 1.5 ether);
        vm.prank(alice);
        paid = vault.claim(alice, address(weth), 1.5 ether, deadline, sig2);
        assertEq(paid, 0.5 ether);
        assertEq(weth.balanceOf(alice), 1.5 ether);
        assertEq(vault.claimable(alice, address(weth), 1.5 ether), 0);
        assertEq(vault.claimable(alice, address(weth), 2 ether), 0.5 ether);
    }

    function test_ReplayAndOlderVouchersPayNothing() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vault.claim(alice, address(weth), 1 ether, deadline, sig);

        vm.expectRevert(abi.encodeWithSelector(ReferralVault.NothingToClaim.selector, 1 ether, 1 ether));
        vault.claim(alice, address(weth), 1 ether, deadline, sig);

        bytes memory older = _voucher(alice, 0.4 ether);
        vm.expectRevert(abi.encodeWithSelector(ReferralVault.NothingToClaim.selector, 0.4 ether, 1 ether));
        vault.claim(alice, address(weth), 0.4 ether, deadline, older);

        assertEq(weth.balanceOf(alice), 1 ether);
    }

    function test_ZeroVoucherPaysNothing() public {
        bytes memory sig = _voucher(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(ReferralVault.NothingToClaim.selector, 0, 0));
        vault.claim(alice, address(weth), 0, deadline, sig);
    }

    /* ------------------------------------------------------ domain binding */

    function test_SignatureIsBoundToRecipient() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(bob, address(weth), 1 ether, deadline, sig);
    }

    function test_SignatureIsBoundToAsset() public {
        vm.prank(admin);
        vault.setMaxPerDay(address(usdc), type(uint256).max);
        usdc.mint(address(vault), 1_000e6);
        bytes memory sig = _voucher(alice, 1 ether);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(usdc), 1 ether, deadline, sig);
    }

    function test_SignatureIsBoundToAmountAndDeadline() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(weth), 2 ether, deadline, sig);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(weth), 1 ether, deadline + 1, sig);
    }

    function test_SignatureIsBoundToTheVault() public {
        ReferralVault other = new ReferralVault(admin, signer, address(weth), address(pad), CAP);
        vm.prank(funder);
        weth.transfer(address(other), 5 ether);
        bytes memory sig = _voucher(alice, 1 ether); // signed for `vault`
        vm.expectRevert(ReferralVault.BadSignature.selector);
        other.claim(alice, address(weth), 1 ether, deadline, sig);
        // and the right vault still accepts it
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
    }

    function test_SignatureIsBoundToTheChain() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
    }

    function test_StrangerSignatureIsRejected() public {
        bytes memory sig = _sign(0xBAD, vault, alice, address(weth), 1 ether, deadline);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
    }

    function test_MalformedSignatureIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        vault.claim(alice, address(weth), 1 ether, deadline, hex"010203");
    }

    function test_NoSignerMeansNoClaims() public {
        vm.prank(admin);
        vault.setSigner(address(0));
        bytes memory sig = _voucher(alice, 1 ether);
        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
    }

    function test_TypehashMatchesTheApiString() public view {
        assertEq(
            vault.CLAIM_TYPEHASH(),
            keccak256("ReferralClaim(address recipient,address asset,uint256 cumulativeAmount,uint256 deadline)")
        );
    }

    /* ----------------------------------------------------------- deadline */

    function test_ExpiredVoucherReverts() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ReferralVault.VoucherExpired.selector, deadline, deadline + 1));
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
        // exactly at the deadline is still good
        vm.warp(deadline);
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
    }

    /* ---------------------------------------------------------- daily cap */

    function test_DailyCapIsSharedAcrossRecipientsAndRolls() public {
        vault.claim(alice, address(weth), 3 ether, deadline, _voucher(alice, 3 ether));
        assertEq(vault.remainingToday(address(weth)), 2 ether);

        bytes memory sigB = _voucher(bob, 2.5 ether);
        vm.expectRevert(
            abi.encodeWithSelector(ReferralVault.DailyCapExceeded.selector, address(weth), 2.5 ether, 2 ether)
        );
        vault.claim(bob, address(weth), 2.5 ether, deadline, sigB);
        assertEq(vault.claimed(bob, address(weth)), 0, "nothing recorded on a refused claim");

        vm.warp(block.timestamp + 1 days);
        deadline = block.timestamp + 30 minutes;
        sigB = _voucher(bob, 2.5 ether);
        vault.claim(bob, address(weth), 2.5 ether, deadline, sigB);
        assertEq(weth.balanceOf(bob), 2.5 ether);
        assertEq(vault.remainingToday(address(weth)), 2.5 ether);
    }

    function test_AssetWithZeroCapIsDisabled() public {
        usdc.mint(address(vault), 1_000e6);
        bytes memory sig = _sign(signerPk, vault, alice, address(usdc), 100e6, deadline);
        vm.expectRevert(abi.encodeWithSelector(ReferralVault.AssetDisabled.selector, address(usdc)));
        vault.claim(alice, address(usdc), 100e6, deadline, sig);

        vm.prank(admin);
        vault.setMaxPerDay(address(usdc), 500e6);
        vault.claim(alice, address(usdc), 100e6, deadline, sig);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_UncappedAssetNeverCounts() public {
        vm.prank(admin);
        vault.setMaxPerDay(address(weth), type(uint256).max);
        vault.claim(alice, address(weth), 9 ether, deadline, _voucher(alice, 9 ether));
        assertEq(vault.remainingToday(address(weth)), type(uint256).max);
        assertEq(vault.claimedToday(address(weth)), 0);
    }

    /* -------------------------------------------------------------- pause */

    function test_LaunchpadPauserCanPauseOnlyAdminUnpauses() public {
        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());

        bytes memory sig = _voucher(alice, 1 ether);
        vm.expectRevert(ReferralVault.ClaimsPaused.selector);
        vault.claim(alice, address(weth), 1 ether, deadline, sig);

        vm.prank(pauser);
        vm.expectRevert(ReferralVault.NotAdmin.selector);
        vault.unpause();

        vm.prank(admin);
        vault.unpause();
        vault.claim(alice, address(weth), 1 ether, deadline, sig);
    }

    function test_AdminCanPauseStrangersCannot() public {
        vm.prank(alice);
        vm.expectRevert(ReferralVault.NotPauser.selector);
        vault.pause();
        vm.prank(admin);
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_PauserFollowsTheLaunchpad() public {
        pad.setPauser(bob);
        vm.prank(pauser);
        vm.expectRevert(ReferralVault.NotPauser.selector);
        vault.pause();
        vm.prank(bob);
        vault.pause();
    }

    function test_LaunchpadWithoutPauserHasNone() public {
        ReferralVault v = new ReferralVault(admin, signer, address(weth), address(weth), CAP); // WETH has no pauser()
        assertEq(v.launchpadPauser(), address(0));
        vm.prank(pauser);
        vm.expectRevert(ReferralVault.NotPauser.selector);
        v.pause();
    }

    function test_PauserSelectorMatchesTheRealLaunchpad() public pure {
        assertEq(ILaunchpadPauser.pauser.selector, bytes4(keccak256("pauser()")));
    }

    /* ----------------------------------------------------------- rotation */

    function test_SignerRotationInvalidatesOldVouchers() public {
        bytes memory old = _voucher(alice, 1 ether);
        uint256 nextPk = 0xBEEF;
        vm.prank(alice);
        vm.expectRevert(ReferralVault.NotAdmin.selector);
        vault.setSigner(vm.addr(nextPk));

        vm.expectEmit(address(vault));
        emit ReferralVault.SignerSet(signer, vm.addr(nextPk));
        vm.prank(admin);
        vault.setSigner(vm.addr(nextPk));

        vm.expectRevert(ReferralVault.BadSignature.selector);
        vault.claim(alice, address(weth), 1 ether, deadline, old);

        bytes memory fresh = _sign(nextPk, vault, alice, address(weth), 1 ether, deadline);
        vault.claim(alice, address(weth), 1 ether, deadline, fresh);
        assertEq(weth.balanceOf(alice), 1 ether);
    }

    function test_AdminHandoverIsTwoStep() public {
        vm.prank(admin);
        vault.proposeAdmin(bob);
        assertEq(vault.admin(), admin);
        vm.prank(alice);
        vm.expectRevert(ReferralVault.NotPendingAdmin.selector);
        vault.acceptAdmin();
        vm.prank(bob);
        vault.acceptAdmin();
        assertEq(vault.admin(), bob);
        assertEq(vault.pendingAdmin(), address(0));
        vm.prank(admin);
        vm.expectRevert(ReferralVault.NotAdmin.selector);
        vault.setSigner(alice);
    }

    /* ------------------------------------------------------- fail closed */

    function test_InsufficientBalanceRevertsWithNothingPartial() public {
        // 10 ether held; a 12 ether voucher must not pay 10 and owe 2.
        bytes memory sig = _voucher(alice, 12 ether);
        vm.prank(admin);
        vault.setMaxPerDay(address(weth), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(ReferralVault.InsufficientVaultBalance.selector, address(weth), 12 ether, 10 ether)
        );
        vault.claim(alice, address(weth), 12 ether, deadline, sig);
        assertEq(vault.claimed(alice, address(weth)), 0);
        assertEq(weth.balanceOf(alice), 0);
        assertEq(weth.balanceOf(address(vault)), 10 ether);

        // Top up, same voucher, pays in full.
        vm.prank(funder);
        vault.fund(address(weth), 2 ether);
        vault.claim(alice, address(weth), 12 ether, deadline, sig);
        assertEq(weth.balanceOf(alice), 12 ether);
    }

    /* ------------------------------------------------------------- unwrap */

    function test_ClaimAsEthUnwrapsForTheRecipientOnly() public {
        bytes memory sig = _voucher(alice, 1 ether);
        vm.prank(bob);
        vm.expectRevert(ReferralVault.NotRecipient.selector);
        vault.claimAsEth(alice, 1 ether, deadline, sig);

        uint256 before = alice.balance;
        vm.expectEmit(address(vault));
        emit ReferralVault.ReferralClaimed(alice, address(weth), 1 ether, 1 ether, true, alice);
        vm.prank(alice);
        vault.claimAsEth(alice, 1 ether, deadline, sig);
        assertEq(alice.balance - before, 1 ether);
        assertEq(weth.balanceOf(alice), 0);
        assertEq(address(vault).balance, 0, "no ETH parked in the vault");
    }

    function test_UnwrapToARecipientThatRejectsEthRevertsWhole() public {
        NoEth r = new NoEth();
        bytes memory sig = _voucher(address(r), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ReferralVault.EthTransferFailed.selector, address(r), 1 ether));
        r.go(vault, 1 ether, deadline, sig);
        assertEq(vault.claimed(address(r), address(weth)), 0);
        // the WETH path still works for it
        vault.claim(address(r), address(weth), 1 ether, deadline, sig);
        assertEq(weth.balanceOf(address(r)), 1 ether);
    }

    function test_StrayEthIsRefused() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    /* ------------------------------------------------------------ funding */

    function test_FundEmitsAndFundEthWraps() public {
        vm.expectEmit(address(vault));
        emit ReferralVault.Funded(address(weth), funder, 1 ether);
        vm.prank(funder);
        vault.fund(address(weth), 1 ether);

        vm.prank(funder);
        vault.fundEth{value: 2 ether}();
        assertEq(weth.balanceOf(address(vault)), 13 ether);
    }

    function test_SweepIsAdminOnly() public {
        vm.prank(alice);
        vm.expectRevert(ReferralVault.NotAdmin.selector);
        vault.sweep(address(weth), alice, 1 ether);
        vm.prank(admin);
        vault.sweep(address(weth), bob, 1 ether);
        assertEq(weth.balanceOf(bob), 1 ether);
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(ReferralVault.ZeroAddress.selector);
        new ReferralVault(address(0), signer, address(weth), address(pad), CAP);
        vm.expectRevert(ReferralVault.ZeroAddress.selector);
        new ReferralVault(admin, signer, address(0), address(pad), CAP);
        vm.expectRevert(ReferralVault.ZeroAddress.selector);
        new ReferralVault(admin, signer, address(weth), address(0), CAP);
        // a zero signer is allowed (claims off until set)
        ReferralVault v = new ReferralVault(admin, address(0), address(weth), address(pad), 0);
        assertEq(v.signer(), address(0));
        assertEq(v.maxPerDay(address(weth)), 0);
    }

    /* --------------------------------------------------------------- fuzz */

    /// @dev Whatever order vouchers arrive in, total paid == max cumulative
    /// seen, and never more than the vault holds.
    function testFuzz_CumulativeMonotonic(uint96 a, uint96 b, uint96 c) public {
        vm.prank(admin);
        vault.setMaxPerDay(address(weth), type(uint256).max);
        vm.prank(funder);
        weth.mint(address(vault), type(uint96).max); // plenty
        uint256[3] memory seq = [uint256(a), uint256(b), uint256(c)];
        uint256 high = 0;
        for (uint256 i = 0; i < 3; i++) {
            uint256 cum = seq[i];
            bytes memory sig = _voucher(alice, cum);
            if (cum > high) {
                uint256 paid = vault.claim(alice, address(weth), cum, deadline, sig);
                assertEq(paid, cum - high);
                high = cum;
            } else {
                vm.expectRevert(abi.encodeWithSelector(ReferralVault.NothingToClaim.selector, cum, high));
                vault.claim(alice, address(weth), cum, deadline, sig);
            }
            assertEq(vault.claimed(alice, address(weth)), high);
            assertEq(weth.balanceOf(alice), high);
        }
    }

    /// @dev The cap refuses exactly what would cross it, and a refused claim changes nothing.
    function testFuzz_DailyCap(uint96 cap, uint96 want) public {
        vm.assume(cap > 0);
        vm.prank(admin);
        vault.setMaxPerDay(address(weth), cap);
        vm.prank(funder);
        weth.mint(address(vault), type(uint96).max);
        bytes memory sig = _voucher(alice, want);
        if (want == 0) {
            vm.expectRevert(abi.encodeWithSelector(ReferralVault.NothingToClaim.selector, 0, 0));
            vault.claim(alice, address(weth), want, deadline, sig);
        } else if (want > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(ReferralVault.DailyCapExceeded.selector, address(weth), uint256(want), uint256(cap))
            );
            vault.claim(alice, address(weth), want, deadline, sig);
            assertEq(vault.claimedToday(address(weth)), 0);
            assertEq(vault.claimed(alice, address(weth)), 0);
        } else {
            vault.claim(alice, address(weth), want, deadline, sig);
            assertEq(vault.claimedToday(address(weth)), want);
            assertEq(vault.remainingToday(address(weth)), uint256(cap) - want);
        }
    }
}
