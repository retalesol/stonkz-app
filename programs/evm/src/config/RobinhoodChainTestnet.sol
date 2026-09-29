// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Robinhood Chain **testnet** (46630) deployment constants.
/// @notice Mainnet pins in `RobinhoodChain.sol` do not hold code on 46630 for
/// WETH, USDG, Uniswap V2, or Chainlink. These addresses were verified live
/// against `https://rpc.testnet.chain.robinhood.com` before the first deploy.
library RobinhoodChainTestnet {
    uint256 internal constant CHAIN_ID = 46_630;

    /// @dev Canonical L2 WETH on Robinhood testnet (docs.robinhood.com/chain/contracts).
    address internal constant WETH9 = 0x7943e237c7F95DA44E0301572D358911207852Fa;

    /// @dev USDG on testnet (distinct from mainnet).
    address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    /// @dev Same CREATE2 addresses as mainnet — code is present on 46630.
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Uniswap V3 / V4 (testnet-specific; for API fee-tier overrides).
    address internal constant UNISWAP_V3_FACTORY = 0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932;
    address internal constant UNISWAP_V3_SWAP_ROUTER02 = 0xb79cB26e90EBBD9bC02c75267c9a86dBa1AFedB7;
    address internal constant UNISWAP_V4_POOL_MANAGER = 0x552815eF68E6eb418A3d65D0AA1043d93204F612;

    /// @dev No Chainlink directory for 46630 — use PushPriceSource.
    uint64 internal constant ORACLE_MAX_AGE_SECS = 90_000;

    /// Pyth Core (RH testnet). Launches carry a Hermes update for it in-tx.
    address internal constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    /// Pyth ETH/USD price feed id (the same on every chain).
    bytes32 internal constant PYTH_ETH_USD =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    function isTestnet() internal view returns (bool) {
        return block.chainid == CHAIN_ID;
    }
}
