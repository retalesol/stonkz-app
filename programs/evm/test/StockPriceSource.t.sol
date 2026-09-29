// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {StockPriceSource} from "../src/oracle/StockPriceSource.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {TickMath} from "../src/oracle/uniswap/TickMath.sol";
import {FullMath} from "../src/oracle/uniswap/FullMath.sol";
import {V3Oracle} from "../src/oracle/uniswap/V3Oracle.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockWETH} from "./mocks/MockUniversalRouter.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice Shared fixture: the production wiring in miniature.
/// Launchpad → `PythPriceSource` (WETH by its ETH/USD feed, fallback →)
/// `StockPriceSource` (TSLA by TWAP × WETH/USD read back from the Pyth source,
/// cross-checked against the TSLA equity feed; fallback →) `PushPriceSource`.
abstract contract StockFixture is Test {
    bytes32 constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant TSLA_USD = 0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1;
    uint256 constant PYTH_FEE = 1e9; // wei per update
    uint256 constant T0 = 1_800_000_000;
    /// Low, so TSLA is the pool's token0 against any CREATE-deployed quote.
    address constant TSLA_ADDR = address(0x1000);
    uint128 constant MIN_LIQ = 1e18;
    uint128 constant DEEP = 1e21;

    address admin = address(0xA11CE);

    MockPyth pyth;
    MockWETH weth;
    MockERC20 usdg;
    MockERC20 tsla;
    PythPriceSource pps;
    PushPriceSource push;
    StockPriceSource sps;
    MockV3Pool pool;

    function _setUpSources() internal {
        vm.warp(T0);
        pyth = new MockPyth(PYTH_FEE);
        weth = new MockWETH();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = _token(TSLA_ADDR, "Tesla", "TSLA", 18);

        push = DeployPad.pushOracle(admin, admin, 90_000);
        pps = new PythPriceSource(admin, IPyth(address(pyth)));
        sps = new StockPriceSource(
            admin, IPyth(address(pyth)), IPriceSource(address(pps)), IPriceSource(address(push))
        );

        // A deep TSLA/WETH pool at $250 / $4,000 that has been live for a day.
        vm.warp(T0 - 1 days);
        pool = new MockV3Pool(
            address(tsla), address(weth), _tickFor(address(tsla), address(weth), 250e6, 4000e6), DEEP
        );
        vm.warp(T0);

        vm.startPrank(admin);
        pps.setFeed(address(weth), ETH_USD, 120, 100e6, 100_000e6);
        pps.setFixedPrice(address(usdg), 1e6, 120);
        pps.setFallbackSource(IPriceSource(address(sps)));
        sps.setStableQuote(address(usdg), true);
        sps.setConfig(address(tsla), _params(address(pool), address(weth)));
        vm.stopPrank();
        vm.deal(address(this), 100 ether);
    }

    function _params(address pool_, address quote) internal pure returns (StockPriceSource.Params memory) {
        return StockPriceSource.Params({
            pool: pool_,
            quoteToken: quote,
            twapSecs: 1800,
            minLiquidity: MIN_LIQ,
            pythFeedId: TSLA_USD,
            pythMaxAge: 120,
            maxDeviationBps: 300,
            minPrice1e6: 1e6,
            maxPrice1e6: 10_000e6,
            anchorMaxAge: 0, // defaults: 4 days,
            offHoursMaxMoveBps: 0, // 15%,
            offHoursTwapSecs: 0 // 2 h
        });
    }

    function _token(address where, string memory name, string memory sym, uint8 dec)
        internal
        returns (MockERC20)
    {
        deployCodeTo("Mocks.sol:MockERC20", abi.encode(name, sym, dec), where);
        return MockERC20(where);
    }

    /// Post a Pyth update (expo -8, zero confidence) for `usd` whole dollars · 1e8.
    function _post(bytes32 id, int64 price1e8, uint256 publishTime) internal {
        bytes[] memory u = new bytes[](1);
        u[0] = pyth.createUpdate(id, price1e8, 0, -8, publishTime);
        pyth.updatePriceFeeds{value: PYTH_FEE}(u);
    }

    function _postEth(uint256 publishTime) internal {
        _post(ETH_USD, 4000e8, publishTime);
    }

    /// The pool tick at which one whole `base` is worth `baseUsd / quoteUsd` whole `quote`.
    function _tickFor(address base, address quote, uint256 baseUsd1e6, uint256 quoteUsd1e6)
        internal
        view
        returns (int24)
    {
        uint256 bd = MockERC20(base).decimals();
        uint256 qd = MockERC20(quote).decimals();
        // quote atoms per base atom = baseUsd·10^qd / (quoteUsd·10^bd)
        uint256 num = baseUsd1e6 * 10 ** qd;
        uint256 den = quoteUsd1e6 * 10 ** bd;
        uint256 sqrtX96 = base < quote
            ? Math.sqrt(Math.mulDiv(num, 1 << 192, den))
            : Math.sqrt(Math.mulDiv(den, 1 << 192, num));
        return TickMath.getTickAtSqrtRatio(uint160(sqrtX96));
    }

    function _assertNear(uint256 got, uint256 want, uint256 bps, string memory why) internal pure {
        uint256 diff = got > want ? got - want : want - got;
        assertLe(diff * 10_000, want * bps, why);
    }
}

