// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Coinbase Base Sepolia (84532) — pins for Stonkz deploy scripts.
/// @notice Addresses from Uniswap's Base deployments page (verified on-chain
/// before first Stonkz broadcast). No RH stock tokens on Base.
library BaseSepolia {
    uint256 internal constant CHAIN_ID = 84532;

    /// Canonical Base Sepolia WETH predeploy.
    address internal constant WETH9 = 0x4200000000000000000000000000000000000006;

    /// Circle Base Sepolia USDC (faucetable / bridged test USDC).
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// Uniswap Universal Router (docs.uniswap.org Base Sepolia pin).
    address internal constant UNIVERSAL_ROUTER = 0x492E6456D9528771018DeB9E87ef7750EF184104;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address internal constant UNISWAP_V3_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant UNISWAP_V3_SWAP_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address internal constant UNISWAP_V3_QUOTER_V2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;
    /// NonfungiblePositionManager (docs.uniswap.org, Base Sepolia; `factory()`
    /// verified on chain 2026-09-30). Reference only: `FeeLocker` owns its
    /// positions directly in the pool and never touches the NFPM.
    address internal constant UNISWAP_V3_NFPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    /// Graduation pool fee tier for `UniswapV3Migrator` (1%, tick spacing 200).
    uint24 internal constant GRADUATION_POOL_FEE = 10_000;

    /// PushPriceSource on testnet (Chainlink is mainnet cutover work).
    uint64 internal constant ORACLE_MAX_AGE_SECS = 90_000;

    /// Pyth Core (Base Sepolia). Launches carry a Hermes update for it in-tx.
    address internal constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    /// Pyth ETH/USD price feed id (the same on every chain).
    bytes32 internal constant PYTH_ETH_USD =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    function isTestnet() internal view returns (bool) {
        return block.chainid == CHAIN_ID;
    }
}
