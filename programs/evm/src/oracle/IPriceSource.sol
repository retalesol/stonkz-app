// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title The launchpad's only view of the outside world.
/// @notice Deliberately tiny, and deliberately **not** reverting on staleness.
/// The caller decides what a stale price means, because the answer differs by
/// call site: `createToken` must refuse to snapshot a stale price, graduation
/// must merely defer, and a trade must never consult it at all.
///
/// Two implementations exist. `ChainlinkPriceSource` is what runs on Robinhood
/// Chain, where Chainlink is the only oracle deployed. `PushPriceSource` is the
/// mirror of the Solana program's program-owned `BaseOracle` account, and is
/// what the tests drive.
interface IPriceSource {
    /// @param baseToken The curve's base mint.
    /// @return price1e6 USD price of one whole base token in 1e6 fixed point.
    ///         Zero means "no answer" — never revert for that.
    /// @return publishedAt Unix seconds of the observation the price came from.
    /// @return maxAgeSecs How old this particular feed is allowed to get before
    ///         a caller should treat it as stale. Per-feed rather than global
    ///         because heartbeats differ by two orders of magnitude: ETH/USD on
    ///         Robinhood Chain is 86400s, and the equity feeds only update
    ///         24/5, so a single global bound is wrong for one of them.
    function priceUsd1e6(address baseToken)
        external
        view
        returns (uint256 price1e6, uint256 publishedAt, uint256 maxAgeSecs);
}