contract StockPriceSourceTest is StockFixture {
    function setUp() public {
        _setUpSources();
    }

    /* ------------------------------------------------------------- the legs */

    /// Market hours: both legs agree → the Pyth price, as fresh as the older
    /// of the equity print and the WETH quote the cross-check used.
    function test_BothLegsAgreeReturnsPyth() public {
        _postEth(T0 - 10);
        _post(TSLA_USD, 251e8, T0 - 5);
        (uint256 p, uint256 at, uint256 maxAge) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 251e6, "the Pyth print");
        assertEq(at, T0 - 10, "bounded by the WETH quote's publish time");
        assertEq(maxAge, 120);
    }

    /// Weekend: the equity feed's last print is Friday's close → TWAP alone,
    /// dated by the WETH quote.
    function test_OnlyTwapOnAWeekend() public {
        _postEth(T0 - 3);
        _post(TSLA_USD, 260e8, T0 - 2 days);
        (uint256 p, uint256 at, uint256 maxAge) = sps.priceUsd1e6(address(tsla));
        _assertNear(p, 250e6, 2, "TWAP at the pool's price");
        assertEq(at, T0 - 3, "TWAP inherits the quote's publish time");
        assertEq(maxAge, 120, "and the quote's tolerance");

        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        assertEq(l.pythPrice1e6, 0, "stale equity leg is off");
        assertEq(l.spotLiquidity, DEEP);
        assertApproxEqRel(l.harmonicMeanLiquidity, DEEP, 1e12, "harmonic mean over a constant window");
    }

    /// A pool below `minLiquidity` is ignored → Pyth alone.
    function test_OnlyPythWhenThePoolIsThin() public {
        pool.set(pool.tick(), MIN_LIQ - 1);
        _postEth(T0);
        _post(TSLA_USD, 262e8, T0 - 7);
        (uint256 p, uint256 at, uint256 maxAge) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 262e6);
        assertEq(at, T0 - 7);
        assertEq(maxAge, 120);
        assertEq(sps.legs(address(tsla)).twapPrice1e6, 0, "thin pool: no TWAP");
    }

    /// Neither leg → the push oracle, still inside the band.
    function test_NeitherLegFallsBack() public {
        pool.set(pool.tick(), 0);
        vm.prank(admin);
        push.pushPrice(address(tsla), 245e6, 0);
        (uint256 p, uint256 at, uint256 maxAge) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 245e6);
        assertEq(at, T0);
        assertEq(maxAge, 90_000, "the fallback's own tolerance");
    }

    function test_NeitherLegAndNoFallbackIsNoPrice() public {
        pool.set(pool.tick(), 0);
        (uint256 p, uint256 at,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0);
        assertEq(at, 0);
    }

    /// Pyth and the TWAP disagree by more than `maxDeviationBps`: somebody is
    /// manipulating one of them. No price — and no falling back to a push.
    function test_DivergenceIsNoPriceAndDoesNotFallBack() public {
        vm.prank(admin);
        push.pushPrice(address(tsla), 250e6, 0);
        _postEth(T0);
        _post(TSLA_USD, 280e8, T0); // +12% over the TWAP
        (uint256 p, uint256 at,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "divergence");
        assertEq(at, 0);
    }

    function test_DeviationBoundary() public {
        _postEth(T0);
        uint256 twap = sps.legs(address(tsla)).twapPrice1e6;
        // Just inside 3%.
        uint256 inside = twap + (twap * 299) / 10_000;
        _post(TSLA_USD, int64(uint64(inside * 100)), T0 - 2);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, inside, "within 3%: Pyth");
        // Just outside.
        uint256 outside = twap + (twap * 301) / 10_000;
        _post(TSLA_USD, int64(uint64(outside * 100)), T0 - 1);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "beyond 3%: no price");
        // Below, just outside.
        uint256 under = twap - (twap * 301) / 10_000;
        _post(TSLA_USD, int64(uint64(under * 100)), T0);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "beyond -3%: no price");
    }

    /* ------------------------------------------------- off-hours anchor */

    function _poolAt(uint256 usd1e6) internal {
        pool.set(_tickFor(address(tsla), address(weth), usd1e6, 4000e6), DEEP);
    }

    /// Market hours: fresh Pyth, no anchor, the normal 30-min window.
    function test_MarketHoursUseTheShortWindowAndNoAnchor() public {
        _postEth(T0);
        _post(TSLA_USD, 250e8, T0);
        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        assertEq(l.twapWindow, 1800);
        assertEq(l.anchorPrice1e6, 0);
    }

    /// Weekend, Friday's close $240, the pool at $250 (+4%): within 15%, the
    /// 2-hour TWAP prices.
    function test_WeekendMoveWithinTheAnchorBandPrices() public {
        _postEth(T0);
        _post(TSLA_USD, 240e8, T0 - 1 days);
        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        assertEq(l.anchorPrice1e6, 240e6, "Friday's close anchors");
        assertEq(l.anchorPublishedAt, T0 - 1 days);
        assertEq(l.twapWindow, 7200, "off-hours window");
        (uint256 p, uint256 at,) = sps.priceUsd1e6(address(tsla));
        _assertNear(p, 250e6, 2, "the TWAP, not the anchor");
        assertEq(at, T0, "dated by the WETH quote");
    }

    /// Weekend, a pool pushed to $300 (+20% on a $250 close) for 3 hours:
    /// the whole 2-hour window is manipulated and there is no price — not
    /// even the push oracle's.
    function test_WeekendManipulationBeyondTheAnchorIsNoPrice() public {
        vm.prank(admin);
        push.pushPrice(address(tsla), 250e6, 0);
        _post(TSLA_USD, 250e8, T0 - 2 days);
        vm.warp(T0 - 3 hours);
        _poolAt(300e6);
        vm.warp(T0);
        _postEth(T0);
        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        _assertNear(l.twapPrice1e6, 300e6, 2, "the TWAP itself is manipulated");
        (uint256 p, uint256 at,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "20% from the last close: no price");
        assertEq(at, 0);
    }

    /// The 2-hour window dilutes a 30-minute push: +40% for the last half
    /// hour moves the TWAP ~9%, not 40%.
    function test_TheLongWindowDilutesAShortPush() public {
        _post(TSLA_USD, 250e8, T0 - 1 days);
        vm.warp(T0 - 30 minutes);
        _poolAt(350e6);
        vm.warp(T0);
        _postEth(T0);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        // Geometric mean: 250 · 1.4^(1/4) ≈ 271.9.
        _assertNear(p, 271_900_000, 10, "a quarter of the window at +40%");
    }

    /// No anchor (the feed was never posted, as on RH testnet today): the
    /// TWAP over 30 min, gated only by liquidity and the band, as before.
    function test_NoAnchorKeepsTheCurrentBehaviour() public {
        vm.warp(T0 - 3 hours);
        _poolAt(300e6);
        vm.warp(T0);
        _postEth(T0);
        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        assertEq(l.anchorPrice1e6, 0);
        assertEq(l.twapWindow, 1800);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        _assertNear(p, 300e6, 2, "unanchored TWAP");
    }

    /// A last print older than `anchorMaxAge` (4 days) anchors nothing.
    function test_AnAnchorOlderThanFourDaysKeepsTheCurrentBehaviour() public {
        _post(TSLA_USD, 250e8, T0 - 4 days - 1);
        vm.warp(T0 - 3 hours);
        _poolAt(300e6);
        vm.warp(T0);
        _postEth(T0);
        assertEq(sps.legs(address(tsla)).anchorPrice1e6, 0, "too old to anchor");
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        _assertNear(p, 300e6, 2, "unanchored TWAP");

        // Exactly 4 days old still anchors.
        _post(TSLA_USD, 250e8, T0 - 4 days);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "4 days is the edge, inclusive");
    }

    /// A pool whose history covers `twapSecs` (30 min) but not
    /// `offHoursTwapSecs` (2 h): priced in the unanchored case, but off hours
    /// the TWAP leg is unavailable — no shorter window is tried — and the
    /// source falls through to the push oracle.
    function test_AShortObservationHistoryIsNoOffHoursTwap() public {
        vm.warp(T0 - 1 hours);
        MockV3Pool young = new MockV3Pool(
            address(tsla), address(weth), _tickFor(address(tsla), address(weth), 250e6, 4000e6), DEEP
        );
        vm.warp(T0);
        vm.prank(admin);
        sps.setConfig(address(tsla), _params(address(young), address(weth)));
        _postEth(T0);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        _assertNear(p, 250e6, 2, "no anchor: 30 min fits in 1 h of history");

        _post(TSLA_USD, 250e8, T0 - 1 days);
        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        assertEq(l.twapWindow, 7200);
        assertEq(l.twapPrice1e6, 0, "2 h does not fit: no TWAP");
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "and no push price either");
        vm.prank(admin);
        push.pushPrice(address(tsla), 251e6, 0);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 251e6, "neither leg: the fallback, as before");
    }

    function test_AnchorConfigGuardsAndDefaults() public {
        StockPriceSource.Config memory got = sps.getConfig(address(tsla));
        assertEq(got.p.anchorMaxAge, 4 days);
        assertEq(got.p.offHoursMaxMoveBps, 1500);
        assertEq(got.p.offHoursTwapSecs, 7200);

        StockPriceSource.Params memory c = _params(address(pool), address(weth));
        vm.startPrank(admin);
        c.offHoursTwapSecs = 1799;
        vm.expectRevert(bytes("offHoursTwapSecs"));
        sps.setConfig(address(tsla), c);
        c.offHoursTwapSecs = 86_401;
        vm.expectRevert(bytes("offHoursTwapSecs"));
        sps.setConfig(address(tsla), c);
        c = _params(address(pool), address(weth));
        c.offHoursMaxMoveBps = 5001;
        vm.expectRevert(bytes("offHoursMaxMoveBps"));
        sps.setConfig(address(tsla), c);
        c = _params(address(pool), address(weth));
        c.anchorMaxAge = 119;
        vm.expectRevert(bytes("anchorMaxAge"));
        sps.setConfig(address(tsla), c);
        vm.stopPrank();
    }

    /* ------------------------------------------------------------- liquidity */

    /// A pool seeded ten minutes ago has deep liquidity *now*, but its 30-min
    /// window is mostly empty: the harmonic-mean floor ignores it until the
    /// whole window has had liquidity in it.
    function test_ARecentlySeededPoolIsIgnoredUntilItsWindowFills() public {
        // Empty pool at a placeholder price (the testnet pools sit at 1:1)...
        vm.warp(T0 - 1 days);
        MockV3Pool fresh = new MockV3Pool(address(tsla), address(weth), 0, 0);
        vm.prank(admin);
        sps.setConfig(address(tsla), _params(address(fresh), address(weth)));
        // ...seeded at the right price 10 minutes ago.
        vm.warp(T0 - 10 minutes);
        fresh.set(_tickFor(address(tsla), address(weth), 250e6, 4000e6), DEEP);
        vm.warp(T0);
        _postEth(T0);

        StockPriceSource.Legs memory l = sps.legs(address(tsla));
        assertEq(l.spotLiquidity, DEEP, "spot looks deep");
        assertLt(l.harmonicMeanLiquidity, MIN_LIQ, "but the window was mostly empty");
        assertEq(l.twapPrice1e6, 0, "so no TWAP (it would be skewed toward 1 WETH/share)");

        vm.warp(T0 + 20 minutes + 1);
        _postEth(block.timestamp);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        _assertNear(p, 250e6, 2, "once the window is full, the TWAP prices");
    }

    /// A pool whose buffer does not reach `twapSecs` back ("OLD") is no leg.
    function test_ObserveTooOldIsNoLeg() public {
        MockV3Pool young = new MockV3Pool(address(tsla), address(weth), pool.tick(), DEEP);
        vm.prank(admin);
        sps.setConfig(address(tsla), _params(address(young), address(weth)));
        _postEth(T0);
        assertEq(sps.legs(address(tsla)).twapPrice1e6, 0);
    }

    /// A stale WETH quote disables the TWAP leg (its USD value would be stale).
    function test_StaleQuoteDisablesTheTwap() public {
        _postEth(T0 - 121);
        assertEq(sps.legs(address(tsla)).twapPrice1e6, 0, "ETH/USD older than its 120 s");
        _post(TSLA_USD, 250e8, T0);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 250e6, "Pyth alone then");
    }

    /// A pool that reverts on every call cannot make the source revert.
    function test_ABrokenPoolNeverReverts() public {
        pool.setBroken(true);
        _postEth(T0);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0);
        _post(TSLA_USD, 250e8, T0);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 250e6, "the other leg still answers");
    }

    /* ------------------------------------------------------------------ band */

    function test_TheBandAppliesToEveryLeg() public {
        StockPriceSource.Params memory c = _params(address(pool), address(weth));
        c.minPrice1e6 = 300e6;
        vm.prank(admin);
        sps.setConfig(address(tsla), c);

        _postEth(T0);
        (uint256 p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "TWAP below band");

        pool.set(pool.tick(), 0);
        _post(TSLA_USD, 250e8, T0);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "Pyth below band");

        vm.warp(T0 + 1 days);
        vm.prank(admin);
        push.pushPrice(address(tsla), 250e6, 0);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "fallback below band");

        vm.prank(admin);
        push.pushPrice(address(tsla), 300e6, 0);
        (p,,) = sps.priceUsd1e6(address(tsla));
        assertEq(p, 300e6, "on the edge is in");
    }

    /* ------------------------------------------------- order and decimals */

    /// Every combination of token order (base token0 / token1), base decimals
    /// (18 / 8 / 6) and quote (WETH 18 at $4,000 / USDG 6 at $1).
    function test_TokenOrderAndDecimalPermutations() public {
        uint8[3] memory decs = [18, 8, 6];
        address[2] memory spots = [address(0x2000), address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF)];
        _postEth(T0);
        for (uint256 q = 0; q < 2; q++) {
            address quote = q == 0 ? address(weth) : address(usdg);
            uint256 quoteUsd = q == 0 ? 4000e6 : 1e6;
            for (uint256 d = 0; d < 3; d++) {
                for (uint256 s = 0; s < 2; s++) {
                    address baseAddr = address(uint160(spots[s]) - uint160(q * 64 + d * 4));
                    MockERC20 base = _token(baseAddr, "Stock", "STK", decs[d]);
                    assertEq(address(base) < quote, s == 0, "ordering as intended");
                    vm.warp(T0 - 1 days);
                    MockV3Pool p_ = new MockV3Pool(
                        address(base), quote, _tickFor(address(base), quote, 137_420_000, quoteUsd), DEEP
                    );
                    vm.warp(T0);
                    StockPriceSource.Params memory c = _params(address(p_), quote);
                    c.pythFeedId = bytes32(0);
                    // Liquidity units scale with decimals; the floor is per-pool.
                    c.minLiquidity = 1;
                    vm.prank(admin);
                    sps.setConfig(address(base), c);
                    (uint256 price, uint256 at,) = sps.priceUsd1e6(address(base));
                    _assertNear(price, 137_420_000, 2, "$137.42 in every permutation");
                    assertEq(at, q == 0 ? T0 : block.timestamp, "stable quote is always current");
                    vm.prank(admin);
                    sps.clearConfig(address(base));
                }
            }
        }
    }

    /* -------------------------------------------------------- the wiring */

    /// PythPriceSource → StockPriceSource → PushPriceSource, and WETH never
    /// leaves PythPriceSource: no recursion.
    function test_ThroughPythPriceSourceWithoutRecursion() public {
        _postEth(T0);
        (uint256 p,,) = pps.priceUsd1e6(address(tsla));
        _assertNear(p, 250e6, 2, "stock base reaches the TWAP through the Pyth source's fallback");
        (uint256 e,,) = pps.priceUsd1e6(address(weth));
        assertEq(e, 4000e6, "WETH by its own feed");

        // WETH with a stale feed is simply stale — PythPriceSource never falls
        // back for a feed entry, so this cannot loop into the stock source.
        vm.warp(T0 + 1 days);
        uint256 g = gasleft();
        (e,,) = pps.priceUsd1e6(address(weth));
        assertEq(e, 4000e6, "Pyth reports the stale price; the launchpad judges the age");
        (p,,) = pps.priceUsd1e6(address(tsla));
        assertEq(p, 0, "stale quote and no equity: no price");
        // An unknown token walks Pyth → Stock → Push once and stops.
        (p,,) = pps.priceUsd1e6(address(0xDEAD));
        assertEq(p, 0);
        assertLt(g - gasleft(), 300_000, "bounded, no cycle");
    }

    /* --------------------------------------------------------------- admin */

    function test_ConfigGuards() public {
        MockERC20 nflx = _token(address(0x3000), "Netflix", "NFLX", 18);
        MockV3Pool nflxTsla = new MockV3Pool(address(nflx), address(tsla), 0, DEEP);
        MockV3Pool usdgWeth = new MockV3Pool(address(usdg), address(weth), 0, DEEP);
        MockV3Pool nflxUsdg = new MockV3Pool(address(nflx), address(usdg), 0, DEEP);
        vm.startPrank(admin);

        vm.expectRevert(bytes("quote is a configured base"));
        sps.setConfig(address(nflx), _params(address(nflxTsla), address(tsla)));

        sps.setConfig(address(nflx), _params(address(nflxUsdg), address(usdg)));
        vm.expectRevert(bytes("base is a quote"));
        sps.setConfig(address(usdg), _params(address(usdgWeth), address(weth)));

        vm.expectRevert(bytes("pool tokens"));
        sps.setConfig(address(nflx), _params(address(pool), address(weth)));

        vm.expectRevert(bytes("quote is base"));
        sps.setConfig(address(nflx), _params(address(nflxUsdg), address(nflx)));

        StockPriceSource.Params memory c = _params(address(pool), address(weth));
        c.minLiquidity = 0;
        vm.expectRevert(bytes("minLiquidity"));
        sps.setConfig(address(tsla), c);
        c = _params(address(pool), address(weth));
        c.twapSecs = 60;
        vm.expectRevert(bytes("twapSecs"));
        sps.setConfig(address(tsla), c);
        c = _params(address(pool), address(weth));
        c.maxDeviationBps = 0;
        vm.expectRevert(bytes("deviation"));
        sps.setConfig(address(tsla), c);
        c = _params(address(pool), address(weth));
        c.maxPrice1e6 = 0;
        vm.expectRevert(bytes("band"));
        sps.setConfig(address(tsla), c);
        c = _params(address(pool), address(weth));
        c.twapSecs = 0;
        sps.setConfig(address(tsla), c);
        assertEq(sps.getConfig(address(tsla)).p.twapSecs, 1800, "0 means the default");

        // Fallback cycles.
        vm.expectRevert(bytes("self"));
        sps.setFallbackSource(IPriceSource(address(sps)));
        vm.expectRevert(bytes("quote source"));
        sps.setFallbackSource(IPriceSource(address(pps)));
        PythPriceSource other = new PythPriceSource(admin, IPyth(address(pyth)));
        other.setFallbackSource(IPriceSource(address(sps)));
        vm.expectRevert(bytes("cycle"));
        sps.setFallbackSource(IPriceSource(address(other)));
        vm.stopPrank();

        // Clearing releases the quote reference.
        assertEq(sps.quoteRefs(address(usdg)), 1);
        vm.prank(admin);
        sps.clearConfig(address(nflx));
        assertEq(sps.quoteRefs(address(usdg)), 0);
    }

    function test_OnlyAdminAndTwoStepHandover() public {
        vm.expectRevert(bytes("not admin"));
        sps.setConfig(address(tsla), _params(address(pool), address(weth)));
        vm.expectRevert(bytes("not admin"));
        sps.setFallbackSource(IPriceSource(address(0)));

        address next = address(0x71E);
        vm.prank(admin);
        sps.proposeAdmin(next);
        assertEq(sps.admin(), admin, "nothing changes until accepted");
        vm.expectRevert(bytes("not pending"));
        sps.acceptAdmin();
        vm.prank(next);
        sps.acceptAdmin();
        assertEq(sps.admin(), next);
        assertEq(sps.pendingAdmin(), address(0));
    }

    function test_UnconfiguredBasesGoStraightToTheFallback() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.prank(admin);
        push.pushPrice(address(other), 7e6, 0);
        (uint256 p,,) = sps.priceUsd1e6(address(other));
        assertEq(p, 7e6);
    }
}

