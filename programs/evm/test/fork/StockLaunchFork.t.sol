// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {StonkzLaunchpad} from "../../src/StonkzLaunchpad.sol";
import {StonkzRouter} from "../../src/StonkzRouter.sol";
import {StonkzToken} from "../../src/StonkzToken.sol";
import {PythPriceSource} from "../../src/oracle/PythPriceSource.sol";
import {StockPriceSource} from "../../src/oracle/StockPriceSource.sol";
import {IPyth} from "../../src/oracle/IPyth.sol";
import {StockBases} from "../../src/config/StockBases.sol";
import {RobinhoodChainTestnet} from "../../src/config/RobinhoodChainTestnet.sol";
import {UpgradeStockLaunch} from "../../script/UpgradeStockLaunch.s.sol";
import {DeployStockPriceSource} from "../../script/DeployStockPriceSource.s.sol";
import {SeedStockPool} from "../../script/SeedStockPool.s.sol";
import {UpgradeAttestedStockLaunch} from "../../script/UpgradeAttestedStockLaunch.s.sol";
import {StockPriceSourceV2} from "../../src/oracle/StockPriceSourceV2.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IERC20Fork {
    function balanceOf(address) external view returns (uint256);
}

/// @notice The whole stock-base rollout against the **live** RH 46630 state on
/// a fork: `UpgradeStockLaunch` (new router + impl, in place),
/// `DeployStockPriceSource` (configure the five stocks, grow cardinality, become
/// PythPriceSource's fallback), `SeedStockPool` on the empty TSLA/WETH pool
/// (TSLA via `deal`, as if from the faucet), wait out the TWAP window, then a
/// TSLA-base launch + dev buy through the new router's `createAndBuyViaV3`
/// with no push — the real SwapRouter02 and the real pool on the swap leg.
///
/// Admin keys are replaced on the fork only (a test key written into the admin
/// slots). Pyth cannot be signed for here, so ETH/USD is mocked fresh at the
/// Pyth contract; the TSLA equity feed is left as the chain has it (never
/// updated on 46630), i.e. the weekend case. Skipped unless `STOCK_FORK_RPC`
/// is set:
///
/// ```
/// STOCK_FORK_RPC=https://rpc.testnet.chain.robinhood.com \
///   forge test --match-path test/fork/StockLaunchFork.t.sol -vv
/// ```
/// `STOCK_FORK_PROXY` overrides the launchpad (default: the live 46630 proxy).
contract StockLaunchForkTest is Test {
    uint256 constant KEY = 0xF0CC; // test-only stand-in for the admin EOA
    bytes32 constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    address constant LIVE_PROXY = 0xe308287C9A85E2B53F1027a1c589B5e3969928e8;

    function test_StockBaseLaunchOnTheLiveTestnet() public {
        string memory rpc = vm.envOr("STOCK_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == RobinhoodChainTestnet.CHAIN_ID, "fork is not RH 46630");
        address proxy = vm.envOr("STOCK_FORK_PROXY", LIVE_PROXY);
        address me = vm.addr(KEY);
        StonkzLaunchpad pad = StonkzLaunchpad(proxy);
        PythPriceSource pps = PythPriceSource(address(pad.priceSource()));
        // The push oracle: PythPriceSource's fallback, or the fallback of the
        // stock source already sitting there (after the first rollout).
        address push = address(pps.fallbackSource());
        (bool isStock, bytes memory ret) = push.staticcall(abi.encodeWithSignature("quotePriceSource()"));
        if (isStock && ret.length == 32) push = address(StockPriceSource(push).fallbackSource());

        // Stand the test key in for the live admin EOA: launchpad slot 5,
        // PythPriceSource slot 0.
        vm.store(proxy, bytes32(uint256(5)), bytes32(uint256(uint160(me))));
        vm.store(address(pps), bytes32(uint256(0)), bytes32(uint256(uint160(me))));
        uint256 tokenCount = pad.tokenCount();

        // 1. New router + implementation, in place.
        UpgradeStockLaunch up = new UpgradeStockLaunch();
        UpgradeStockLaunch.Result memory ur = up.execute(up.defaults(proxy), KEY);
        assertTrue(ur.upgraded);
        assertEq(pad.trustedRouter(), ur.router);
        assertEq(pad.tokenCount(), tokenCount, "state carried over");
        StonkzRouter router = StonkzRouter(payable(ur.router));

        // 2. The stock price source, wired behind PythPriceSource.
        DeployStockPriceSource dep = new DeployStockPriceSource();
        DeployStockPriceSource.Result memory dr = dep.execute(dep.defaults(address(pps)), KEY);
        StockPriceSource sps = StockPriceSource(dr.source);
        assertEq(dr.configured, 5, "all five stocks");
        assertEq(address(pps.fallbackSource()), dr.source);
        assertEq(address(sps.fallbackSource()), push, "push oracle behind it");
        assertEq(address(sps.quotePriceSource()), address(pps));

        // 3. Seed the empty TSLA/WETH pool at $250 / $4,000 (1 WETH = 16 TSLA).
        address tsla = StockBases.RH_TESTNET_TSLA;
        deal(tsla, me, 200e18);
        vm.deal(me, 20 ether);
        SeedStockPool seed = new SeedStockPool();
        SeedStockPool.Result memory sr = seed.execute(
            SeedStockPool.Params({
                stock: tsla,
                pool: StockBases.RH_TESTNET_TSLA_WETH,
                stockUsd1e6: 250e6,
                quoteUsd1e6: 4000e6,
                stockAmount: 200e18,
                quoteAmount: 0,
                maxPriceGapBps: 100,
                stockPriceSource: dr.source
            }),
            KEY
        );
        assertTrue(sr.repriced, "the placeholder 1:1 price was moved");
        assertGt(sr.liquidity, 1e17, "clears the default floor");

        // Right after seeding the window is still mostly empty: no TWAP yet.
        _mockEth();
        assertEq(sps.legs(tsla).twapPrice1e6, 0, "not until the window fills");

        // 4. Half an hour later, at any hour, with no push.
        vm.warp(block.timestamp + 1801);
        _mockEth();
        (uint256 usd,,) = pps.priceUsd1e6(tsla);
        assertApproxEqRel(usd, 250e6, 0.002e18, "TWAP at the seeded price");

        address user = address(0xC4EA7);
        vm.deal(user, 1 ether);
        bytes[] memory none = new bytes[](0);
        StonkzRouter.CreateParams memory p = StonkzRouter.CreateParams({
            name: "Fork Stock Coin",
            ticker: "FORKTSLA",
            uri: "ipfs://fork",
            supply: 1_000_000_000,
            baseToken: tsla,
            feeBps: 250,
            cashback: false
        });
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyViaV3{value: 0.05 ether}(p, none, 3000, 0.7e18, 1, block.timestamp + 60);

        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.creator, user);
        assertEq(c.baseToken, tsla);
        assertApproxEqRel(c.creationPrice1e6, 250e6, 0.002e18);
        assertGt(out, 0);
        assertEq(StonkzToken(token).balanceOf(user), out);
        assertEq(IERC20Fork(tsla).balanceOf(address(router)), 0, "router keeps no TSLA");
        assertEq(address(router).balance, 0, "router keeps no ETH");
        assertEq(pad.tokenCount(), tokenCount + 1);
    }

    /// Signed per-launch prices on the live chain: `UpgradeAttestedStockLaunch`
    /// against today's wiring (V1 stock source, empty pools), then a TSLA-base
    /// launch whose only TSLA price is an attestation in `priceUpdate`
    /// (`createWithPriceUpdate`; the live pools are empty, so no V3 dev buy is
    /// possible on the fork — `createAndBuyViaV3` is covered locally).
    function test_AttestedStockLaunchOnTheLiveTestnet() public {
        string memory rpc = vm.envOr("STOCK_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == RobinhoodChainTestnet.CHAIN_ID, "fork is not RH 46630");
        address proxy = vm.envOr("STOCK_FORK_PROXY", LIVE_PROXY);
        address me = vm.addr(KEY);
        uint256 attesterKey = 0xA77E57; // test-only
        StonkzLaunchpad pad = StonkzLaunchpad(proxy);
        PythPriceSource pps = PythPriceSource(address(pad.priceSource()));
        vm.store(proxy, bytes32(uint256(5)), bytes32(uint256(uint160(me))));
        vm.store(address(pps), bytes32(uint256(0)), bytes32(uint256(uint160(me))));
        uint256 tokenCount = pad.tokenCount();

        UpgradeAttestedStockLaunch up = new UpgradeAttestedStockLaunch();
        UpgradeAttestedStockLaunch.Params memory p = up.defaults(proxy);
        p.attester = vm.addr(attesterKey);
        UpgradeAttestedStockLaunch.Result memory r = up.execute(p, KEY);
        assertTrue(r.upgraded && r.fallbackSet);
        assertEq(r.configured, 5);
        assertEq(pad.trustedRouter(), r.router);
        assertEq(pad.tokenCount(), tokenCount);
        StockPriceSourceV2 v2 = StockPriceSourceV2(r.source);

        address tsla = StockBases.RH_TESTNET_TSLA;
        _mockEth();
        uint64 price = 251_230_000;
        StockPriceSourceV2.Legs memory l = v2.legs(tsla);
        if (l.twapPrice1e6 != 0) price = uint64(l.twapPrice1e6); // a seeded pool must agree
        uint64 t = uint64(block.timestamp);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(v2.attestationDigest(tsla, price, t));
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(attesterKey, digest);
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(bytes4("STKA"), tsla, price, t, abi.encodePacked(rr, ss, v));

        address user = address(0xC4EA7);
        StonkzRouter.CreateParams memory cp = StonkzRouter.CreateParams({
            name: "Attested Fork Coin",
            ticker: "ATTSLA",
            uri: "ipfs://fork",
            supply: 1_000_000_000,
            baseToken: tsla,
            feeBps: 250,
            cashback: false
        });
        vm.prank(user);
        address token = StonkzRouter(payable(r.router)).createWithPriceUpdate(cp, u, block.timestamp + 60);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.creator, user);
        assertEq(c.baseToken, tsla);
        assertEq(c.creationPrice1e6, price, "priced by the attestation");
        assertEq(pad.tokenCount(), tokenCount + 1);
    }

    /// ETH/USD, fresh as of this block, at the live Pyth contract.
    function _mockEth() internal {
        vm.mockCall(
            RobinhoodChainTestnet.PYTH,
            abi.encodeCall(IPyth.getPriceUnsafe, (ETH_USD)),
            abi.encode(IPyth.Price(4000e8, 0, -8, block.timestamp))
        );
    }
}
