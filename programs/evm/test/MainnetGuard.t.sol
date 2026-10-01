// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../src/StonkzRouter.sol";
import {ReferralVault} from "../src/ReferralVault.sol";
import {UniswapV3Migrator} from "../src/UniswapV3Migrator.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {ChainlinkPriceSource, AggregatorV3Interface} from "../src/oracle/ChainlinkPriceSource.sol";
import {StockPriceSourceV2} from "../src/oracle/StockPriceSourceV2.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {MainnetGuard} from "../script/MainnetGuard.sol";
import {GovernanceLib} from "../script/GovernanceLib.sol";
import {RouterWiring} from "../script/RouterWiring.sol";
import {GovernanceHandover} from "../script/GovernanceHandover.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
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
import {MockPyth} from "./mocks/MockPyth.sol";
import {V3Fixture} from "./mocks/V3Fixture.sol";

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
        DeployMainnet deployMainnet = new DeployMainnet();
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
        deployMainnet.run();
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
        deployMainnet.run();
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

    /// Stand code in at every third-party pin `DeployMainnet` hard-depends
    /// on: the real V3 factory runtime (for `feeAmountTickSpacing`), a Pyth
    /// that answers "no feed" (caught), aggregators for `setFeed`'s
    /// `decimals()`, and bare bytes where nothing is called at deploy time.
    function _standInPins() internal {
        (address ur, address weth, address sr02, address pyth) = RouterWiring.forChain();
        (address factory,) = RouterWiring.v3();
        (address clEth, address clStable,) = RouterWiring.chainlink();
        address[] memory stables = RouterWiring.stables();
        vm.etch(ur, hex"00");
        vm.etch(weth, hex"00");
        vm.etch(sr02, hex"00");
        for (uint256 i = 0; i < stables.length; i++) {
            vm.etch(stables[i], hex"00");
        }
        V3Fixture.deployAt(factory);
        vm.etch(pyth, address(new MockPyth(0)).code);
        address agg = address(new MockAggregator(8, 3_000e8));
        vm.etch(clEth, agg.code);
        if (clStable != address(0)) vm.etch(clStable, agg.code);
    }

    function _mainnetParams(DeployMainnet d) internal view returns (DeployMainnet.Params memory p) {
        p = d.defaults(_gov());
        p.protocolAuthority = address(0xC01D1);
        p.oracleAuthority = address(0x0AC1E);
        p.referralSigner = address(0x5163);
        p.referralMaxPerDay = 1 ether;
        p.attester = address(0xA77E57);
        p.maxBuyNative = 0.5 ether;
    }

    function _deployMainnetOn(uint256 chainId) internal returns (DeployMainnet.Result memory r) {
        vm.chainId(chainId);
        _standInPins();
        DeployMainnet d = new DeployMainnet();
        DeployMainnet.Params memory p = _mainnetParams(d);
        r = d.execute(p, address(this));

        (address ur, address weth, address sr02, address pyth) = RouterWiring.forChain();
        (address factory, uint24 fee) = RouterWiring.v3();
        (address clEth,,) = RouterWiring.chainlink();
        StonkzLaunchpad pad = StonkzLaunchpad(r.launchpad);
        TimelockController tl = TimelockController(payable(r.timelock));

        // The launchpad is governed, wired and priced by Pyth.
        assertEq(pad.admin(), r.timelock, "admin is the timelock");
        assertEq(pad.pendingAdmin(), address(0));
        assertEq(pad.pauser(), pauser);
        assertEq(pad.opsWithdrawAuthority(), ops);
        assertEq(pad.protocolWithdrawAuthority(), address(0xC01D1));
        assertEq(pad.migrationAuthority(), migration);
        assertEq(pad.trustedRouter(), r.router, "router trusted");
        assertEq(address(pad.migrator()), r.v3Migrator, "V3 migrator installed");
        assertEq(address(pad.priceSource()), r.pythPriceSource, "Pyth is the live source");
        assertEq(pad.maxOracleStaleness(), 90_000);
        // Layout pins (test_StorageLayoutIsAppendOnly), as the fork sees them.
        assertEq(address(uint160(uint256(vm.load(r.launchpad, bytes32(uint256(5)))))), r.timelock, "slot 5");
        assertEq(uint256(vm.load(r.launchpad, bytes32(uint256(15)))), 1, "slot 15 = _lock");
        assertEq(address(uint160(uint256(vm.load(r.launchpad, bytes32(uint256(16)))))), pauser, "slot 16");

        // Governance: the Safe proposes, nothing is left with the deployer.
        assertEq(tl.getMinDelay(), 1 days);
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), safe));
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(this)));
        assertEq(PythPriceSource(r.pythPriceSource).admin(), r.timelock, "pyth source admin");
        assertEq(ChainlinkPriceSource(r.chainlinkPriceSource).admin(), r.timelock, "chainlink admin");
        assertEq(StockPriceSourceV2(r.stockPriceSourceV2).admin(), r.timelock, "stock admin");
        assertEq(PushPriceSource(r.pushPriceSource).admin(), r.timelock, "push admin");
        assertEq(PushPriceSource(r.pushPriceSource).oracleAuthority(), address(0x0AC1E));

        // Pricing chain: Pyth(WETH feed, stables fixed) -> Chainlink; StockV2 empty.
        PythPriceSource pps = PythPriceSource(r.pythPriceSource);
        assertEq(address(pps.pyth()), pyth);
        assertEq(address(pps.fallbackSource()), r.chainlinkPriceSource);
        (bytes32 feedId, uint64 maxAge,,, uint64 fixedPrice) = pps.feeds(weth);
        assertEq(feedId, RouterWiring.PYTH_ETH_USD);
        assertEq(maxAge, 120);
        assertEq(fixedPrice, 0);
        address[] memory stables = RouterWiring.stables();
        for (uint256 i = 0; i < stables.length; i++) {
            (,,,, uint64 fp) = pps.feeds(stables[i]);
            assertEq(fp, 1e6, "stable fixed at $1");
        }
        (,,,,, bool clSet) = ChainlinkPriceSource(r.chainlinkPriceSource).feeds(weth);
        assertTrue(clSet, "Chainlink ETH/USD configured");
        assertEq(_aggregatorOf(r.chainlinkPriceSource, weth), clEth);
        StockPriceSourceV2 stock = StockPriceSourceV2(r.stockPriceSourceV2);
        assertEq(address(stock.quotePriceSource()), r.pythPriceSource);
        assertEq(address(stock.fallbackSource()), r.pushPriceSource);
        assertEq(stock.attester(), address(0xA77E57));
        assertFalse(stock.getConfig(address(0xBEEF)).set, "no stock bases on mainnet");

        // Router wiring, by chain id.
        StonkzRouter router = StonkzRouter(payable(r.router));
        assertEq(address(router.universalRouter()), ur);
        assertEq(address(router.weth()), weth);
        assertEq(address(router.swapRouter02()), sr02);
        assertEq(address(router.pyth()), pyth);
        assertEq(address(router.attestationSink()), r.stockPriceSourceV2);
        assertEq(router.maxBuyNative(), 0.5 ether);

        // Graduation on the chain's V3 factory at the 1% tier.
        UniswapV3Migrator m = UniswapV3Migrator(r.v3Migrator);
        assertEq(address(m.factory()), factory);
        assertEq(m.fee(), fee);
        assertEq(uint256(fee), 10_000);
        assertEq(m.tickSpacing(), 200);
        assertEq(address(m.locker()), r.feeLocker);

        // The referral vault is governed from birth and pausable by the pauser.
        ReferralVault v = ReferralVault(payable(r.referralVault));
        assertEq(v.admin(), r.timelock);
        assertEq(v.signer(), address(0x5163));
        assertEq(v.maxPerDay(weth), 1 ether);
        assertEq(v.launchpadPauser(), pauser);
        assertEq(v.weth(), weth);

        // The pauser stops instantly; only the timelock restarts.
        vm.prank(pauser);
        pad.pause(true, true, true, true, true);
        assertTrue(pad.tradingPaused() && pad.launchPaused());
        vm.expectRevert(bytes("not admin"));
        pad.setPause(false, false, false, false, false);
        bytes memory data = abi.encodeCall(pad.setPause, (false, false, false, false, false));
        vm.prank(safe);
        tl.schedule(r.launchpad, 0, data, bytes32(0), bytes32("unpause"), 1 days);
        vm.warp(block.timestamp + 1 days);
        vm.prank(safe);
        tl.execute(r.launchpad, 0, data, bytes32(0), bytes32("unpause"));
        assertFalse(pad.tradingPaused());
    }

    function _aggregatorOf(address source, address token) internal view returns (address) {
        (AggregatorV3Interface agg,,,,,) = ChainlinkPriceSource(source).feeds(token);
        return address(agg);
    }

    function test_DeployMainnetEndsGovernedOnRobinhood() public {
        _deployMainnetOn(4663);
    }

    function test_DeployMainnetEndsGovernedOnBase() public {
        _deployMainnetOn(8453);
    }

    function test_DeployMainnetRefusesBadInputs() public {
        DeployMainnet d = new DeployMainnet();
        DeployMainnet.Params memory p = _mainnetParams(d);

        // Not a supported mainnet: the testnets, and Arc (deferred).
        vm.chainId(46630);
        vm.expectRevert();
        d.execute(p, address(this));
        vm.chainId(5042);
        vm.expectRevert();
        d.execute(p, address(this));

        vm.chainId(4663);
        _standInPins();
        DeployMainnet.Params memory bad = _mainnetParams(d);
        bad.gov.pauser = address(0);
        vm.expectRevert(bytes("MainnetGuard: PAUSER is required on mainnet"));
        d.execute(bad, address(this));

        bad = _mainnetParams(d);
        bad.referralSigner = address(0);
        vm.expectRevert(bytes("DeployMainnet: REFERRAL_SIGNER is required (non-zero)"));
        d.execute(bad, address(this));

        bad = _mainnetParams(d);
        bad.referralMaxPerDay = type(uint256).max;
        vm.expectRevert(bytes("DeployMainnet: an uncapped referral vault is not allowed"));
        d.execute(bad, address(this));

        bad = _mainnetParams(d);
        bad.protocolAuthority = ops;
        vm.expectRevert(bytes("DeployMainnet: protocol and ops withdraw authorities must differ"));
        d.execute(bad, address(this));

        // Forge's default sender is never the temporary admin.
        vm.expectRevert(
            bytes("DeployMainnet: pass the signer (--ledger/--account + --sender, or PRIVATE_KEY)")
        );
        d.execute(p, 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38);

        // A pinned dependency without code stops the run before any deploy.
        (, address weth,,) = RouterWiring.forChain();
        vm.etch(weth, "");
        vm.expectRevert(bytes("DeployMainnet: pinned dependency has no code on this chain"));
        d.execute(p, address(this));
    }

    /// The legacy `Deploy` script never deploys on a mainnet chain id, even
    /// with the governance set in hand: the mainnet stack is `DeployMainnet`.
    function test_LegacyDeployHasNoMainnetPath() public {
        vm.chainId(4663);
        Deploy d = new Deploy();
        // Without the env it stops at the guard (above); the mainnet path
        // itself is gone from the contract.
        (bool ok,) = address(d)
            .call(
                abi.encodeWithSignature(
                    "deployMainnet((address[],address[],uint256,address,address,address),address)",
                    _gov(),
                    address(1)
                )
            );
        assertFalse(ok, "deployMainnet no longer exists on Deploy");
    }
}
