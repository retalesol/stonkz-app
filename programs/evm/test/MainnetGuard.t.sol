// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {MainnetGuard} from "../script/MainnetGuard.sol";
import {GovernanceLib} from "../script/GovernanceLib.sol";
import {GovernanceHandover} from "../script/GovernanceHandover.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployArc} from "../script/DeployArc.s.sol";
import {DeployRouter} from "../script/DeployRouter.s.sol";
import {DeployMigrator} from "../script/DeployMigrator.s.sol";
import {UpgradeAtomicLaunch} from "../script/UpgradeAtomicLaunch.s.sol";
import {UpgradeLaunchpad} from "../script/UpgradeLaunchpad.s.sol";
import {SwitchPriceSource} from "../script/SwitchPriceSource.s.sol";
import {UpgradeStockLaunch} from "../script/UpgradeStockLaunch.s.sol";
import {DeployStockPriceSource} from "../script/DeployStockPriceSource.s.sol";
import {UpgradeAttestedStockLaunch} from "../script/UpgradeAttestedStockLaunch.s.sol";
import {MockAggregator} from "./mocks/Mocks.sol";

contract GuardHarness {
    function validate(MainnetGuard.Governance memory g) external pure {
        MainnetGuard.validate(g);
    }

    function requireTimelockAdmin(StonkzLaunchpad pad, MainnetGuard.Governance memory g) external view {
        MainnetGuard.requireTimelockAdmin(pad, g);
    }
}

