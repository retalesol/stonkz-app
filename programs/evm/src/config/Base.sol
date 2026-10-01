// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Coinbase Base **mainnet** (8453) — pins for Stonkz deploy scripts.
/// @notice Every address below was read on chain on 2026-10-01 via
/// `https://mainnet.base.org` (`cast code` non-empty for each; SwapRouter02
/// and QuoterV2 report `factory()` = `UNISWAP_V3_FACTORY` and SwapRouter02
/// `WETH9()` = `WETH9`; `feeAmountTickSpacing(10000) == 200`; Pyth
/// `chainId() == 30`, `getValidTimePeriod() == 60`; the Chainlink proxy
/// describes itself as "ETH / USD" with 8 decimals). Sources: Uniswap's Base
/// deployments page, docs.pyth.network, Chainlink's reference-data directory.
/// Re-read each on basescan before the first broadcast (`ASSUMPTIONS.md` §4).
///
/// No RH stock tokens exist on Base: `StockBases.forChain()` is empty here
/// and the v1 mainnet scope ships no stock bases on any chain.
library Base {
    uint256 internal constant CHAIN_ID = 8453;

    /// Canonical Base WETH predeploy (the same address as on Base Sepolia).
    address internal constant WETH9 = 0x4200000000000000000000000000000000000006;

    /// Circle native USDC on Base, **6 decimals**.
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /* ---------------------------------------------------------------- uniswap */

    address internal constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant UNISWAP_V3_SWAP_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNISWAP_V3_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    /// Reference only: `FeeLocker` owns graduation positions directly in the
    /// pool and never touches the NonfungiblePositionManager.
    address internal constant UNISWAP_V3_NFPM = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address internal constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// Graduation pool fee tier for `UniswapV3Migrator` (1%, tick spacing 200).
    uint24 internal constant GRADUATION_POOL_FEE = 10_000;

    /* -------------------------------------------------------------- oracle */

    /// Pyth Core on Base mainnet (the same address as on RH 4663 / 46630).
    address internal constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    /// Pyth ETH/USD price feed id (the same on every chain).
    bytes32 internal constant PYTH_ETH_USD =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    /// Chainlink ETH/USD proxy, 8 decimals. `PythPriceSource`'s fallback; the
    /// Base feed heartbeat is 20 min / 0.15% deviation, far inside the bound.
    address internal constant CHAINLINK_ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;

    /// Launchpad-wide staleness clamp; the per-feed Pyth bound (120 s) is the
    /// effective one for WETH launches. Same figure as RH so the two mainnet
    /// deployments are configured identically.
    uint64 internal constant ORACLE_MAX_AGE_SECS = 90_000;

    function isBase() internal view returns (bool) {
        return block.chainid == CHAIN_ID;
    }
}
