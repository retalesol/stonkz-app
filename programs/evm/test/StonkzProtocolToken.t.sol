// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {StonkzProtocolToken} from "../src/StonkzProtocolToken.sol";

contract StonkzProtocolTokenTest is Test {
    address admin = address(0xA11CE);
    address recipient = 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca;
    address stranger = address(0xB0B);
    address frozenAcct = address(0xF4EE);

    StonkzProtocolToken token;

    function setUp() public {
        token = new StonkzProtocolToken(admin, recipient);
    }

    function test_MetadataAndInitialMint() public view {
        assertEq(token.name(), "Stonkz");
        assertEq(token.symbol(), "STONKZ");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(recipient), 1_000_000_000 ether);
        assertEq(token.balanceOf(admin), 0);
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(token.hasRole(token.MINTER_ROLE(), admin));
        assertTrue(token.hasRole(token.BURNER_ROLE(), admin));
        assertTrue(token.hasRole(token.FREEZER_ROLE(), admin));
        assertEq(token.contractURI(), token.INITIAL_CONTRACT_URI());
        assertEq(token.contractURI(), "ipfs://bafkreibsg7gnnregbb5lugs5rlg3dyoeszsed6oj4gk3padfvg5mdgdgjm");
    }

    function test_MintAndHolderBurn() public {
        vm.prank(admin);
        token.mint(stranger, 100 ether);
        assertEq(token.balanceOf(stranger), 100 ether);

        vm.prank(stranger);
        token.burn(40 ether);
        assertEq(token.balanceOf(stranger), 60 ether);
        assertEq(token.totalSupply(), 1_000_000_000 ether + 60 ether);
    }

    function test_StrangerCannotMint() public {
        bytes32 minter = token.MINTER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, minter)
        );
        token.mint(stranger, 1);
    }

    function test_FreezeBlocksTransferAndReceive() public {
        vm.prank(admin);
        token.mint(frozenAcct, 10 ether);
        vm.prank(admin);
        token.freeze(frozenAcct);

        vm.prank(frozenAcct);
        vm.expectRevert(abi.encodeWithSelector(StonkzProtocolToken.AccountFrozen.selector, frozenAcct));
        token.transfer(stranger, 1 ether);

        vm.prank(recipient);
        vm.expectRevert(abi.encodeWithSelector(StonkzProtocolToken.AccountFrozen.selector, frozenAcct));
        token.transfer(frozenAcct, 1 ether);
    }

    function test_AdminBurnWorksOnFrozenAccount() public {
        vm.prank(admin);
        token.mint(frozenAcct, 10 ether);
        vm.prank(admin);
        token.freeze(frozenAcct);

        vm.prank(admin);
        token.adminBurn(frozenAcct, 10 ether);
        assertEq(token.balanceOf(frozenAcct), 0);
    }

    function test_DisableMintingForever() public {
        vm.prank(admin);
        token.disableMintingForever();
        assertTrue(token.mintingSealed());

        vm.prank(admin);
        vm.expectRevert(StonkzProtocolToken.MintingSealed.selector);
        token.mint(stranger, 1);

        vm.prank(admin);
        vm.expectRevert(StonkzProtocolToken.MintingSealed.selector);
        token.disableMintingForever();
    }

    function test_DisableFreezingForever() public {
        vm.prank(admin);
        token.freeze(frozenAcct);
        vm.prank(admin);
        token.disableFreezingForever();

        vm.prank(admin);
        vm.expectRevert(StonkzProtocolToken.FreezingSealed.selector);
        token.unfreeze(frozenAcct);

        vm.prank(admin);
        vm.expectRevert(StonkzProtocolToken.FreezingSealed.selector);
        token.freeze(stranger);
    }

    function test_DisableAdminBurnForeverLeavesHolderBurn() public {
        vm.prank(admin);
        token.mint(stranger, 5 ether);
        vm.prank(admin);
        token.disableAdminBurnForever();

        vm.prank(admin);
        vm.expectRevert(StonkzProtocolToken.AdminBurnSealed.selector);
        token.adminBurn(stranger, 1 ether);

        vm.prank(stranger);
        token.burn(2 ether);
        assertEq(token.balanceOf(stranger), 3 ether);
    }

    function test_ContractURIIsOptionalAndSealable() public {
        assertEq(token.contractURI(), token.INITIAL_CONTRACT_URI());
        vm.prank(admin);
        token.setContractURI("ipfs://stonkz");
        assertEq(token.contractURI(), "ipfs://stonkz");

        vm.prank(admin);
        token.disableContractURIForever();
        vm.prank(admin);
        vm.expectRevert(StonkzProtocolToken.ContractURISealed.selector);
        token.setContractURI("ipfs://nope");
    }

    function test_RejectsZeroRecipient() public {
        vm.expectRevert(StonkzProtocolToken.ZeroAddress.selector);
        new StonkzProtocolToken(admin, address(0));
    }

    function test_RevokeMinterRole() public {
        bytes32 minter = token.MINTER_ROLE();
        vm.prank(admin);
        token.revokeRole(minter, admin);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, minter)
        );
        token.mint(stranger, 1);
    }
}
