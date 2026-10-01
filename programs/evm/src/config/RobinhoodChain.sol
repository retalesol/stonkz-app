// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Robinhood Chain deployment constants.
/// @notice Every chain-specific value lives here so that a correction to
/// `docs/robinhood-chain.md` is a one-file change and never touches curve or
/// fee logic. Sourced from that document; see `ASSUMPTIONS.md` for the
/// confidence level on each and what to re-verify before mainnet.
library RobinhoodChain {
    /* ------------------------------------------------------------- identity */

    uint256 internal constant MAINNET_CHAIN_ID = 4663;
    uint256 internal constant TESTNET_CHAIN_ID = 46630;

    /// @dev The gas token is ETH, 18 decimals. There is no native chain token.
    address internal constant WETH9 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    /// @dev Paxos Global Dollar, **6 decimals** — the chain's headline stable
    /// and the recommended base for USD-denominated curves.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /* ---------------------------------------------------------------- uniswap */

    address internal constant UNISWAP_V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address internal constant UNISWAP_V2_ROUTER02 = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;

    /// @dev Uniswap V3 on 4663. All four hold code (read 2026-10-01 via
    /// `https://rpc.mainnet.chain.robinhood.com`); the factory has the 1% tier
    /// enabled (`feeAmountTickSpacing(10000) == 200`), which is what
    /// `UniswapV3Migrator` needs for the graduation pool.
    address internal constant UNISWAP_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant UNISWAP_V3_SWAP_ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant UNISWAP_V3_QUOTER_V2 = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    /// Reference only: `FeeLocker` owns graduation positions directly in the
    /// pool by `(locker, tickLower, tickUpper)` and never touches the NFPM.
    address internal constant UNISWAP_V3_NFPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    /// Graduation pool fee tier for `UniswapV3Migrator` (1%, tick spacing 200).
    uint24 internal constant GRADUATION_POOL_FEE = 10_000;

    address internal constant UNISWAP_V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UNISWAP_V4_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /* -------------------------------------------------------------- oracle */

    /// @dev Pyth Core on 4663 — the same address as on 8453 and on RH testnet
    /// 46630. Verified 2026-10-01 via `https://rpc.mainnet.chain.robinhood.com`:
    /// holds code, `chainId() == 60101` (Pyth's Wormhole id for this chain),
    /// `getValidTimePeriod() == 60`. Launches carry a Hermes update for it
    /// in-tx (`StonkzRouter.createAndBuyWithEth` / `createWithPriceUpdate`),
    /// which is why the launchpad's live price source is `PythPriceSource`
    /// and the Chainlink feeds below are its fallback.
    address internal constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    /// Pyth ETH/USD price feed id (the same on every chain).
    bytes32 internal constant PYTH_ETH_USD =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    /// @dev Chainlink `AggregatorV3Interface` proxies, USD-denominated, 8
    /// decimals. Sourced from `docs/robinhood-chain.md` rows 40/60 and the
    /// Chainlink reference-data directory for chain 4663.
    address internal constant CHAINLINK_ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant CHAINLINK_USDG_USD = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address internal constant CHAINLINK_USDC_USD = 0x9e6f4605992a899eE2999999F3Ec80C41F452546;

    /// @dev **86400 seconds.** These feeds have a 24h heartbeat, not the
    /// minute-scale one a mainnet-Ethereum instinct would assume. Every
    /// staleness bound derived from this must be heartbeat + grace, or
    /// graduation becomes permanently unreachable — the bug this constant
    /// exists to stop recurring. See `docs/robinhood-chain.md` row 40.
    uint64 internal constant CHAINLINK_HEARTBEAT_SECS = 86_400;

    /// @dev Heartbeat plus a one-hour grace window, the value the launchpad
    /// and `ChainlinkPriceSource` should both be configured with.
    uint64 internal constant ORACLE_MAX_AGE_SECS = CHAINLINK_HEARTBEAT_SECS + 3_600;

    /* -------------------------------------------------------------- ArbOS */

    /// @dev This is an Arbitrum Orbit rollup, so `block.number` returns an
    /// estimate of the **L1** block number, not L2 height. Anything that needs
    /// L2 height must call `ArbSys.arbBlockNumber()`. The launchpad deliberately
    /// uses `block.timestamp` only, never `block.number`.
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;
    address internal constant ARB_GAS_INFO = 0x000000000000000000000000000000000000006C;

    function isRobinhoodChain() internal view returns (bool) {
        return block.chainid == MAINNET_CHAIN_ID || block.chainid == TESTNET_CHAIN_ID;
    }
}
