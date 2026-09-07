// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainlinkPriceSource, AggregatorV3Interface} from "../src/oracle/ChainlinkPriceSource.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {MockAggregator, MockERC20} from "./mocks/Mocks.sol";

/// @notice The oracle behaviour that `docs/robinhood-chain.md` §4.4 and §8 say
/// this chain forces on us. Two of these tests exist because the obvious
/// implementation is wrong on chain 4663 specifically.
contract OracleTest is Test {
    ChainlinkPriceSource src;
    MockAggregator agg;
    MockERC20 weth;

    address admin = address(0xA11CE);

    /// The ETH/USD feed on chain 4663 publishes 8 decimals.
    uint8 constant FEED_DECIMALS = 8;
    /// And has a **24-hour** heartbeat. Not an hour.
    uint64 constant HEARTBEAT = 86_400;
    uint64 constant GRACE = 3_600;

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        agg = new MockAggregator(FEED_DECIMALS, 3_000e8);
        src = new ChainlinkPriceSource(admin);
        vm.prank(admin);
        src.setFeed(
            address(weth), AggregatorV3Interface(address(agg)), HEARTBEAT + GRACE, 100e6, 100_000e6
        );
    }

    function test_ScalesAnEightDecimalFeedTo1e6() public view {
        (uint256 p,, uint256 maxAge) = src.priceUsd1e6(address(weth));
        assertEq(p, 3_000_000_000, "$3,000 in 1e6 fixed point");
        assertEq(maxAge, HEARTBEAT + GRACE);
    }

    /// The one that matters most. A conventional one-hour staleness guard would
    /// mark this feed dead 23 hours out of every 24 and make oracle-triggered
    /// graduation unreachable.
    function test_AFeedTwentyHoursOldIsStillFresh() public {
        vm.warp(block.timestamp + 20 hours);
        (uint256 p,,) = src.priceUsd1e6(address(weth));
        assertEq(p, 3_000_000_000, "20h is well inside a 24h heartbeat");

        // A launchpad wired to this source agrees.
        StonkzLaunchpad pad = new StonkzLaunchpad(admin, admin, admin, src, admin);
        assertEq(pad.maxOracleStaleness(), 90_000, "86400 + grace, not 3600");
        pad.createToken("Coin", "OK", "u", 1_000_000_000, address(weth), 250, false);
    }

    function test_PastTheHeartbeatPlusGraceItIsNotFresh() public {
        StonkzLaunchpad pad = new StonkzLaunchpad(admin, admin, admin, src, admin);
        vm.warp(block.timestamp + HEARTBEAT + GRACE + 1);
        vm.expectRevert(bytes("stale oracle"));
        pad.createToken("Coin", "STALE", "u", 1_000_000_000, address(weth), 250, false);
    }

    function test_ACarriedOverRoundIsNotAnAnswer() public {
        agg.staleRound();
        (uint256 p,,) = src.priceUsd1e6(address(weth));
        assertEq(p, 0, "answeredInRound < roundId means the round was not answered");
    }

    function test_AnAnswerOutsideTheSanityBandIsNotAnAnswer() public {
        agg.set(1e8, block.timestamp); // $1 ETH
        (uint256 low,,) = src.priceUsd1e6(address(weth));
        assertEq(low, 0, "below the band");

        agg.set(500_000e8, block.timestamp); // $500,000 ETH
        (uint256 high,,) = src.priceUsd1e6(address(weth));
        assertEq(high, 0, "above the band");
    }

    function test_ANonPositiveAnswerIsNotAnAnswer() public {
        agg.set(0, block.timestamp);
        (uint256 z,,) = src.priceUsd1e6(address(weth));
        assertEq(z, 0);
        agg.set(-1, block.timestamp);
        (uint256 n,,) = src.priceUsd1e6(address(weth));
        assertEq(n, 0);
    }

    /// There is no L2 Sequencer Uptime Feed on 4663, so an aggregator that has
    /// fallen over is a case we have to absorb rather than detect upstream.
    function test_ARevertingAggregatorReadsAsNoAnswerNotAsAnOutage() public {
        agg.setReverting(true);
        (uint256 p,, uint256 maxAge) = src.priceUsd1e6(address(weth));
        assertEq(p, 0, "a reverting feed must not propagate");
        assertEq(maxAge, HEARTBEAT + GRACE, "and must still report its bound");
    }

    function test_AnUnconfiguredBaseHasNoPriceRatherThanReverting() public view {
        (uint256 p, uint256 at, uint256 maxAge) = src.priceUsd1e6(address(0xDEAD));
        assertEq(p, 0);
        assertEq(at, 0);
        assertEq(maxAge, 0);
    }

    function test_OnlyAdminConfiguresFeeds() public {
        vm.expectRevert(bytes("not admin"));
        src.setFeed(address(weth), AggregatorV3Interface(address(agg)), 1, 1, 2);

        vm.prank(admin);
        vm.expectRevert(bytes("band"));
        src.setFeed(address(weth), AggregatorV3Interface(address(agg)), 1, 5, 4);
    }

    /* ------------------------------------------------- never blocks a trade */

    /// The invariant the doc is most emphatic about: a dead oracle defers
    /// graduation, and does not stop anyone trading. A design where a Chainlink
    /// hiccup reverts fills turns an oracle outage into a launchpad outage.
    function test_ADeadOracleDefersGraduationButNeverBlocksATrade() public {
        StonkzLaunchpad pad = new StonkzLaunchpad(admin, admin, admin, src, admin);
        address token =
            pad.createToken("Coin", "LIVE", "u", 1_000_000_000, address(weth), 250, false);

        weth.mint(address(this), 100 ether);
        weth.approve(address(pad), type(uint256).max);
        pad.buy(token, 0.05 ether, 0);

        // Now kill it completely.
        agg.setReverting(true);
        vm.warp(block.timestamp + 10 days);

        // Trading is unaffected.
        uint256 got = pad.buy(token, 0.05 ether, 0);
        assertGt(got, 0, "a dead oracle must not stop a buy");
        StonkzToken(token).approve(address(pad), type(uint256).max);
        assertGt(pad.sell(token, got / 2, 0), 0, "nor a sell");

        // Graduation defers, with a reason rather than a silent no-op.
        vm.expectRevert(bytes("stale oracle"));
        pad.graduate(token);
    }

    function test_OracleGraduationPauseDoesNotStrandAnExhaustedCurve() public {
        StonkzLaunchpad pad = new StonkzLaunchpad(admin, admin, admin, src, admin);
        address token =
            pad.createToken("Coin", "EXH", "u", 1_000_000_000, address(weth), 250, false);

        weth.mint(address(this), 100_000 ether);
        weth.approve(address(pad), type(uint256).max);
        for (uint256 i = 0; i < 40 && pad.coinInfo(token).realToken > 0; i++) {
            pad.buy(token, 10 ether, 0);
        }
        assertEq(pad.coinInfo(token).realToken, 0, "curve exhausted");

        vm.prank(admin);
        pad.setPause(false, false, false, false, true);
        // Exhaustion reads no oracle, so the oracle pause cannot reach it.
        pad.graduate(token);
        assertTrue(pad.coinInfo(token).graduated);
        assertEq(pad.coinInfo(token).graduationReason, 0);
    }

    function test_OracleGraduationPauseStopsThePriceTrigger() public {
        StonkzLaunchpad pad = new StonkzLaunchpad(admin, admin, admin, src, admin);
        address token =
            pad.createToken("Coin", "MID", "u", 1_000_000_000, address(weth), 250, false);
        weth.mint(address(this), 100 ether);
        weth.approve(address(pad), type(uint256).max);
        pad.buy(token, 0.05 ether, 0);

        vm.prank(admin);
        pad.setPause(false, false, false, false, true);
        vm.expectRevert(bytes("oracle graduation paused"));
        pad.graduate(token);
    }
}
