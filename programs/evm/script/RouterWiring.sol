// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {BaseSepolia} from "../src/config/BaseSepolia.sol";

/// @dev The per-chain constructor wiring for `StonkzRouter` (and the Pyth
/// pricing that goes with it), shared by `DeployRouter.s.sol` and
/// `UpgradeAtomicLaunch.s.sol` so the two cannot drift. Testnets pin
/// chain-local WETH (the Universal Router on 46630 still targets mainnet
/// aeWETH) and SwapRouter02.
library RouterWiring {
    /// Pyth ETH/USD, the same id on every chain.
    bytes32 internal constant PYTH_ETH_USD =
        0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    /// RH testnet's mintable USDG stand-in (`deployments/46630.json` `TestnetUsdg`).
    address internal constant RH_TESTNET_USDG_STANDIN = 0x4bfBc27516EdCf36a93060A3c42Ef0c1cDB9E267;

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
            // No Pyth pin on RH mainnet yet: pass PYTH_ADDRESS to add one.
            return (
                RobinhoodChain.UNIVERSAL_ROUTER,
                RobinhoodChain.WETH9,
                RobinhoodChain.UNISWAP_V3_SWAP_ROUTER02,
                address(0)
            );
        }
        revert("RouterWiring: only RH 46630/4663 and Base Sepolia 84532 are pinned here");
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
        }
    }
}
