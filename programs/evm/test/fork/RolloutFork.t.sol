// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {StonkzLaunchpad} from "../../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../../src/StonkzRouter.sol";
import {StonkzToken} from "../../src/StonkzToken.sol";
import {PushPriceSource} from "../../src/oracle/PushPriceSource.sol";
import {PythPriceSource} from "../../src/oracle/PythPriceSource.sol";
import {UniswapV2Migrator} from "../../src/UniswapV2Migrator.sol";
import {StonkzV2Factory, StonkzV2Pair} from "../../src/testnet/StonkzV2Factory.sol";
import {UpgradeAtomicLaunch} from "../../script/UpgradeAtomicLaunch.s.sol";
import {MainnetGuard} from "../../script/MainnetGuard.sol";
import {DeployMigrator} from "../../script/DeployMigrator.s.sol";
import {GovernanceHandover} from "../../script/GovernanceHandover.s.sol";
import {GovernanceLib} from "../../script/GovernanceLib.sol";

interface IWETHLike {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Dry-runs all three rollouts — atomic launch, griefing-proof
/// migrator, governance handover — against the **live** proxies on a fork,
/// in the order they would ship. Keys are replaced by writing a test address
/// into the admin slots of the fork (never the chain). Skipped unless
/// `ROLLOUT_FORK_RPC` and `ROLLOUT_FORK_PROXY` are set, e.g.:
///
/// ```
/// ROLLOUT_FORK_RPC=https://rpc.testnet.chain.robinhood.com \
/// ROLLOUT_FORK_PROXY=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 \
///   forge test --match-path test/fork/RolloutFork.t.sol -vv
/// ```
contract RolloutForkTest is Test {
    uint256 constant KEY = 0xF0CC; // test-only stand-in for the admin EOA
    address constant SAFE = address(0x5AFE);

    function test_RolloutOnALiveProxy() public {
        string memory rpc = vm.envOr("ROLLOUT_FORK_RPC", string(""));
        address proxy = vm.envOr("ROLLOUT_FORK_PROXY", address(0));
        if (bytes(rpc).length == 0 || proxy == address(0)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        address me = vm.addr(KEY);
        StonkzLaunchpad pad = StonkzLaunchpad(proxy);
        PushPriceSource ps = PushPriceSource(address(pad.priceSource()));

        // Stand the test key in for the live admin EOA (slot 5 launchpad, slot 0 oracle).
        vm.store(proxy, bytes32(uint256(5)), bytes32(uint256(uint160(me))));
        vm.store(address(ps), bytes32(uint256(0)), bytes32(uint256(uint160(me))));

        uint256 tokenCount = pad.tokenCount();
        bytes32[16] memory before;
        for (uint256 i = 0; i < 16; i++) {
            before[i] = vm.load(proxy, bytes32(i));
        }

        // 1. Atomic launch.
        UpgradeAtomicLaunch up = new UpgradeAtomicLaunch();
        UpgradeAtomicLaunch.Result memory res = up.execute(up.defaults(proxy), KEY);
        address router = res.router;
        for (uint256 i = 0; i < 16; i++) {
            // 11/12 are priceSource / maxOracleStaleness, which the rollout switches on purpose.
            if (i == 11 || i == 12) continue;
            assertEq(vm.load(proxy, bytes32(i)), before[i], "a live slot moved");
        }
        assertEq(address(pad.priceSource()), res.priceSource);
        assertEq(pad.maxOracleStaleness(), 120);
        assertEq(pad.tokenCount(), tokenCount);
        assertEq(pad.trustedRouter(), router);

        address weth = address(StonkzRouter(payable(router)).weth());
        address user = address(0xC4EA7);
        vm.deal(user, 200 ether);
        StonkzRouter.CreateParams memory p = StonkzRouter.CreateParams({
            name: "Fork Coin",
            ticker: "FORKX",
            uri: "ipfs://x",
            supply: 1_000_000_000,
            baseToken: weth,
            feeBps: 250,
            cashback: false
        });

        // The live on-chain Pyth ETH/USD is older than 120 s: without an
        // update, a launch is refused.
        (uint256 live, uint256 at,) = PythPriceSource(res.priceSource).priceUsd1e6(weth);
        if (live == 0 || block.timestamp - at > 120) {
            vm.prank(user);
            vm.expectRevert(bytes("stale oracle"));
            StonkzRouter(payable(router)).createAndBuyWithEth{value: 1 ether}(
                p, new bytes[](0), 1, block.timestamp + 60
            );
        }

        // With a real Hermes update (hex in ROLLOUT_FORK_PYTH_UPDATE, fetched
        // moments before the run) the real Pyth contract verifies and posts
        // it in the launch transaction. Without one, stand a fixed price in.
        bytes memory hermes = vm.envOr("ROLLOUT_FORK_PYTH_UPDATE", bytes(""));
        bytes[] memory updates;
        if (hermes.length > 0) {
            updates = new bytes[](1);
            updates[0] = hermes;
        } else {
            vm.prank(me);
            PythPriceSource(res.priceSource).setFixedPrice(weth, 3_000e6, 120);
        }
        vm.prank(user);
        (address token, uint256 out) = StonkzRouter(payable(router)).createAndBuyWithEth{value: 1 ether}(
            p, updates, 1, block.timestamp + 60
        );
        assertEq(pad.coinInfo(token).creator, user);
        assertEq(StonkzToken(token).balanceOf(user), out);

        // 2. Migrator: exhaust the curve, seed a skewed pair, graduate, migrate.
        (address migrator, address factory) =
            new DeployMigrator().execute(proxy, KEY, address(0), me, _noGov());
        vm.prank(user);
        StonkzRouter(payable(router)).buyWithEth{value: 60 ether}(token, 0, block.timestamp + 60);
        pad.graduate(token);
        address pair = StonkzV2Factory(factory).createPair(token, weth);
        vm.startPrank(user);
        StonkzToken(token).transfer(pair, 1e6);
        IWETHLike(weth).deposit{value: 1e6}();
        IWETHLike(weth).transfer(pair, 1e6);
        StonkzV2Pair(pair).mint(user);
        vm.stopPrank();
        vm.prank(me);
        pad.migrateLiquidity(token);
        assertGt(StonkzV2Pair(pair).balanceOf(UniswapV2Migrator(migrator).BURN_ADDRESS()), 0, "graduated");

        // 3. Governance.
        GovernanceHandover g = new GovernanceHandover();
        GovernanceLib.Config memory c;
        c.launchpad = proxy;
        c.priceSources = g.defaultPriceSources(pad);
        c.proposers = new address[](1);
        c.proposers[0] = SAFE;
        c.executors = c.proposers;
        c.minDelay = 2 days;
        c.protocolAuthority = pad.protocolWithdrawAuthority();
        c.opsAuthority = address(0x0B5);
        c.migrationAuthority = address(0x316);
        c.migrator = migrator;
        c.pauser = address(0x9A05E);
        c.atomic = true;
        TimelockController tl = g.execute(c, KEY);
        assertEq(pad.admin(), address(tl));
        assertEq(ps.admin(), address(tl));
        vm.prank(me);
        vm.expectRevert(bytes("not admin"));
        pad.setPause(true, true, true, true, true);
        // The pauser stops the live proxy instantly; only the timelock restarts it.
        vm.prank(address(0x9A05E));
        pad.pause(true, true, true, true, true);
        assertTrue(pad.tradingPaused() && pad.launchPaused());
        assertEq(uint256(vm.load(proxy, bytes32(uint256(16)))), uint256(uint160(address(0x9A05E))), "slot 16");
    }

    function _noGov() internal pure returns (MainnetGuard.Governance memory g) {}
}