/// @notice The Uniswap math ports, against known vectors.
contract UniswapMathTest is Test {
    /// Published bounds and the identity.
    function test_TickMathBounds() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_RATIO);
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_RATIO);
        assertEq(TickMath.getSqrtRatioAtTick(0), 1 << 96);
        assertEq(TickMath.getTickAtSqrtRatio(TickMath.MIN_SQRT_RATIO), TickMath.MIN_TICK);
        assertEq(TickMath.getTickAtSqrtRatio(TickMath.MAX_SQRT_RATIO - 1), TickMath.MAX_TICK - 1);
        assertEq(TickMath.getTickAtSqrtRatio(1 << 96), 0);
    }

    /// Uniswap v3-core's own snapshot values.
    function test_TickMathUniswapVectors() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK + 1), 4_295_343_490);
        assertEq(
            TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK - 1),
            1_461_373_636_630_004_318_706_518_188_784_493_106_690_254_656_249
        );
        assertEq(TickMath.getSqrtRatioAtTick(50), 79_426_470_787_362_580_746_886_972_461);
    }

    /// `sqrt(1.0001^t) · 2^96` computed to 120 digits (Python `decimal`),
    /// floored. Uniswap rounds up and carries ~2^-128 relative error.
    function test_TickMathAgainstHighPrecision() public pure {
        int24[12] memory ticks =
            [int24(1), -1, 8, -50, 1000, -27_728, -27_727, 100_000, -100_000, 500_000, -500_000, 887_271];
        uint256[12] memory exact = [
            uint256(79_232_123_823_359_799_118_286_999_567),
            79_224_201_403_219_477_170_569_942_573,
            79_259_858_533_276_714_757_314_932_305,
            79_030_349_367_926_598_376_800_521_321,
            83_290_069_058_676_223_003_182_343_269,
            19_806_321_180_570_615_473_770_391_411,
            19_807_311_471_872_980_346_541_569_525,
            11_755_562_826_496_067_164_730_007_768_449,
            533_968_626_430_936_354_154_228_407,
            5_697_689_776_495_288_729_098_254_599_936_056_708_424,
            1_101_692_437_043_807_370,
            1_461_373_636_630_004_318_672_046_398_259_762_639_463_073_250_156
        ];
        for (uint256 i = 0; i < ticks.length; i++) {
            uint256 got = TickMath.getSqrtRatioAtTick(ticks[i]);
            uint256 diff = got > exact[i] ? got - exact[i] : exact[i] - got;
            assertLe(diff, exact[i] / 1e15 + 2, "within 1e-15 of exact");
        }
    }

    /// A live vector: the RH-testnet TSLA/WETH pool's `slot0` (sqrtPriceX96,
    /// tick) on 2026-09-29.
    function test_TickMathLivePoolVector() public pure {
        assertEq(TickMath.getTickAtSqrtRatio(79_263_398_502_715_599_672_939_985_341), 8);
    }

    function testFuzz_TickRoundTrip(int24 tick) public pure {
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        uint160 s = TickMath.getSqrtRatioAtTick(tick);
        assertEq(TickMath.getTickAtSqrtRatio(s), tick, "tick of its own ratio");
        assertEq(
            TickMath.getTickAtSqrtRatio(TickMath.getSqrtRatioAtTick(tick + 1) - 1), tick, "greatest tick <="
        );
        assertGt(TickMath.getSqrtRatioAtTick(tick + 1), s, "monotonic");
    }

    function testFuzz_FullMathMatchesOpenZeppelin(uint256 a, uint256 b, uint256 d) public pure {
        d = bound(d, 1, type(uint256).max);
        // Only where the result fits (FullMath reverts otherwise, as does OZ).
        (uint256 hi,) = _mul512(a, b);
        vm.assume(hi < d);
        assertEq(FullMath.mulDiv(a, b, d), Math.mulDiv(a, b, d));
    }

    function test_FullMathVectors() public pure {
        assertEq(FullMath.mulDiv(type(uint256).max, type(uint256).max, type(uint256).max), type(uint256).max);
        assertEq(FullMath.mulDiv(1 << 128, 1 << 128, 1 << 192), 1 << 64);
        assertEq(
            FullMath.mulDiv(type(uint256).max, 3, 7),
            (type(uint256).max / 7) * 3 + ((type(uint256).max % 7) * 3) / 7
        );
    }

    /// Mean tick rounds toward negative infinity, like Uniswap's `consult`.
    function test_ConsultRoundsDown() public pure {
        int56[] memory t = new int56[](2);
        uint160[] memory s = new uint160[](2);
        s[1] = uint160((uint256(10) << 128) / 5); // 10 s at liquidity 5
        t[1] = -25; // mean -2.5
        (int24 tick, uint128 l) = V3Oracle.consult(t, s, 10);
        assertEq(tick, -3);
        assertEq(l, 4, "harmonic mean of 5, rounded down by Uniswap's (2^160-1) scaling");
        t[1] = 25;
        (tick,) = V3Oracle.consult(t, s, 10);
        assertEq(tick, 2);
    }

    /// getQuoteAtTick at tick 0 is the identity in both directions.
    function test_QuoteAtTick() public pure {
        assertEq(V3Oracle.getQuoteAtTick(0, 1e18, address(1), address(2)), 1e18);
        assertEq(V3Oracle.getQuoteAtTick(0, 1e18, address(2), address(1)), 1e18);
        // 1.0001^-27728 ≈ 0.06249…: 1 TSLA (token0) in WETH.
        uint256 q = V3Oracle.getQuoteAtTick(-27_728, 1e18, address(1), address(2));
        assertGt(q, 0.0624e18);
        assertLt(q, 0.0625e18);
    }

    function _mul512(uint256 a, uint256 b) private pure returns (uint256 hi, uint256 lo) {
        assembly {
            let mm := mulmod(a, b, not(0))
            lo := mul(a, b)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }
}
