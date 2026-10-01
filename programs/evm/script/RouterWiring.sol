// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Base} from "../src/config/Base.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {BaseSepolia} from "../src/config/BaseSepolia.sol";

/// @dev The per-chain constructor wiring for `StonkzRouter` (and the Pyth
/// pricing that goes with it), shared by every deploy and upgrade script so
/// they cannot drift: RH testnet 46630, RH mainnet 4663, Base Sepolia 84532
/// and Base mainnet 8453 are resolved by chain id; anything else reverts.
/// Testnets pin chain-local WETH (the Universal Router on 46630 still targets
/// mainnet aeWETH) and SwapRouter02. Arc (5042) is deliberately absent: it is
/// deferred and `DeployArc` fails closed on its own placeholders.
library RouterWiring {
    /// Pyth ETH/USD, the same id on every chain.
    bytes32 internal constant PYTH_ETH_USD =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    /// RH testnet's mintable USDG stand-in (`deployments/46630.json` `TestnetUsdg`).
    address internal constant RH_TESTNET_USDG_STANDIN = 0x4bfBc27516EdCf36a93060A3c42Ef0c1cDB9E267;

    function isPinned() internal view returns (bool) {
        return RobinhoodChainTestnet.isTestnet() || BaseSepolia.isTestnet()
            || block.chainid == RobinhoodChain.MAINNET_CHAIN_ID || Base.isBase();
    }

    function forChain() internal view returns (address ur, address weth, address sr02, address pyth) {
        if (RobinhoodChainTestnet.isTestnet()) {
            return (
                RobinhoodChainTestnet.UNIVERSAL_ROUTER,
                RobinhoodChainTestnet.WETH9,
                RobinhoodChainTestnet.UNISWAP_V3_SWAP_ROUTER02,
                RobinhoodChainTestnet.PYTH
            );
        }
        if (BaseSepolia.isTestnet()) {
            return (
                BaseSepolia.UNIVERSAL_ROUTER,
                BaseSepolia.WETH9,
                BaseSepolia.UNISWAP_V3_SWAP_ROUTER02,
                BaseSepolia.PYTH
            );
        }
        if (block.chainid == RobinhoodChain.MAINNET_CHAIN_ID) {
            return (
                RobinhoodChain.UNIVERSAL_ROUTER,
                RobinhoodChain.WETH9,
                RobinhoodChain.UNISWAP_V3_SWAP_ROUTER02,
                RobinhoodChain.PYTH
            );
        }
        if (Base.isBase()) {
            return (Base.UNIVERSAL_ROUTER, Base.WETH9, Base.UNISWAP_V3_SWAP_ROUTER02, Base.PYTH);
        }
        revert("RouterWiring: only RH 46630/4663 and Base 84532/8453 are pinned here");
    }

    /// USD stablecoin bases, priced at a fixed $1.00 by `PythPriceSource`.
    function stables() internal view returns (address[] memory s) {
        if (RobinhoodChainTestnet.isTestnet()) {
            s = new address[](2);
            s[0] = RobinhoodChainTestnet.USDG;
            s[1] = RH_TESTNET_USDG_STANDIN;
        } else if (BaseSepolia.isTestnet()) {
            s = new address[](1);
            s[0] = BaseSepolia.USDC;
        } else if (block.chainid == RobinhoodChain.MAINNET_CHAIN_ID) {
            s = new address[](1);
            s[0] = RobinhoodChain.USDG;
        } else if (Base.isBase()) {
            s = new address[](1);
            s[0] = Base.USDC;
        }
    }

    /// The canonical Uniswap V3 factory and the graduation pool fee tier
    /// (`UniswapV3Migrator`); factory zero where this library has no pin.
    function v3() internal view returns (address factory, uint24 fee) {
        if (RobinhoodChainTestnet.isTestnet()) {
            return (RobinhoodChainTestnet.UNISWAP_V3_FACTORY, RobinhoodChainTestnet.GRADUATION_POOL_FEE);
        }
        if (BaseSepolia.isTestnet()) {
            return (BaseSepolia.UNISWAP_V3_FACTORY, BaseSepolia.GRADUATION_POOL_FEE);
        }
        if (block.chainid == RobinhoodChain.MAINNET_CHAIN_ID) {
            return (RobinhoodChain.UNISWAP_V3_FACTORY, RobinhoodChain.GRADUATION_POOL_FEE);
        }
        if (Base.isBase()) return (Base.UNISWAP_V3_FACTORY, Base.GRADUATION_POOL_FEE);
        return (address(0), 0);
    }

    /// Chainlink USD feeds (8 decimals) for `ChainlinkPriceSource`, the
    /// mainnet fallback behind `PythPriceSource`: ETH/USD for WETH and, on RH,
    /// USDG/USD. Zero on the testnets (no Chainlink directory there).
    function chainlink() internal view returns (address ethUsd, address stableUsd, address stable) {
        if (block.chainid == RobinhoodChain.MAINNET_CHAIN_ID) {
            return (RobinhoodChain.CHAINLINK_ETH_USD, RobinhoodChain.CHAINLINK_USDG_USD, RobinhoodChain.USDG);
        }
        if (Base.isBase()) return (Base.CHAINLINK_ETH_USD, address(0), address(0));
        return (address(0), address(0), address(0));
    }
}