/// @notice Testnets may skip the multisig; mainnet (RH 4663, Base 8453, Arc
/// 5042) may not. Every deploy/upgrade script that can reach a mainnet stops
/// at its first line, naming what is missing, and the mainnet deploy ends
/// with no EOA admin. (These tests assume the governance env — `PROPOSERS`
/// and friends — is not exported in the shell running `forge test`.)
contract MainnetGuardTest is Test {
    string constant MISSING = "MainnetGuard: PROPOSERS (the Safe) is required on mainnet";
    uint256 constant EOA_KEY = 0xE0A11CE; // test-only key
    address safe = address(0x5AFE);
    address pauser = address(0x9A05E);
    address ops = address(0x0B5);
    address migration = address(0x316);
    GuardHarness h;

    function setUp() public {
        vm.warp(1_800_000_000);
        h = new GuardHarness();
    }

    function _gov() internal view returns (MainnetGuard.Governance memory g) {
        g.proposers = new address[](1);
        g.proposers[0] = safe;
        g.executors = g.proposers;
        g.minDelay = 1 days;
        g.pauser = pauser;
        g.opsAuthority = ops;
        g.migrationAuthority = migration;
    }

    /* ------------------------------------- every script refuses without env */

    function test_EveryMainnetScriptRefusesWithoutGovernanceEnv() public {
        Deploy deploy = new Deploy();
        DeployArc deployArc = new DeployArc();
        DeployRouter deployRouter = new DeployRouter();
        UpgradeAtomicLaunch upgradeAtomic = new UpgradeAtomicLaunch();
        DeployMigrator deployMigrator = new DeployMigrator();
        UpgradeLaunchpad upgradeLaunchpad = new UpgradeLaunchpad();
        GovernanceHandover handover = new GovernanceHandover();
        SwitchPriceSource switchSource = new SwitchPriceSource();
        UpgradeStockLaunch upgradeStock = new UpgradeStockLaunch();
        DeployStockPriceSource deployStock = new DeployStockPriceSource();
        UpgradeAttestedStockLaunch upgradeAttested = new UpgradeAttestedStockLaunch();

        vm.chainId(4663);
        vm.expectRevert(bytes(MISSING));
        deploy.run();
        vm.expectRevert(bytes(MISSING));
        deployRouter.run();
        vm.expectRevert(bytes(MISSING));
        upgradeAtomic.run();
        vm.expectRevert(bytes(MISSING));
        deployMigrator.run();
        vm.expectRevert(bytes(MISSING));
        upgradeLaunchpad.run();
        vm.expectRevert(bytes(MISSING));
        handover.run();
        vm.expectRevert(bytes(MISSING));
        switchSource.run();
        vm.expectRevert(bytes(MISSING));
        upgradeStock.run();
        vm.expectRevert(bytes(MISSING));
        deployStock.run();
        vm.expectRevert(bytes(MISSING));
        upgradeAttested.run();

        vm.chainId(8453);
        vm.expectRevert(bytes(MISSING));
        upgradeLaunchpad.run();
        vm.expectRevert(bytes(MISSING));
        deployStock.run();
        vm.expectRevert(bytes(MISSING));
        deployMigrator.run();

        vm.chainId(5042);
        vm.expectRevert(bytes(MISSING));
        deployArc.run();
    }

    /* ------------------------------------------------------------ validate */

    function test_ValidateNamesWhatIsMissing() public {
        MainnetGuard.Governance memory g = _gov();
        h.validate(g);

        g = _gov();
        g.proposers = new address[](0);
        g.executors = g.proposers;
        vm.expectRevert(bytes(MISSING));
        h.validate(g);

        g = _gov();
        g.proposers[0] = address(0);
        vm.expectRevert(bytes("MainnetGuard: PROPOSERS has a zero address"));
        h.validate(g);

        g = _gov();
        g.minDelay = 1 days - 1;
        vm.expectRevert(bytes("MainnetGuard: MIN_DELAY must be >= 86400 (24h) on mainnet"));
        h.validate(g);

        g = _gov();
        g.pauser = address(0);
        vm.expectRevert(bytes("MainnetGuard: PAUSER is required on mainnet"));
        h.validate(g);

        g = _gov();
        g.opsAuthority = address(0);
        vm.expectRevert(bytes("MainnetGuard: NEW_OPS_WITHDRAW_AUTHORITY is required on mainnet"));
        h.validate(g);

        g = _gov();
        g.migrationAuthority = address(0);
        vm.expectRevert(bytes("MainnetGuard: NEW_MIGRATION_AUTHORITY is required on mainnet"));
        h.validate(g);
    }

    /* ------------------------------------------- upgrades need a timelock */

    /// A launchpad handed over on a testnet chain id (delay 1 day), then read
    /// as if on mainnet.
    function _governedPad() internal returns (StonkzLaunchpad pad, TimelockController tl) {
        address eoa = vm.addr(EOA_KEY);
        PushPriceSource oracle = DeployPad.pushOracle(eoa, eoa, 90_000);
        pad = DeployPad.launchpad(eoa, address(0xC01D1), eoa, oracle, eoa);
        GovernanceLib.Config memory c;
        c.launchpad = address(pad);
        c.priceSources = new address[](1);
        c.priceSources[0] = address(oracle);
        c.proposers = _gov().proposers;
        c.executors = c.proposers;
        c.minDelay = 1 days;
        c.protocolAuthority = address(0xC01D1);
        c.opsAuthority = ops;
        c.migrationAuthority = migration;
        c.pauser = pauser;
        c.atomic = true;
        tl = new GovernanceHandover().execute(c, EOA_KEY);
    }

    function test_UpgradesOnMainnetRequireATimelockAdmin() public {
        address eoa = vm.addr(EOA_KEY);
        StonkzLaunchpad eoaPad =
            DeployPad.launchpad(eoa, address(1), ops, DeployPad.pushOracle(eoa, eoa, 1), migration);
        vm.expectRevert(bytes("MainnetGuard: launchpad admin is an EOA; run GovernanceHandover first"));
        h.requireTimelockAdmin(eoaPad, _gov());

        (StonkzLaunchpad pad,) = _governedPad();
        h.requireTimelockAdmin(pad, _gov());

        MainnetGuard.Governance memory g = _gov();
        g.opsAuthority = address(0xBAD);
        vm.expectRevert(bytes("MainnetGuard: NEW_OPS_WITHDRAW_AUTHORITY is not the launchpad's"));
        h.requireTimelockAdmin(pad, g);
        g = _gov();
        g.pauser = address(0xBAD);
        vm.expectRevert(bytes("MainnetGuard: PAUSER is not the launchpad's"));
        h.requireTimelockAdmin(pad, g);
        g = _gov();
        g.proposers[0] = address(0xBAD);
        vm.expectRevert(bytes("MainnetGuard: PROPOSERS is not the timelock's"));
        h.requireTimelockAdmin(pad, g);
    }

    /// On mainnet `UpgradeAtomicLaunch` deploys but never touches the proxy,
    /// even when its signer is the timelock's own proposer: it prints the batch.
    function test_UpgradeAtomicLaunchOnMainnetOnlyEmitsCalldata() public {
        (StonkzLaunchpad pad,) = _governedPad();
        vm.chainId(4663);
        UpgradeAtomicLaunch s = new UpgradeAtomicLaunch();
        UpgradeAtomicLaunch.Params memory p = s.defaults(address(pad));
        p.gov = _gov();
        UpgradeAtomicLaunch.Result memory r = s.execute(p, EOA_KEY);
        assertTrue(r.router.code.length > 0 && r.impl.code.length > 0, "deployed");
        assertEq(pad.trustedRouter(), address(0), "proxy untouched");

        // And with an EOA admin it refuses outright.
        address eoa = vm.addr(EOA_KEY);
        StonkzLaunchpad eoaPad =
            DeployPad.launchpad(eoa, address(1), ops, DeployPad.pushOracle(eoa, eoa, 1), migration);
        p = s.defaults(address(eoaPad));
        p.gov = _gov();
        vm.expectRevert(bytes("MainnetGuard: launchpad admin is an EOA; run GovernanceHandover first"));
        s.execute(p, EOA_KEY);
    }

    /// Same for `UpgradeStockLaunch`: deploy, print, never call the proxy.
    function test_UpgradeStockLaunchOnMainnetOnlyEmitsCalldata() public {
        (StonkzLaunchpad pad,) = _governedPad();
        vm.chainId(4663);
        UpgradeStockLaunch s = new UpgradeStockLaunch();
        UpgradeStockLaunch.Params memory p = s.defaults(address(pad));
        p.gov = _gov();
        UpgradeStockLaunch.Result memory r = s.execute(p, EOA_KEY);
        assertTrue(r.router.code.length > 0 && r.impl.code.length > 0, "deployed");
        assertFalse(r.upgraded);
        assertEq(pad.trustedRouter(), address(0), "proxy untouched");
    }

    function test_DeployMigratorOnMainnetOnlyEmitsCalldata() public {
        (StonkzLaunchpad pad,) = _governedPad();
        address before = address(pad.migrator());
        vm.etch(address(0xFAC), hex"00");
        vm.chainId(4663);
        (address migrator,) =
            new DeployMigrator().execute(address(pad), EOA_KEY, address(0xFAC), migration, _gov());
        assertTrue(migrator.code.length > 0);
        assertEq(address(pad.migrator()), before, "setMigrator left to the timelock");
    }

    function test_HandoverOnMainnetEnforcesTheMainnetDelay() public {
        address eoa = vm.addr(EOA_KEY);
        PushPriceSource oracle = DeployPad.pushOracle(eoa, eoa, 90_000);
        StonkzLaunchpad pad = DeployPad.launchpad(eoa, address(0xC01D1), eoa, oracle, eoa);
        GovernanceLib.Config memory c;
        c.launchpad = address(pad);
        c.priceSources = new address[](1);
        c.priceSources[0] = address(oracle);
        c.proposers = _gov().proposers;
        c.executors = c.proposers;
        c.minDelay = 1 hours;
        c.protocolAuthority = address(0xC01D1);
        c.opsAuthority = ops;
        c.migrationAuthority = migration;
        c.pauser = pauser;
        c.atomic = true;
        vm.chainId(4663);
        GovernanceHandover g = new GovernanceHandover();
        vm.expectRevert(bytes("MainnetGuard: MIN_DELAY must be >= 86400 (24h) on mainnet"));
        g.execute(c, EOA_KEY);
    }

    /* ---------------------------------- the mainnet deploy ends governed */

    function test_MainnetDeployEndsWithTheTimelockAsAdmin() public {
        vm.chainId(4663);
        // Stand code in at the pinned third-party addresses.
        address agg = address(new MockAggregator(8, 3_000e8));
        vm.etch(RobinhoodChain.CHAINLINK_ETH_USD, agg.code);
        vm.etch(RobinhoodChain.CHAINLINK_USDG_USD, agg.code);
        vm.etch(RobinhoodChain.UNIVERSAL_ROUTER, hex"00");
        vm.etch(RobinhoodChain.UNISWAP_V2_FACTORY, hex"00");
        vm.etch(RobinhoodChain.WETH9, hex"00");

        Deploy d = new Deploy();
        (StonkzLaunchpad pad, TimelockController tl) = d.deployMainnet(_gov(), address(0xC01D1));

        assertEq(pad.admin(), address(tl), "admin is the timelock");
        assertEq(pad.pendingAdmin(), address(0));
        assertEq(pad.pauser(), pauser);
        assertEq(pad.opsWithdrawAuthority(), ops);
        assertEq(pad.migrationAuthority(), migration);
        assertTrue(pad.trustedRouter() != address(0), "router trusted");
        assertEq(tl.getMinDelay(), 1 days);
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), safe));
        // The deployer (this test contract) holds nothing.
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), address(this)));
        (bool ok, bytes memory ret) =
            address(pad.priceSource()).staticcall(abi.encodeWithSignature("admin()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), address(tl), "price source admin is the timelock");

        MainnetGuard.Governance memory bad = _gov();
        bad.pauser = address(0);
        vm.expectRevert(bytes("MainnetGuard: PAUSER is required on mainnet"));
        d.deployMainnet(bad, address(0xC01D1));
    }
}
