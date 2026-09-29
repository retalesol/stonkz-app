// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPriceSource} from "./IPriceSource.sol";
import {IPyth} from "./IPyth.sol";
import {FullMath} from "./uniswap/FullMath.sol";
import {V3Oracle, IUniswapV3PoolOracle} from "./uniswap/V3Oracle.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title `IPriceSource` for stock-token bases (TSLA, AMZN, …): 24/7, keyless.
/// @notice Stock tokens trade on DEXs around the clock, but the equity oracles
/// (Pyth `Equity.US.*`) only publish during US market hours, so a launch priced
/// by them alone fails every night and weekend unless someone pushes a price by
/// hand. This source prices a stock base from two legs and needs no keeper:
///
/// - **DEX leg (24/7).** A Uniswap V3 TWAP of base→quote over `twapSecs`
///   (default 30 min), read with `observe()`, times the quote's USD price —
///   read from `quotePriceSource` (the `PythPriceSource`, whose ETH/USD feed
///   the launch transaction refreshes in-tx) or fixed at $1 for a stable quote.
///   Only counted when the pool's in-range `liquidity()` **and** the window's
///   harmonic-mean liquidity are both at least `minLiquidity`, so neither a
///   thin pool nor a window that was empty for part of its span (a pool that
///   was just seeded, or drained and refilled) can set a price.
/// - **Equity leg (market hours).** Pyth's equity feed via `getPriceUnsafe`,
///   counted only when its `publishTime` is within `pythMaxAge`.
///
/// Combined: both → the Pyth price, but only when it is within
/// `maxDeviationBps` of the TWAP (a divergence means one of them is being
/// manipulated, so neither is trusted: **no price**, and no fallback either);
/// only the TWAP → the TWAP; only Pyth → Pyth; neither → `fallbackSource`
/// (the `PushPriceSource`). Whatever comes out must sit inside the entry's
/// `[minPrice1e6, maxPrice1e6]` band.
///
/// ## Off hours: the last-close anchor
///
/// With the equity leg stale, the TWAP alone would price — and a pool can be
/// pushed for half an hour. So when Pyth still holds a recent last print (its
/// `publishTime` within `anchorMaxAge`, default 4 days: a long weekend), that
/// print is the **anchor**: the TWAP is taken over the longer
/// `offHoursTwapSecs` (default 2 h) and must sit within `offHoursMaxMoveBps`
/// (default 15%) of the anchor, or there is **no price** (and no fallback —
/// the same stance as a market-hours divergence). A stock rarely moves 15%
/// between a close and the next open; a pool pushed that far for 2 h is
/// being manipulated.
///
/// If the pool's observation buffer does not reach `offHoursTwapSecs` back,
/// the TWAP leg is **unavailable** off hours (no shorter window is tried).
/// A shorter window would let anyone who churns the buffer (one swap per
/// block, cheap on an L2) shrink the window they have to hold a manipulation
/// for; refusing turns that into a liveness problem only. Grow the pool's
/// cardinality (`increaseObservationCardinalityNext`) for busy pools.
///
/// With no anchor — the feed was never posted on this chain, or its last
/// print is older than `anchorMaxAge` — behaviour is unchanged: the TWAP over
/// `twapSecs`, gated by the liquidity floors and the band. The anchor is
/// taken whatever its confidence interval (it is a reference for a ±15% band,
/// not a price), and it never prices on its own.
///
/// `publishedAt` is the freshness of the leg that was used. The TWAP ends at
/// `block.timestamp` but is only as fresh as the quote's USD price, so it
/// inherits the quote's `publishedAt` (and `maxAgeSecs`); a Pyth price that
/// was cross-checked against the TWAP is bounded by both.
///
/// ## Wiring and why it cannot loop
///
/// The launchpad keeps `PythPriceSource` as its `priceSource`, and this is that
/// source's `fallbackSource` — so stock bases (which have no Pyth entry there)
/// reach this contract with no launchpad storage change. This contract reads
/// WETH's USD price back from `PythPriceSource` as `quotePriceSource`, which
/// prices WETH by its own feed and never falls back for it. The config guards
/// keep it that way for any quote: a quote token may never itself be a
/// configured base here (and a configured base may never be used as a quote),
/// so resolving a quote through `PythPriceSource`'s fallback lands on an
/// unconfigured entry here, which goes straight to `fallbackSource` and stops.
///
/// Like every `IPriceSource`, this never reverts: "no answer" is a zero price.
contract StockPriceSource is IPriceSource {
    /// Admin input for one base token.
    struct Params {
        /// Uniswap V3 pool holding `base` and `quoteToken`.
        address pool;
        /// The pool's other token: WETH (priced by `quotePriceSource`) or a
        /// stable flagged with `setStableQuote` ($1.00).
        address quoteToken;
        /// TWAP window; 0 means `DEFAULT_TWAP_SECS`.
        uint32 twapSecs;
        /// Floor on both spot and harmonic-mean in-range liquidity.
        uint128 minLiquidity;
        /// Pyth equity feed; zero for a TWAP-only entry.
        bytes32 pythFeedId;
        /// Pyth leg freshness, and the reported tolerance for a stable quote.
        uint64 pythMaxAge;
        /// Widest Pyth-vs-TWAP gap, bps of the TWAP, that still prices.
        uint16 maxDeviationBps;
        /// Sanity band, 1e6 USD, applied to whatever is returned.
        uint64 minPrice1e6;
        uint64 maxPrice1e6;
        /// A stale Pyth print younger than this anchors the off-hours TWAP;
        /// 0 means `DEFAULT_ANCHOR_MAX_AGE`.
        uint64 anchorMaxAge;
        /// Widest off-hours TWAP move from the anchor, bps of the anchor;
        /// 0 means `DEFAULT_OFF_HOURS_MAX_MOVE_BPS`.
        uint16 offHoursMaxMoveBps;
        /// TWAP window while anchored; 0 means `DEFAULT_OFF_HOURS_TWAP_SECS`.
        uint32 offHoursTwapSecs;
    }

    struct Config {
        Params p;
        /// Cached at `setConfig` so a read costs no `decimals()` calls.
        uint8 baseDecimals;
        uint8 quoteDecimals;
    }

    /// Both legs as they stand, for operators and the app. Zero price = the
    /// leg is unavailable.
    struct Legs {
        uint256 twapPrice1e6;
        uint256 twapPublishedAt;
        uint256 twapMaxAge;
        uint256 pythPrice1e6;
        uint256 pythPublishedAt;
        int24 meanTick;
        uint128 spotLiquidity;
        uint128 harmonicMeanLiquidity;
        /// Last-close anchor (stale Pyth print within `anchorMaxAge`); zero
        /// when there is none or the equity leg is fresh.
        uint256 anchorPrice1e6;
        uint256 anchorPublishedAt;
        /// The TWAP window used: `offHoursTwapSecs` when anchored, else `twapSecs`.
        uint32 twapWindow;
    }

    uint32 public constant DEFAULT_TWAP_SECS = 1800;
    uint32 public constant MIN_TWAP_SECS = 300;
    uint32 public constant MAX_TWAP_SECS = 86_400;
    uint16 public constant MAX_DEVIATION_BPS = 5000;
    uint64 public constant DEFAULT_ANCHOR_MAX_AGE = 4 days;
    uint16 public constant DEFAULT_OFF_HOURS_MAX_MOVE_BPS = 1500;
    uint32 public constant DEFAULT_OFF_HOURS_TWAP_SECS = 7200;
    /// Same confidence bound `PythPriceSource` and `PushPriceSource` apply.
    uint256 public constant MAX_CONF_BPS = 200;

    /// Pyth Core, for the equity leg; zero where the chain has none.
    IPyth public immutable pyth;
    address public admin;
    address public pendingAdmin;
    /// USD price of non-stable quote tokens (WETH): the `PythPriceSource`.
    IPriceSource public quotePriceSource;
    /// Consulted when neither leg is available, and for unconfigured bases.
    IPriceSource public fallbackSource;
    /// Quote tokens priced at a fixed $1.00.
    mapping(address => bool) public isStableQuote;
    /// How many configured bases quote against this token (loop guard).
    mapping(address => uint256) public quoteRefs;
    mapping(address => Config) internal _configs;

    event ConfigSet(address indexed baseToken, Params params);
    event ConfigCleared(address indexed baseToken);
    event StableQuoteSet(address indexed token, bool stable);
    event QuotePriceSourceSet(address source);
    event FallbackSourceSet(address source);
    event AdminProposed(address pendingAdmin);
    event AdminAccepted(address admin);

    constructor(address _admin, IPyth _pyth, IPriceSource _quotePriceSource, IPriceSource _fallbackSource) {
        require(_admin != address(0), "zero admin");
        require(
            address(_fallbackSource) == address(0) || address(_fallbackSource) != address(_quotePriceSource),
            "quote source"
        );
        admin = _admin;
        pyth = _pyth;
        quotePriceSource = _quotePriceSource;
        fallbackSource = _fallbackSource;
        emit QuotePriceSourceSet(address(_quotePriceSource));
        emit FallbackSourceSet(address(_fallbackSource));
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    /* ---------------------------------------------------------------- admin */

    function proposeAdmin(address a) external onlyAdmin {
        pendingAdmin = a;
        emit AdminProposed(a);
    }

    function acceptAdmin() external {
        require(pendingAdmin != address(0) && msg.sender == pendingAdmin, "not pending");
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminAccepted(admin);
    }

    function setQuotePriceSource(IPriceSource s) external onlyAdmin {
        require(address(s) != address(this), "self");
        quotePriceSource = s;
        emit QuotePriceSourceSet(address(s));
    }

    /// @dev Neither this contract, nor the quote source, nor anything that
    /// falls back to this contract: each of those turns an unconfigured quote
    /// into a call cycle.
    function setFallbackSource(IPriceSource s) external onlyAdmin {
        require(address(s) != address(this), "self");
        require(address(s) == address(0) || address(s) != address(quotePriceSource), "quote source");
        if (address(s) != address(0)) {
            (bool ok, bytes memory ret) = address(s).staticcall(abi.encodeWithSignature("fallbackSource()"));
            require(!(ok && ret.length == 32 && abi.decode(ret, (address)) == address(this)), "cycle");
        }
        fallbackSource = s;
        emit FallbackSourceSet(address(s));
    }

    function setStableQuote(address token, bool stable) external onlyAdmin {
        require(token != address(0), "zero");
        isStableQuote[token] = stable;
        emit StableQuoteSet(token, stable);
    }

    function setConfig(address baseToken, Params memory p) external onlyAdmin {
        require(baseToken != address(0) && p.quoteToken != address(0), "zero");
        require(p.quoteToken != baseToken, "quote is base");
        require(p.pool.code.length > 0, "pool");
        address t0 = IUniswapV3PoolOracle(p.pool).token0();
        address t1 = IUniswapV3PoolOracle(p.pool).token1();
        require(
            (t0 == baseToken && t1 == p.quoteToken) || (t0 == p.quoteToken && t1 == baseToken), "pool tokens"
        );
        if (p.twapSecs == 0) p.twapSecs = DEFAULT_TWAP_SECS;
        require(p.twapSecs >= MIN_TWAP_SECS && p.twapSecs <= MAX_TWAP_SECS, "twapSecs");
        require(p.minLiquidity > 0, "minLiquidity");
        require(p.pythMaxAge > 0, "pythMaxAge");
        if (p.pythFeedId != bytes32(0)) {
            require(address(pyth) != address(0), "no pyth");
            require(p.maxDeviationBps > 0 && p.maxDeviationBps <= MAX_DEVIATION_BPS, "deviation");
        }
        require(p.minPrice1e6 > 0 && p.maxPrice1e6 >= p.minPrice1e6, "band");
        if (p.anchorMaxAge == 0) p.anchorMaxAge = DEFAULT_ANCHOR_MAX_AGE;
        if (p.offHoursMaxMoveBps == 0) p.offHoursMaxMoveBps = DEFAULT_OFF_HOURS_MAX_MOVE_BPS;
        if (p.offHoursTwapSecs == 0) p.offHoursTwapSecs = DEFAULT_OFF_HOURS_TWAP_SECS;
        require(p.anchorMaxAge >= p.pythMaxAge, "anchorMaxAge");
        require(p.offHoursMaxMoveBps <= MAX_DEVIATION_BPS, "offHoursMaxMoveBps");
        require(p.offHoursTwapSecs >= p.twapSecs && p.offHoursTwapSecs <= MAX_TWAP_SECS, "offHoursTwapSecs");
        require(isStableQuote[p.quoteToken] || address(quotePriceSource) != address(0), "quote unpriced");
        // Loop guard (see the contract notes): a quote is never a base, and a
        // base is never a quote.
        require(_configs[p.quoteToken].p.pool == address(0), "quote is a configured base");
        require(quoteRefs[baseToken] == 0, "base is a quote");

        uint8 bd = IERC20Decimals(baseToken).decimals();
        uint8 qd = IERC20Decimals(p.quoteToken).decimals();
        require(bd <= 36 && qd <= 36, "decimals");

        address old = _configs[baseToken].p.quoteToken;
        if (old != address(0)) quoteRefs[old] -= 1;
        quoteRefs[p.quoteToken] += 1;
        _configs[baseToken] = Config(p, bd, qd);
        emit ConfigSet(baseToken, p);
    }

    function clearConfig(address baseToken) external onlyAdmin {
        address old = _configs[baseToken].p.quoteToken;
        if (old != address(0)) quoteRefs[old] -= 1;
        delete _configs[baseToken];
        emit ConfigCleared(baseToken);
    }

    /* ---------------------------------------------------------------- views */

    function getConfig(address baseToken) external view returns (Config memory) {
        return _configs[baseToken];
    }

    /// @inheritdoc IPriceSource
    function priceUsd1e6(address baseToken)
        external
        view
        returns (uint256 price1e6, uint256 publishedAt, uint256 maxAgeSecs)
    {
        Config memory c = _configs[baseToken];
        if (c.p.pool == address(0)) return _fallback(baseToken);
        maxAgeSecs = c.p.pythMaxAge;

        // A self-call so that nothing in the leg arithmetic can make this
        // revert: any failure is "no answer".
        Legs memory l;
        try this.legs(baseToken) returns (Legs memory got) {
            l = got;
        } catch {
            return (0, 0, maxAgeSecs);
        }

        bool twap = l.twapPrice1e6 != 0;
        bool equity = l.pythPrice1e6 != 0;
        if (twap && equity) {
            // Divergence: one side is wrong and we cannot tell which.
            if (!_within(l.pythPrice1e6, l.twapPrice1e6, c.p.maxDeviationBps)) return (0, 0, maxAgeSecs);
            price1e6 = l.pythPrice1e6;
            publishedAt = _min(l.pythPublishedAt, l.twapPublishedAt);
            maxAgeSecs = _min(c.p.pythMaxAge, l.twapMaxAge);
        } else if (twap) {
            // Off hours with a last close on record: the TWAP must not have
            // run away from it.
            if (l.anchorPrice1e6 != 0 && !_within(l.twapPrice1e6, l.anchorPrice1e6, c.p.offHoursMaxMoveBps)) {
                return (0, 0, maxAgeSecs);
            }
            (price1e6, publishedAt, maxAgeSecs) = (l.twapPrice1e6, l.twapPublishedAt, l.twapMaxAge);
        } else if (equity) {
            (price1e6, publishedAt) = (l.pythPrice1e6, l.pythPublishedAt);
        } else {
            (price1e6, publishedAt, maxAgeSecs) = _fallback(baseToken);
            if (maxAgeSecs == 0) maxAgeSecs = c.p.pythMaxAge;
        }
        if (price1e6 < c.p.minPrice1e6 || price1e6 > c.p.maxPrice1e6) return (0, 0, maxAgeSecs);
    }

    /// @notice Both legs for `baseToken`, each zero when unavailable.
    /// Reverts only on arithmetic that `priceUsd1e6` catches.
    function legs(address baseToken) external view returns (Legs memory l) {
        Config memory c = _configs[baseToken];
        if (c.p.pool == address(0)) return l;
        // Pyth first: whether it is fresh, stale-but-anchoring or absent picks
        // the TWAP window.
        _pythLeg(c, l);
        if (l.pythPrice1e6 != 0) (l.anchorPrice1e6, l.anchorPublishedAt) = (0, 0);
        l.twapWindow = l.anchorPrice1e6 != 0 ? c.p.offHoursTwapSecs : c.p.twapSecs;
        _twapLeg(baseToken, c, l);
    }

    /* -------------------------------------------------------------- legs */

    function _twapLeg(address baseToken, Config memory c, Legs memory l) private view {
        IUniswapV3PoolOracle pool = IUniswapV3PoolOracle(c.p.pool);
        try pool.liquidity() returns (uint128 liq) {
            l.spotLiquidity = liq;
        } catch {
            return;
        }
        if (l.spotLiquidity < c.p.minLiquidity) return;

        uint32[] memory ago = new uint32[](2);
        ago[0] = l.twapWindow;
        // ago[1] = 0: now.
        try pool.observe(ago) returns (int56[] memory ticks, uint160[] memory spl) {
            if (ticks.length != 2 || spl.length != 2) return;
            (l.meanTick, l.harmonicMeanLiquidity) = V3Oracle.consult(ticks, spl, l.twapWindow);
        } catch {
            // "OLD": the pool's observation buffer does not reach back that
            // far. No shorter window is tried (see the contract notes).
            return;
        }
        if (l.harmonicMeanLiquidity < c.p.minLiquidity) return;

        (uint256 quoteUsd, uint256 quoteAt, uint256 quoteMaxAge) = _quoteUsd(c);
        if (quoteUsd == 0) return;

        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 quoteAtoms =
            V3Oracle.getQuoteAtTick(l.meanTick, uint128(10 ** c.baseDecimals), baseToken, c.p.quoteToken);
        uint256 usd = FullMath.mulDiv(quoteAtoms, quoteUsd, 10 ** c.quoteDecimals);
        if (usd == 0) return;
        l.twapPrice1e6 = usd;
        l.twapPublishedAt = quoteAt;
        l.twapMaxAge = quoteMaxAge;
    }

    /// @return usd The quote's USD price, 1e6; zero when unavailable or stale.
    function _quoteUsd(Config memory c) private view returns (uint256 usd, uint256 at, uint256 maxAge) {
        if (isStableQuote[c.p.quoteToken]) return (1e6, block.timestamp, c.p.pythMaxAge);
        if (address(quotePriceSource) == address(0)) return (0, 0, 0);
        try quotePriceSource.priceUsd1e6(c.p.quoteToken) returns (uint256 p, uint256 a, uint256 m) {
            if (p == 0 || a == 0 || m == 0) return (0, 0, 0);
            if (a > block.timestamp) a = block.timestamp;
            if (block.timestamp - a > m) return (0, 0, 0);
            return (p, a, m);
        } catch {
            return (0, 0, 0);
        }
    }

    function _pythLeg(Config memory c, Legs memory l) private view {
        if (c.p.pythFeedId == bytes32(0) || address(pyth) == address(0)) return;
        try pyth.getPriceUnsafe(c.p.pythFeedId) returns (IPyth.Price memory p) {
            if (p.price <= 0 || p.publishTime == 0) return;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 raw = uint256(uint64(p.price));
            uint256 scaled = _to1e6(raw, p.expo);
            if (scaled == 0) return;
            // Hermes may stamp an update a second ahead of the L2 clock.
            uint256 at = p.publishTime > block.timestamp ? block.timestamp : p.publishTime;
            uint256 age = block.timestamp - at;
            // Nights and weekends: the last close, hours old. Not an answer,
            // but a reference the TWAP must stay near.
            if (age <= c.p.anchorMaxAge) (l.anchorPrice1e6, l.anchorPublishedAt) = (scaled, at);
            if (age > c.p.pythMaxAge) return;
            if (uint256(p.conf) * 10_000 > raw * MAX_CONF_BPS) return;
            l.pythPrice1e6 = scaled;
            l.pythPublishedAt = at;
        } catch {
            // `PriceFeedNotFound`: never updated on this chain.
        }
    }

    /* ------------------------------------------------------------ helpers */

    function _fallback(address baseToken) private view returns (uint256, uint256, uint256) {
        if (address(fallbackSource) == address(0)) return (0, 0, 0);
        try fallbackSource.priceUsd1e6(baseToken) returns (uint256 p, uint256 at, uint256 age) {
            return (p, at, age);
        } catch {
            return (0, 0, 0);
        }
    }

    /// @dev `|a - ref| <= ref · bps / 10_000`.
    function _within(uint256 a, uint256 ref, uint256 bps) private pure returns (bool) {
        uint256 diff = a > ref ? a - ref : ref - a;
        return diff * 10_000 <= ref * bps;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev `raw · 10^(expo + 6)`, as in `PythPriceSource`.
    function _to1e6(uint256 raw, int32 expo) private pure returns (uint256) {
        int256 e = int256(expo) + 6;
        if (e >= 0) {
            if (e > 30) return 0;
            // forge-lint: disable-next-line(unsafe-typecast)
            return raw * (10 ** uint256(e));
        }
        if (e < -38) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        return raw / (10 ** uint256(-e));
    }
}
