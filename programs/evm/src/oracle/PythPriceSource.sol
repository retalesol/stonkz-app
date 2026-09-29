// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPriceSource} from "./IPriceSource.sol";
import {IPyth} from "./IPyth.sol";

/// @title `IPriceSource` over Pyth Core, for launches priced by an in-transaction
/// Hermes update.
/// @notice `StonkzRouter` submits the update (`pyth.updatePriceFeeds`) in the
/// launch transaction and then creates the coin, so the price this reads is
/// seconds old and the launchpad's staleness bound can be tight. Nothing here
/// writes a price, so there is no keeper and no server key.
///
/// Three kinds of entry per base token:
/// - **Pyth feed** (`setFeed`): `getPriceUnsafe(feedId)`, scaled from the
///   feed's exponent to 1e6, rejected when its confidence interval is wider
///   than `MAX_CONF_BPS` of the price or when it falls outside the entry's
///   sanity band.
/// - **Fixed price** (`setFixedPrice`): for USD stablecoins (USDG, USDC) this
///   deployment pins **$1.00** rather than reading their Pyth feeds. The price
///   only snapshots the curve at launch and triggers graduation — fills are
///   priced by the curve, never by the oracle — so a stable's basis points of
///   drift are immaterial, while a second feed would be a second thing that can
///   be stale and block a launch. A de-peg is an admin decision (`setFeed` to
///   the Pyth USD feed, or `clearFeed`), not something to price through.
/// - **Fallback** (no entry): delegated to `fallbackSource` if one is set —
///   on testnets the previous `PushPriceSource`, so bases Pyth does not cover
///   (the RH testnet stock tokens) keep whatever pricing they had.
///
/// Like `ChainlinkPriceSource`, this never reverts: "no answer" is a zero
/// price, and the caller decides what that means (`createToken` refuses,
/// `graduate` defers, trades never ask).
contract PythPriceSource is IPriceSource {
    struct Feed {
        /// Pyth price feed id; zero for a fixed-price entry.
        bytes32 feedId;
        /// Returned as the feed's own staleness tolerance.
        uint64 maxAgeSecs;
        /// Sanity band, 1e6 USD. Outside it reads as no answer.
        uint64 minPrice1e6;
        uint64 maxPrice1e6;
        /// Non-zero: a fixed-price entry, always current.
        uint64 fixedPrice1e6;
    }

    /// Widest confidence interval, in bps of the price, that still counts as
    /// an answer — the same 2% `PushPriceSource` applies.
    uint256 public constant MAX_CONF_BPS = 200;

    IPyth public immutable pyth;
    address public admin;
    address public pendingAdmin;
    mapping(address => Feed) public feeds;
    /// Consulted for base tokens with no entry here; zero for none.
    IPriceSource public fallbackSource;

    event FeedSet(
        address indexed baseToken, bytes32 feedId, uint64 maxAgeSecs, uint64 minPrice1e6, uint64 maxPrice1e6
    );
    event FixedPriceSet(address indexed baseToken, uint64 price1e6, uint64 maxAgeSecs);
    event FeedCleared(address indexed baseToken);
    event FallbackSourceSet(address source);

    constructor(address _admin, IPyth _pyth) {
        require(_admin != address(0), "zero admin");
        require(address(_pyth) != address(0), "zero pyth");
        admin = _admin;
        pyth = _pyth;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function proposeAdmin(address a) external onlyAdmin {
        pendingAdmin = a;
    }

    function acceptAdmin() external {
        require(pendingAdmin != address(0) && msg.sender == pendingAdmin, "not pending");
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function setFeed(
        address baseToken,
        bytes32 feedId,
        uint64 maxAgeSecs,
        uint64 minPrice1e6,
        uint64 maxPrice1e6
    ) external onlyAdmin {
        require(feedId != bytes32(0), "zero feed");
        require(maxAgeSecs > 0, "maxAge");
        require(minPrice1e6 > 0 && maxPrice1e6 >= minPrice1e6, "band");
        feeds[baseToken] = Feed(feedId, maxAgeSecs, minPrice1e6, maxPrice1e6, 0);
        emit FeedSet(baseToken, feedId, maxAgeSecs, minPrice1e6, maxPrice1e6);
    }

    function setFixedPrice(address baseToken, uint64 price1e6, uint64 maxAgeSecs) external onlyAdmin {
        require(price1e6 > 0, "price");
        require(maxAgeSecs > 0, "maxAge");
        feeds[baseToken] = Feed(bytes32(0), maxAgeSecs, price1e6, price1e6, price1e6);
        emit FixedPriceSet(baseToken, price1e6, maxAgeSecs);
    }

    function clearFeed(address baseToken) external onlyAdmin {
        delete feeds[baseToken];
        emit FeedCleared(baseToken);
    }

    function setFallbackSource(IPriceSource s) external onlyAdmin {
        require(address(s) != address(this), "self");
        fallbackSource = s;
        emit FallbackSourceSet(address(s));
    }

    /// @inheritdoc IPriceSource
    function priceUsd1e6(address baseToken)
        external
        view
        returns (uint256 price1e6, uint256 publishedAt, uint256 maxAgeSecs)
    {
        Feed memory f = feeds[baseToken];
        if (f.fixedPrice1e6 != 0) return (f.fixedPrice1e6, block.timestamp, f.maxAgeSecs);
        if (f.feedId == bytes32(0)) return _fallback(baseToken);
        maxAgeSecs = f.maxAgeSecs;

        // A feed that was never updated reverts in Pyth; that is "no answer".
        try pyth.getPriceUnsafe(f.feedId) returns (IPyth.Price memory p) {
            if (p.price <= 0 || p.publishTime == 0) return (0, 0, maxAgeSecs);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 raw = uint256(uint64(p.price));
            // `conf` shares the price's exponent, so compare them unscaled.
            if (uint256(p.conf) * 10_000 > raw * MAX_CONF_BPS) return (0, 0, maxAgeSecs);
            uint256 scaled = _to1e6(raw, p.expo);
            if (scaled < f.minPrice1e6 || scaled > f.maxPrice1e6) return (0, 0, maxAgeSecs);
            // Hermes can stamp an update a second or two ahead of an L2's block
            // clock. The launchpad refuses a price "from the future", so report
            // such a price as current rather than let a fresh update read as
            // unusable.
            publishedAt = p.publishTime > block.timestamp ? block.timestamp : p.publishTime;
            return (scaled, publishedAt, maxAgeSecs);
        } catch {
            return (0, 0, maxAgeSecs);
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

    /// @dev `raw · 10^(expo + 6)`. Pyth exponents are small negatives (−8 for
    /// USD feeds); anything that would overflow or round to nothing reads as
    /// no answer via the band check.
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
