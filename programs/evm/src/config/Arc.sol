// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Circle Arc mainnet (5042) — pins for Stonkz deploy scripts.
///
/// @notice Arc is an EVM L1 whose gas token is USDC. At the EVM layer the
/// native value carries 18 decimals (`msg.value`, balances); the ERC-20 face
/// of USDC carries 6. The public testnet (5042002) closed on 17 Sep 2026, so
/// there is no test chain: every Stonkz deployment on Arc is mainnet, and the
/// router is deployed with a hard per-buy cap (`MAX_BUY_NATIVE`) that the API
/// and UI mirror.
///
/// @dev Every address below is a **placeholder** until it has been read from
/// docs.arc.io and verified on the explorer. `DeployArc` refuses to broadcast
/// while any of them is zero, so filling this file in is a deliberate act,
/// not something a typo can do. Confirm in this order:
///   1. `WRAPPED_NATIVE`: the canonical wrapped-USDC predeploy the router wraps
///      `msg.value` into (`buyWithEth` requires the coin's base to be exactly
///      this address).
///   2. `USDC_ERC20`: the 6-decimal ERC-20 face of USDC, the default launch
///      base in `MAJORS.ARC`.
///   3. The Uniswap deployment on Arc (Universal Router, Permit2, V3 factory,
///      SwapRouter02, QuoterV2). If Arc ships a different DEX, the migrator
///      and router need a config change, not just new pins.
library Arc {
    uint256 internal constant CHAIN_ID = 5042;

    /// Canonical wrapped native USDC (18 decimals). PLACEHOLDER — see above.
    address internal constant WRAPPED_NATIVE = address(0);

    /// ERC-20 USDC (6 decimals). PLACEHOLDER.
    address internal constant USDC_ERC20 = address(0);

    /// Uniswap on Arc. PLACEHOLDERS.
    address internal constant UNIVERSAL_ROUTER = address(0);
    address internal constant PERMIT2 = address(0);
    address internal constant UNISWAP_V3_FACTORY = address(0);
    address internal constant UNISWAP_V3_SWAP_ROUTER02 = address(0);
    address internal constant UNISWAP_V3_QUOTER_V2 = address(0);

    /// 25 USDC per buy, in native wei (18 decimals). Mirrors
    /// `NET_INFO.ARC.maxTradeUsd` in packages/shared (nets.ts); change both together.
    uint256 internal constant MAX_BUY_NATIVE = 25e18;

    /// Sub-second finality; the oracle staleness window can be tighter than
    /// the testnets' 25 hours once a real feed is wired.
    uint64 internal constant ORACLE_MAX_AGE_SECS = 90_000;

    function isArc() internal view returns (bool) {
        return block.chainid == CHAIN_ID;
    }

    /// True once every pin has been filled in.
    function pinned() internal pure returns (bool) {
        return WRAPPED_NATIVE != address(0) && USDC_ERC20 != address(0)
            && UNIVERSAL_ROUTER != address(0) && UNISWAP_V3_SWAP_ROUTER02 != address(0);
    }
}
