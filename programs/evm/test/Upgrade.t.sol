// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";

/// @dev Minimal V2 implementation that only adds a version tag for upgrade smoke.
contract StonkzLaunchpadV2 is StonkzLaunchpad {
    function version() external pure returns (string memory) {
        return "v2-beta";
    }
}

/// @notice UUPS upgrade preserves launchpad storage (admin, coins, balances).
contract UpgradeTest is Test {
    address admin = address(0xA11CE);
    address protocolCold = address(0xC01D1);
    address opsCold = address(0xC01D2);
    address oracleAuth = address(0x0AC1E);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);

    /// @notice Pins the live storage layout behind the RH 46630 and Base 84532
    /// proxies. Every slot here is already written on chain; a new state
    /// variable may only ever land after the last one (`_lock`). The 2026-09-27 upgrade
    /// put `stonkzBurn` before `admin` and shifted every later slot by one.
    function test_StorageLayoutIsAppendOnly() public {
        vm.warp(1_800_000_000);
        PushPriceSource oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        StonkzLaunchpad pad = DeployPad.launchpad(admin, protocolCold, opsCold, oracle, admin);
        address p = address(pad);

        assertEq(address(uint160(uint256(vm.load(p, bytes32(uint256(5)))))), admin, "slot 5 = admin");
        assertEq(uint256(vm.load(p, bytes32(uint256(6)))), 0, "slot 6 = pendingAdmin");
        assertEq(
            address(uint160(uint256(vm.load(p, bytes32(uint256(7)))))),
            protocolCold,
            "slot 7 = protocol authority"
        );
        assertEq(
            address(uint160(uint256(vm.load(p, bytes32(uint256(8)))))), opsCold, "slot 8 = ops authority"
        );
        assertEq(
            address(uint160(uint256(vm.load(p, bytes32(uint256(11)))))),
            address(oracle),
            "slot 11 = priceSource"
        );
        assertEq(uint256(vm.load(p, bytes32(uint256(12)))), 90_000, "slot 12 = maxOracleStaleness");

        // `stonkzBurn` is the first slot after `tokenCount` (13): the mapping's
        // base is 14, so its value for `key` lives at keccak256(key . 14).
        address key = address(0xBEEF);
        bytes32 where = keccak256(abi.encode(key, uint256(14)));
        assertEq(uint256(vm.load(p, where)), 0);
        vm.store(p, where, bytes32(uint256(77)));
        assertEq(pad.stonkzBurn(key), 77, "stonkzBurn base slot is 14");

        // `_lock` is the LAST declared variable (slot 15) and the reentrancy
        // guard reads it on every entry point: a new variable declared before
        // it would shift it to an empty slot and freeze the whole launchpad.
        // New state goes after `_lock`, and this pin moves with it.
        assertEq(uint256(vm.load(p, bytes32(uint256(15)))), 1, "slot 15 = _lock, unlocked");
    }

    function test_LaunchpadUpgradePreservesState() public {
        vm.warp(1_800_000_000);
        MockERC20 base = new MockERC20("USDG", "USDG", 6);
        PushPriceSource oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        StonkzLaunchpad pad = DeployPad.launchpad(admin, protocolCold, opsCold, oracle, admin);

        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);

        base.mint(trader, 1_000_000e6);
        vm.prank(trader);
        base.approve(address(pad), type(uint256).max);

        vm.prank(creator);
        address token = pad.createToken("Coin", "UPG", "u", 1_000_000_000, address(base), 250, false);
        vm.prank(trader);
        uint256 out = pad.buy(token, 100e6, 0);
        assertGt(out, 0);

        uint256 mcBefore = pad.coinInfo(token).virtualBase;
        address adminBefore = pad.admin();

        StonkzLaunchpadV2 v2 = new StonkzLaunchpadV2();
        vm.prank(admin);
        pad.upgradeToAndCall(address(v2), "");

        assertEq(pad.admin(), adminBefore);
        assertEq(pad.coinInfo(token).virtualBase, mcBefore);
        assertEq(StonkzLaunchpadV2(address(pad)).version(), "v2-beta");

        // Still tradeable after upgrade.
        vm.prank(trader);
        assertGt(pad.buy(token, 10e6, 0), 0);
    }

    function test_PushOracleUpgradePreservesPrice() public {
        vm.warp(1_800_000_000);
        MockERC20 base = new MockERC20("WETH", "WETH", 18);
        PushPriceSource oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 3_000e6, 0);

        (uint256 pBefore,,) = oracle.priceUsd1e6(address(base));
        PushPriceSource impl2 = new PushPriceSource();
        vm.prank(admin);
        oracle.upgradeToAndCall(address(impl2), "");
        (uint256 pAfter,,) = oracle.priceUsd1e6(address(base));
        assertEq(pAfter, pBefore);
        assertEq(oracle.admin(), admin);
    }

    function test_NonAdminCannotUpgrade() public {
        PushPriceSource oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        PushPriceSource impl2 = new PushPriceSource();
        vm.expectRevert(bytes("not admin"));
        oracle.upgradeToAndCall(address(impl2), "");
    }
}
