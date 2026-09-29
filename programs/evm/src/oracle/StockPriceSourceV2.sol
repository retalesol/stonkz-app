// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IPriceSource} from "./IPriceSource.sol";
import {IPyth} from "./IPyth.sol";
import {IStockAttestationSink, STOCK_ATTESTATION_MAGIC} from "./IStockAttestationSink.sol";
import {FullMath} from "./uniswap/FullMath.sol";
import {V3Oracle, IUniswapV3PoolOracle} from "./uniswap/V3Oracle.sol";

interface IERC20DecimalsV2 {
    function decimals() external view returns (uint8);
}

interface ILaunchpadPauser {
    function pauser() external view returns (address);
}

/// @title `StockPriceSource` plus a **signed per-launch price** (attested leg).
/// @notice Everything `StockPriceSource` does — Pyth equity leg, Uniswap V3
/// TWAP leg with liquidity floors, last-close anchor off hours, push fallback,
/// band, never reverts — plus a third leg: a USD price the Stonkz API signs at
/// `/launch/prepare` (from DefiLlama) and the launch transaction carries in its
/// `priceUpdate`. The router hands entries starting with `"STKA"` to
/// `postAttestation`; this contract checks the signature and stores the latest
/// price per base. So a stock base prices at any hour with no seeded pool and
/// no keeper.
///
/// ## Attestation format (what the API must produce, byte for byte)
///
/// `att = abi.encode(bytes4("STKA"), address base, uint64 price1e6,
/// uint64 publishTime, bytes signature)`, where `signature` is a 65-byte
/// `r ‖ s ‖ v` EIP-191 `personal_sign` over the 32-byte
/// `attestationDigest(base, price1e6, publishTime)` =
/// `keccak256(abi.encode("STONKZ_PRICE_V1", block.chainid, address(this),
/// base, price1e6, publishTime))` (the string is ABI-encoded as a dynamic
/// `string`). Recovery is OZ `ECDSA.tryRecover` (low-s only, no malleability).
///
/// An attestation is stored only if the signer is the current `attester`, the
/// base is configured, the price is non-zero, `publishTime` is newer than the
/// stored one and at most 5 s ahead of the block. Anything else — bad
/// signature, replay, stale, malformed, paused — is a silent no-op returning
/// `false`: a duplicate or stale attestation never breaks a launch.
///
/// ## Leg priority
///
/// 1. **Fresh Pyth equity** (market hours), cross-checked against the TWAP
///    (`maxDeviationBps`) and against a fresh attestation (`maxDeviationBps`).
/// 2. **Fresh attestation** (≤ `attestMaxAge`, default 300 s, inside the
///    band), cross-checked against the TWAP if one is available
///    (`maxDeviationBps`), else against the last Pyth close if one is within
///    `anchorMaxAge` (`offHoursMaxMoveBps`), else alone.
/// 3. **TWAP**, with the `StockPriceSource` anchor rules.
/// 4. **Fallback** (push).
///
/// Any failed cross-check is **no price** (no fallback). The band applies to
/// whatever is returned.
///
/// ## Blast radius of the attester key
///
/// A compromised attester can publish any price, but it only prices a launch
/// after the checks above: in market hours it must agree with Pyth; with a
/// usable pool it must agree with the TWAP; with a last close on record it
/// must sit within `offHoursMaxMoveBps` of it; and always inside the band.
/// Only where none of Pyth, TWAP and anchor exist (e.g. a chain where the
/// equity feed was never posted and pools are empty) is the attester bounded
/// by the band alone. The admin can zero `attester` (`setAttester`) and the
/// admin **or the launchpad's pauser** can stop the leg instantly
/// (`pauseAttestations`); rotating the attester invalidates every stored
/// attestation at once.
///
/// Wiring and loop guards are `StockPriceSource`'s. A base may be configured
/// with no pool (`pool = 0`, `quoteToken = 0`): TWAP leg off, attested and
/// Pyth legs on — for a chain whose stock pools do not exist yet.
contract StockPriceSourceV2 is IPriceSource, IStockAttestationSink {
    struct Params {
        /// Uniswap V3 pool holding `base` and `quoteToken`; zero for none.
        address pool;
        /// The pool's other token (zero iff `pool` is zero).
        address quoteToken;
        /// TWAP window; 0 means `DEFAULT_TWAP_SECS`.
        uint32 twapSecs;
        /// Floor on both spot and harmonic-mean in-range liquidity.
        uint128 minLiquidity;
        /// Pyth equity feed; zero for none.
        bytes32 pythFeedId;
        /// Pyth leg freshness, and the reported tolerance for a stable quote.
        uint64 pythMaxAge;
        /// Widest gap between two live legs, bps of the reference leg.
        uint16 maxDeviationBps;
        /// Sanity band, 1e6 USD.
        uint64 minPrice1e6;
        uint64 maxPrice1e6;
        /// A stale Pyth print this young is the off-hours anchor; 0 = default.
        uint64 anchorMaxAge;
        /// Widest move from the anchor, bps of the anchor; 0 = default.
        uint16 offHoursMaxMoveBps;
        /// TWAP window while anchored; 0 = default.
        uint32 offHoursTwapSecs;
        /// Attested leg freshness; 0 means `DEFAULT_ATTEST_MAX_AGE`.
        uint64 attestMaxAge;
    }

    struct Config {
        Params p;
        uint8 baseDecimals;
        uint8 quoteDecimals;
        bool set;
    }

    struct Attestation {
        uint64 price1e6;
        uint64 publishTime;
        /// `attesterEpoch` at storage time; a rotation invalidates it.
        uint32 epoch;
    }

    struct Legs {
        uint256 twapPrice1e6;
        uint256 twapPublishedAt;
        uint256 twapMaxAge;
        uint256 pythPrice1e6;
        uint256 pythPublishedAt;
        int24 meanTick;
        uint128 spotLiquidity;
        uint128 harmonicMeanLiquidity;
        uint256 anchorPrice1e6;
        uint256 anchorPublishedAt;
        uint32 twapWindow;
        /// Fresh, in-band attestation; zero when unavailable.
        uint256 attestedPrice1e6;
        uint256 attestedPublishedAt;
    }

    uint32 public constant DEFAULT_TWAP_SECS = 1800;
    uint32 public constant MIN_TWAP_SECS = 300;
    uint32 public constant MAX_TWAP_SECS = 86_400;
    uint16 public constant MAX_DEVIATION_BPS = 5000;
    uint64 public constant DEFAULT_ANCHOR_MAX_AGE = 4 days;
    uint16 public constant DEFAULT_OFF_HOURS_MAX_MOVE_BPS = 1500;
    uint32 public constant DEFAULT_OFF_HOURS_TWAP_SECS = 7200;
    /// Signed at `/launch/prepare`; a user may sit on the wallet prompt for a
    /// minute or more, and the cross-checks bound drift within 5 minutes.
    uint64 public constant DEFAULT_ATTEST_MAX_AGE = 300;
    uint64 public constant MAX_ATTEST_MAX_AGE = 3600;
    /// How far ahead of the block an attestation's `publishTime` may be.
    uint64 public constant MAX_FUTURE_SKEW = 5;
    uint256 public constant MAX_CONF_BPS = 200;
    /// Domain tag of the signed message.
    string public constant ATTESTATION_DOMAIN = "STONKZ_PRICE_V1";

    IPyth public immutable pyth;
    /// Whose `pauser()` may stop the attested leg; zero for admin only.
    address public immutable launchpad;
    address public admin;
    address public pendingAdmin;
    IPriceSource public quotePriceSource;
    IPriceSource public fallbackSource;
    /// Signs attestations; zero disables the attested leg.
    address public attester;
    /// Bumped on every `setAttester`; stored attestations from an older epoch are void.
    uint32 public attesterEpoch;
    bool public attestationsPaused;
    mapping(address => bool) public isStableQuote;
    mapping(address => uint256) public quoteRefs;
    mapping(address => Config) internal _configs;
    mapping(address => Attestation) public latest;

    event ConfigSet(address indexed baseToken, Params params);
    event ConfigCleared(address indexed baseToken);
    event StableQuoteSet(address indexed token, bool stable);
    event QuotePriceSourceSet(address source);
    event FallbackSourceSet(address source);
    event AdminProposed(address pendingAdmin);
    event AdminAccepted(address admin);
    event AttesterSet(address attester, uint32 epoch);
    event AttestationsPaused(bool paused, address by);
    event PriceAttested(address indexed base, uint64 price1e6, uint64 publishTime);

    constructor(
        address _admin,
        IPyth _pyth,
        IPriceSource _quotePriceSource,
        IPriceSource _fallbackSource,
        address _launchpad
    ) {
        require(_admin != address(0), "zero admin");
        require(
            address(_fallbackSource) == address(0) || address(_fallbackSource) != address(_quotePriceSource),
            "quote source"
        );
        admin = _admin;
        pyth = _pyth;
        launchpad = _launchpad;
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

    /// @notice Rotate (or, with zero, disable) the attestation signer. Every
    /// attestation stored under the previous signer stops counting at once.
    function setAttester(address a) external onlyAdmin {
        attester = a;
        attesterEpoch += 1;
        emit AttesterSet(a, attesterEpoch);
    }

    /// @notice Emergency stop for the attested leg: the admin or the
    /// launchpad's pauser. Only the admin can resume (`setAttestationsPaused`).
    function pauseAttestations() external {
        require(
            msg.sender == admin || (msg.sender != address(0) && msg.sender == _launchpadPauser()),
            "not pauser"
        );
        attestationsPaused = true;
        emit AttestationsPaused(true, msg.sender);
    }

    function setAttestationsPaused(bool paused) external onlyAdmin {
        attestationsPaused = paused;
        emit AttestationsPaused(paused, msg.sender);
    }

    function setQuotePriceSource(IPriceSource s) external onlyAdmin {
        require(address(s) != address(this), "self");
        quotePriceSource = s;
        emit QuotePriceSourceSet(address(s));
    }

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
        require(baseToken != address(0), "zero");
        uint8 qd;
        if (p.pool != address(0)) {
            require(p.quoteToken != address(0), "zero");
            require(p.quoteToken != baseToken, "quote is base");
            require(p.pool.code.length > 0, "pool");
            address t0 = IUniswapV3PoolOracle(p.pool).token0();
            address t1 = IUniswapV3PoolOracle(p.pool).token1();
            require(
                (t0 == baseToken && t1 == p.quoteToken) || (t0 == p.quoteToken && t1 == baseToken),
                "pool tokens"
            );
            require(p.minLiquidity > 0, "minLiquidity");
            require(isStableQuote[p.quoteToken] || address(quotePriceSource) != address(0), "quote unpriced");
            // Loop guard: a quote is never a base, and a base is never a quote.
            require(!_configs[p.quoteToken].set, "quote is a configured base");
            qd = IERC20DecimalsV2(p.quoteToken).decimals();
        } else {
            require(p.quoteToken == address(0), "quote without pool");
        }
        require(quoteRefs[baseToken] == 0, "base is a quote");
        if (p.twapSecs == 0) p.twapSecs = DEFAULT_TWAP_SECS;
        require(p.twapSecs >= MIN_TWAP_SECS && p.twapSecs <= MAX_TWAP_SECS, "twapSecs");
        require(p.pythMaxAge > 0, "pythMaxAge");
        if (p.pythFeedId != bytes32(0)) require(address(pyth) != address(0), "no pyth");
        require(p.maxDeviationBps > 0 && p.maxDeviationBps <= MAX_DEVIATION_BPS, "deviation");
        require(p.minPrice1e6 > 0 && p.maxPrice1e6 >= p.minPrice1e6, "band");
        if (p.anchorMaxAge == 0) p.anchorMaxAge = DEFAULT_ANCHOR_MAX_AGE;
        if (p.offHoursMaxMoveBps == 0) p.offHoursMaxMoveBps = DEFAULT_OFF_HOURS_MAX_MOVE_BPS;
        if (p.offHoursTwapSecs == 0) p.offHoursTwapSecs = DEFAULT_OFF_HOURS_TWAP_SECS;
        if (p.attestMaxAge == 0) p.attestMaxAge = DEFAULT_ATTEST_MAX_AGE;
        require(p.anchorMaxAge >= p.pythMaxAge, "anchorMaxAge");
        require(p.offHoursMaxMoveBps <= MAX_DEVIATION_BPS, "offHoursMaxMoveBps");
        require(p.offHoursTwapSecs >= p.twapSecs && p.offHoursTwapSecs <= MAX_TWAP_SECS, "offHoursTwapSecs");
        require(p.attestMaxAge <= MAX_ATTEST_MAX_AGE, "attestMaxAge");

        uint8 bd = IERC20DecimalsV2(baseToken).decimals();
        require(bd <= 36 && qd <= 36, "decimals");

        address old = _configs[baseToken].p.quoteToken;
        if (old != address(0)) quoteRefs[old] -= 1;
        if (p.quoteToken != address(0)) quoteRefs[p.quoteToken] += 1;
        _configs[baseToken] = Config(p, bd, qd, true);
        emit ConfigSet(baseToken, p);
    }

    function clearConfig(address baseToken) external onlyAdmin {
        address old = _configs[baseToken].p.quoteToken;
        if (old != address(0)) quoteRefs[old] -= 1;
        delete _configs[baseToken];
        emit ConfigCleared(baseToken);
    }

    /* ------------------------------------------------------- attestations */

    /// @notice The 32-byte message the attester `personal_sign`s.
    function attestationDigest(address base, uint64 price1e6, uint64 publishTime)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(ATTESTATION_DOMAIN, block.chainid, address(this), base, price1e6, publishTime)
        );
    }

    /// @notice ABI-decode an attestation. External so `postAttestation` can
    /// `try` it: malformed bytes are a no-op, never a revert.
    function decodeAttestation(bytes calldata att)
        external
        pure
        returns (bytes4 magic, address base, uint64 price1e6, uint64 publishTime, bytes memory signature)
    {
        return abi.decode(att, (bytes4, address, uint64, uint64, bytes));
    }

    /// @inheritdoc IStockAttestationSink
    /// @dev Permissionless: the signature is the authorisation.
    function postAttestation(bytes calldata att) external returns (bool accepted) {
        address signer = attester;
        if (signer == address(0) || attestationsPaused) return false;
        bytes4 magic;
        address base;
        uint64 price;
        uint64 time;
        bytes memory sig;
        try this.decodeAttestation(att) returns (bytes4 m, address b, uint64 p, uint64 t, bytes memory s) {
            (magic, base, price, time, sig) = (m, b, p, t, s);
        } catch {
            return false;
        }
        if (magic != STOCK_ATTESTATION_MAGIC || price == 0 || !_configs[base].set) return false;
        if (time > block.timestamp + MAX_FUTURE_SKEW) return false;
        Attestation memory prev = latest[base];
        uint32 epoch = attesterEpoch;
        if (prev.epoch == epoch && time <= prev.publishTime) return false;

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(attestationDigest(base, price, time));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) return false;

        latest[base] = Attestation(price, time, epoch);
        emit PriceAttested(base, price, time);
        return true;
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
        if (!c.set) return _fallback(baseToken);
        maxAgeSecs = c.p.pythMaxAge;

        Legs memory l;
        try this.legs(baseToken) returns (Legs memory got) {
            l = got;
        } catch {
            return (0, 0, maxAgeSecs);
        }

        bool twap = l.twapPrice1e6 != 0;
        bool equity = l.pythPrice1e6 != 0;
        bool attested = l.attestedPrice1e6 != 0;
        uint16 dev = c.p.maxDeviationBps;
        if (equity) {
            // 1. Pyth, checked against every other live leg.
            if (attested && !_within(l.attestedPrice1e6, l.pythPrice1e6, dev)) return (0, 0, maxAgeSecs);
            if (twap && !_within(l.pythPrice1e6, l.twapPrice1e6, dev)) return (0, 0, maxAgeSecs);
            (price1e6, publishedAt) = (l.pythPrice1e6, l.pythPublishedAt);
            if (twap) {
                publishedAt = _min(publishedAt, l.twapPublishedAt);
                maxAgeSecs = _min(maxAgeSecs, l.twapMaxAge);
            }
        } else if (attested) {
            // 2. The signed price, against the TWAP, else the last close.
            (price1e6, publishedAt, maxAgeSecs) =
            (l.attestedPrice1e6, l.attestedPublishedAt, c.p.attestMaxAge);
            if (twap) {
                if (!_within(l.attestedPrice1e6, l.twapPrice1e6, dev)) return (0, 0, maxAgeSecs);
                publishedAt = _min(publishedAt, l.twapPublishedAt);
                maxAgeSecs = _min(maxAgeSecs, l.twapMaxAge);
            } else if (l.anchorPrice1e6 != 0) {
                if (!_within(l.attestedPrice1e6, l.anchorPrice1e6, c.p.offHoursMaxMoveBps)) {
                    return (0, 0, maxAgeSecs);
                }
            }
        } else if (twap) {
            // 3. The TWAP, bounded by the last close off hours.
            if (l.anchorPrice1e6 != 0 && !_within(l.twapPrice1e6, l.anchorPrice1e6, c.p.offHoursMaxMoveBps)) {
                return (0, 0, maxAgeSecs);
            }
            (price1e6, publishedAt, maxAgeSecs) = (l.twapPrice1e6, l.twapPublishedAt, l.twapMaxAge);
        } else {
            // 4. Fallback.
            (price1e6, publishedAt, maxAgeSecs) = _fallback(baseToken);
            if (maxAgeSecs == 0) maxAgeSecs = c.p.pythMaxAge;
        }
        if (price1e6 < c.p.minPrice1e6 || price1e6 > c.p.maxPrice1e6) return (0, 0, maxAgeSecs);
    }

    /// @notice Every leg for `baseToken`, each zero when unavailable.
    function legs(address baseToken) external view returns (Legs memory l) {
        Config memory c = _configs[baseToken];
        if (!c.set) return l;
        _pythLeg(c, l);
        if (l.pythPrice1e6 != 0) (l.anchorPrice1e6, l.anchorPublishedAt) = (0, 0);
        l.twapWindow = l.anchorPrice1e6 != 0 ? c.p.offHoursTwapSecs : c.p.twapSecs;
        if (c.p.pool != address(0)) _twapLeg(baseToken, c, l);
        _attestedLeg(baseToken, c, l);
    }

    /// @notice Whether the attested leg is live (attester set, not paused).
    function attestationsLive() external view returns (bool) {
        return attester != address(0) && !attestationsPaused;
    }

    /* -------------------------------------------------------------- legs */

    function _attestedLeg(address baseToken, Config memory c, Legs memory l) private view {
        if (attester == address(0) || attestationsPaused) return;
        Attestation memory a = latest[baseToken];
        if (a.price1e6 == 0 || a.epoch != attesterEpoch) return;
        uint256 at = a.publishTime > block.timestamp ? block.timestamp : a.publishTime;
        if (block.timestamp - at > c.p.attestMaxAge) return;
        if (a.price1e6 < c.p.minPrice1e6 || a.price1e6 > c.p.maxPrice1e6) return;
        l.attestedPrice1e6 = a.price1e6;
        l.attestedPublishedAt = at;
    }

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
        try pool.observe(ago) returns (int56[] memory ticks, uint160[] memory spl) {
            if (ticks.length != 2 || spl.length != 2) return;
            (l.meanTick, l.harmonicMeanLiquidity) = V3Oracle.consult(ticks, spl, l.twapWindow);
        } catch {
            // "OLD": no shorter window is tried (see `StockPriceSource`).
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
            uint256 at = p.publishTime > block.timestamp ? block.timestamp : p.publishTime;
            uint256 age = block.timestamp - at;
            if (age <= c.p.anchorMaxAge) (l.anchorPrice1e6, l.anchorPublishedAt) = (scaled, at);
            if (age > c.p.pythMaxAge) return;
            if (uint256(p.conf) * 10_000 > raw * MAX_CONF_BPS) return;
            l.pythPrice1e6 = scaled;
            l.pythPublishedAt = at;
        } catch {}
    }

    /* ------------------------------------------------------------ helpers */

    function _launchpadPauser() private view returns (address) {
        if (launchpad == address(0)) return address(0);
        try ILaunchpadPauser(launchpad).pauser() returns (address p) {
            return p;
        } catch {
            return address(0);
        }
    }

    function _fallback(address baseToken) private view returns (uint256, uint256, uint256) {
        if (address(fallbackSource) == address(0)) return (0, 0, 0);
        try fallbackSource.priceUsd1e6(baseToken) returns (uint256 p, uint256 at, uint256 age) {
            return (p, at, age);
        } catch {
            return (0, 0, 0);
        }
    }

    function _within(uint256 a, uint256 ref, uint256 bps) private pure returns (bool) {
        uint256 diff = a > ref ? a - ref : ref - a;
        return diff * 10_000 <= ref * bps;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

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
