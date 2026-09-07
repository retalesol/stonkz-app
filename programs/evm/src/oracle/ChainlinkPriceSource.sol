// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPriceSource} from "./IPriceSource.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title Chainlink price source for Robinhood Chain.
/// @notice Chainlink is the only oracle deployed on chain 4663 — Pyth is not
/// present — so this is the production path, not one of several.
///
/// Three things about this chain shape the implementation, all from
/// `docs/robinhood-chain.md` §8:
///
/// 1. **Heartbeats are long.** ETH/USD (`0x78F3556b…d3A9`) has a heartbeat of
///    **86400 seconds**. The conventional `updatedAt > block.timestamp - 1 hours`
///    guard would mark a perfectly healthy feed stale roughly 23 hours out of
///    every 24, which for us means graduation could essentially never fire.
///    The bound is therefore per-feed and configured from the feed's own
///    heartbeat plus a grace window.
/// 2. **There is no L2 Sequencer Uptime Feed for 4663.** Chainlink's documented
///    L2 practice — gate `latestRoundData` on the uptime feed — is unavailable.
///    What is left is the heartbeat bound, an `answeredInRound` check, and a
///    per-feed sanity band, so all three are here.
/// 3. **Equity feeds update 24/5.** A coin based on a stock token has no fresh
///    price at the weekend by design. That is a reason for the caller to defer
///    graduation, never a reason to revert a trade.
///
/// This contract never reverts on a bad answer. It returns a zero price and
/// lets the caller decide, because the correct response differs per call site.
contract ChainlinkPriceSource is IPriceSource {
    struct Feed {
        AggregatorV3Interface aggregator;
        /// The feed's published heartbeat plus our grace window, in seconds.
        uint64 maxAgeSecs;
        /// Sanity band, 1e6 USD. An answer outside it is treated as no answer:
        /// a feed that has gone haywire should stop graduations, not price them.
        uint128 minPrice1e6;
        uint128 maxPrice1e6;
        uint8 decimals;
        bool set;
    }

    address public admin;
    address public pendingAdmin;
    mapping(address => Feed) public feeds;

    event FeedSet(
        address indexed baseToken,
        address aggregator,
        uint64 maxAgeSecs,
        uint128 minPrice1e6,
        uint128 maxPrice1e6
    );
    event FeedCleared(address indexed baseToken);

    constructor(address _admin) {
        require(_admin != address(0), "zero admin");
        admin = _admin;
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

    /// @param maxAgeSecs The feed's own heartbeat plus a grace window. For
    /// ETH/USD on Robinhood Chain that is 86400 + grace, not an hour.
    function setFeed(
        address baseToken,
        AggregatorV3Interface aggregator,
        uint64 maxAgeSecs,
        uint128 minPrice1e6,
        uint128 maxPrice1e6
    ) external onlyAdmin {
        require(address(aggregator) != address(0), "zero aggregator");
        require(maxAgeSecs > 0, "maxAge");
        require(minPrice1e6 > 0 && maxPrice1e6 >= minPrice1e6, "band");
        uint8 d = aggregator.decimals();
        // Chainlink USD feeds on this chain are 8 decimals. Anything wider than
        // this would overflow the scaling below on a plausible answer.
        require(d <= 36, "decimals");
        feeds[baseToken] = Feed({
            aggregator: aggregator,
            maxAgeSecs: maxAgeSecs,
            minPrice1e6: minPrice1e6,
            maxPrice1e6: maxPrice1e6,
            decimals: d,
            set: true
        });
        emit FeedSet(baseToken, address(aggregator), maxAgeSecs, minPrice1e6, maxPrice1e6);
    }

    function clearFeed(address baseToken) external onlyAdmin {
        delete feeds[baseToken];
        emit FeedCleared(baseToken);
    }

    /// @inheritdoc IPriceSource
    function priceUsd1e6(address baseToken)
        external
        view
        returns (uint256 price1e6, uint256 publishedAt, uint256 maxAgeSecs)
    {
        Feed memory f = feeds[baseToken];
        if (!f.set) return (0, 0, 0);
        maxAgeSecs = f.maxAgeSecs;

        // A feed that reverts must not take the launchpad down with it: a
        // reverting aggregator has to read as "no answer", the same as a stale
        // one, or an oracle outage becomes a launchpad outage.
        try f.aggregator.latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || updatedAt == 0) return (0, 0, maxAgeSecs);
            // Carried over from a previous round: the feed has not actually
            // answered this round, so the timestamp overstates its freshness.
            if (answeredInRound < roundId) return (0, 0, maxAgeSecs);

            // Safe: `answer <= 0` returned above, so this is a positive int256.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 scaled = _to1e6(uint256(answer), f.decimals);
            if (scaled < f.minPrice1e6 || scaled > f.maxPrice1e6) return (0, 0, maxAgeSecs);
            return (scaled, updatedAt, maxAgeSecs);
        } catch {
            return (0, 0, maxAgeSecs);
        }
    }

    function _to1e6(uint256 answer, uint8 decimals) private pure returns (uint256) {
        if (decimals == 6) return answer;
        if (decimals > 6) return answer / (10 ** (decimals - 6));
        return answer * (10 ** (6 - decimals));
    }
}
