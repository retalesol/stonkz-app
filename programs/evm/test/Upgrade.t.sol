// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzLens} from "../src/StonkzLens.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {LegacyStonkzLaunchpad} from "./mocks/LegacyLaunchpad.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";

/// @dev Minimal V2 implementation that only adds a version tag for upgrade smoke.
contract StonkzLaunchpadV2 is StonkzLaunchpad {
    constructor() StonkzLaunchpad(address(0)) {}

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
    /// variable may only ever land after the last one (`_lock`, then `pauser`,
    /// then `_params` and `_router`). The 2026-09-27 upgrade put `stonkzBurn`
    /// before `admin` and shifted every later slot by one.
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

        // `pauser` is the first variable appended after `_lock`: slot 16.
        // Anything appended later goes to 17+, and this pin moves with it.
        assertEq(uint256(vm.load(p, bytes32(uint256(16)))), 0, "slot 16 = pauser, unset");
        vm.prank(admin);
        pad.setPauser(address(0x9A05E));
        assertEq(
            address(uint160(uint256(vm.load(p, bytes32(uint256(16)))))), address(0x9A05E), "slot 16 = pauser"
        );
        assertEq(uint256(vm.load(p, bytes32(uint256(15)))), 1, "_lock untouched by setPauser");

        // `_params` is appended after `pauser`: slot 17. Zero until the first
        // `setParams`, and zero *means* `CurveMath.DEFAULT_PARAMS` — so a proxy
        // upgraded to this implementation needs no migration call.
        assertEq(uint256(vm.load(p, bytes32(uint256(17)))), 0, "slot 17 = _params, unset");
        assertEq(pad.paramsWord(), CurveMath.DEFAULT_PARAMS, "zero word reads as the defaults");
        uint256 word = CurveMath.DEFAULT_PARAMS ^ (uint256(1) << 16); // ops 1001 bps: still valid
        vm.prank(admin);
        pad.setParams(word);
        assertEq(uint256(vm.load(p, bytes32(uint256(17)))), word, "slot 17 = _params");
        assertEq(pad.paramsWord(), word);

        // `_router` is slot 18: the storage override for `trustedRouter`. Zero
        // falls back to the implementation's constructor argument.
        assertEq(uint256(vm.load(p, bytes32(uint256(18)))), 0, "slot 18 = _router, unset");
        assertEq(pad.trustedRouter(), address(0), "DeployPad builds a router-less implementation");
        StonkzLaunchpad withDefault = new StonkzLaunchpad(address(0xD0D0));
        vm.prank(admin);
        pad.upgradeToAndCall(address(withDefault), "");
        assertEq(pad.trustedRouter(), address(0xD0D0), "override zero: the constructor default answers");
        vm.prank(admin);
        pad.setTrustedRouter(address(0xBEEF1));
        assertEq(
            address(uint160(uint256(vm.load(p, bytes32(uint256(18)))))), address(0xBEEF1), "slot 18 = _router"
        );
        assertEq(pad.trustedRouter(), address(0xBEEF1), "the override wins");
        vm.prank(admin);
        pad.setTrustedRouter(address(0));
        assertEq(pad.trustedRouter(), address(0xD0D0), "clearing the override restores the default");
        assertEq(uint256(vm.load(p, bytes32(uint256(19)))), 0, "nothing after _router");
        assertEq(uint256(vm.load(p, bytes32(uint256(15)))), 1, "_lock untouched by the setters");
        assertEq(uint256(vm.load(p, bytes32(uint256(17)))), word, "_params untouched by setTrustedRouter");
    }

    /// The upgrade the live proxies take: initialised and traded under the
    /// previous implementation (`test/mocks/LegacyLaunchpad.sol`, the HEAD
    /// source), then `upgradeToAndCall(impl, "")` with no init data. Every
    /// pre-existing slot reads back unchanged, slot 17 is still zero, and the
    /// next fills split 15/10/6/69 exactly as before — no migration step.
    function test_UpgradeFromTheLegacyLayoutNeedsNoMigration() public {
        vm.warp(1_800_000_000);
        MockERC20 base = new MockERC20("USDG", "USDG", 6);
        PushPriceSource oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);

        // Old implementation (trusting router 0xA0A0), old proxy.
        LegacyStonkzLaunchpad legacyImpl = new LegacyStonkzLaunchpad(address(0xA0A0));
        address proxy = address(
            new ERC1967Proxy(
                address(legacyImpl),
                abi.encodeCall(
                    LegacyStonkzLaunchpad.initialize, (admin, protocolCold, opsCold, oracle, admin)
                )
            )
        );
        LegacyStonkzLaunchpad legacy = LegacyStonkzLaunchpad(proxy);
        assertEq(legacy.trustedRouter(), address(0xA0A0));
        vm.prank(admin);
        legacy.setPauser(address(0x9A05E));

        base.mint(trader, 1_000_000e6);
        vm.prank(trader);
        base.approve(proxy, type(uint256).max);
        vm.prank(creator);
        address token = legacy.createToken("Coin", "LEG", "u", 1_000_000_000, address(base), 250, false);
        vm.prank(trader);
        legacy.buy(token, 100e6, 0);
        (,, uint16 legacyBps) = legacy.quoteBuy(token, 1e6);
        assertEq(legacyBps, 250);

        // Snapshot every slot the old layout used, plus the coin record.
        bytes32[19] memory before;
        for (uint256 i = 0; i < 19; i++) {
            before[i] = vm.load(proxy, bytes32(i));
        }
        assertEq(uint256(before[15]), 1, "_lock");
        assertEq(uint256(before[17]), 0, "slot 17 was never written by the old implementation");
        assertEq(uint256(before[18]), 0, "slot 18 was never written by the old implementation");
        LegacyStonkzLaunchpad.Coin memory oldCoin = legacy.coinInfo(token);
        uint256 protocolBefore = legacy.protocolRevenue(address(base));

        // The upgrade: new implementation, same constructor default, no data.
        StonkzLaunchpad impl = new StonkzLaunchpad(address(0xA0A0));
        vm.prank(admin);
        legacy.upgradeToAndCall(address(impl), "");
        StonkzLaunchpad pad = StonkzLaunchpad(proxy);

        for (uint256 i = 0; i < 19; i++) {
            assertEq(vm.load(proxy, bytes32(i)), before[i], "a storage slot moved");
        }
        assertEq(pad.admin(), admin);
        assertEq(pad.pauser(), address(0x9A05E));
        assertEq(pad.trustedRouter(), address(0xA0A0), "router carried by the constructor, slot 18 empty");
        assertEq(uint256(vm.load(proxy, bytes32(uint256(17)))), 0, "_params still zero");
        assertEq(pad.paramsWord(), CurveMath.DEFAULT_PARAMS, "defaults in force");
        assertEq(keccak256(abi.encode(pad.coinInfo(token))), keccak256(abi.encode(oldCoin)), "coin intact");

        // Trades continue at the default split, exactly as the old code split them.
        StonkzLens lens = new StonkzLens();
        (CurveMath.BuyFill memory q,, uint16 bps) = lens.quoteBuy(pad, token, 50e6);
        assertEq(bps, 250);
        vm.prank(trader);
        pad.buy(token, 50e6, q.tokensOut);
        CurveMath.FeeShares memory want = CurveMath.splitFee(q.fee);
        assertEq(pad.protocolRevenue(address(base)) - protocolBefore, want.protocol, "15% platform leg");
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.protocolAccrued - oldCoin.protocolAccrued, want.protocol);
        assertEq(c.opsAccrued - oldCoin.opsAccrued, want.stonkzOps);
        assertEq(c.burnAccrued - oldCoin.burnAccrued, want.burn);
        assertEq(c.creatorBucketAccrued - oldCoin.creatorBucketAccrued, want.creatorBucket);
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
