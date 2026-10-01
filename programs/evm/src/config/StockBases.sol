// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {RobinhoodChain} from "./RobinhoodChain.sol";
import {RobinhoodChainTestnet} from "./RobinhoodChainTestnet.sol";

/// @title Per-chain stock-token bases for `StockPriceSource`.
/// @notice One entry per stock token: the Uniswap V3 pool its TWAP is read
/// from, the pool's quote token, the Pyth equity feed (same id on every chain)
/// and a sanity band. `script/DeployStockPriceSource.s.sol` configures every
/// entry for `block.chainid`; `script/SeedStockPool.s.sol` looks pools up here.
///
/// **Mainnet (RH 4663, Base 8453): no stock bases in v1.** Both branches are
/// deliberately empty, so `DeployMainnet` deploys `StockPriceSourceV2` with
/// no base configured and the attested/TWAP legs idle; `createToken` against a
/// stock token then fails preflight (no price) rather than pricing off nothing.
/// Adding one later is a timelock operation, not a redeploy: pin the token
/// and its stock/WETH pool here, then schedule
/// `StockPriceSourceV2.setConfig(token, params)` (and, the first time,
/// `PythPriceSource.setFallbackSource(StockPriceSourceV2)`) through the
/// timelock — see `docs/deployment.md` §2.3. The feed ids and bands are
/// chain-independent (`_entry`). A stock with no pool yet cannot be listed
/// (the source refuses a config without one); create the pool first
/// (`UniswapV3Factory.createPool`) and seed it with `SeedStockPool`.
library StockBases {
    struct Entry {
        string symbol;
        address token;
        /// Uniswap V3 pool of `token` against `quote`.
        address pool;
        address quote;
        uint24 poolFee;
        bytes32 pythFeedId;
        uint64 minPrice1e6;
        uint64 maxPrice1e6;
        /// Off-hours anchor (see `StockPriceSource`): a stale Pyth print this
        /// young bounds the TWAP to `offHoursMaxMoveBps` of it, and the TWAP
        /// runs over `offHoursTwapSecs` meanwhile.
        uint64 anchorMaxAge;
        uint16 offHoursMaxMoveBps;
        uint32 offHoursTwapSecs;
    }

    /// 4 days: Friday's close still anchors the Tuesday open after a Monday holiday.
    uint64 internal constant ANCHOR_MAX_AGE = 4 days;
    /// 15%: beyond this from the last close, off hours, is manipulation.
    uint16 internal constant OFF_HOURS_MAX_MOVE_BPS = 1500;
    /// 2 h TWAP while anchored (30 min in market hours).
    uint32 internal constant OFF_HOURS_TWAP_SECS = 7200;

    /// Pyth `Equity.US.<SYM>/USD` feed ids (identical on every chain).
    bytes32 internal constant PYTH_TSLA = 0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1;
    bytes32 internal constant PYTH_AMZN = 0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a;
    bytes32 internal constant PYTH_PLTR = 0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0;
    bytes32 internal constant PYTH_NFLX = 0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2;
    bytes32 internal constant PYTH_AMD = 0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e;

    /* ---------------------------------------------- Robinhood Chain testnet */

    address internal constant RH_TESTNET_TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address internal constant RH_TESTNET_AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address internal constant RH_TESTNET_PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address internal constant RH_TESTNET_NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address internal constant RH_TESTNET_AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    /// Stock/WETH fee-3000 pools on the testnet V3 factory. They exist and are
    /// initialized (at a placeholder 1:1 price) but hold no liquidity until an
    /// operator runs `SeedStockPool`.
    address internal constant RH_TESTNET_TSLA_WETH = 0x92FaFf22a8d9d6968d1F22Dd6531AcCF676Ec067;
    address internal constant RH_TESTNET_AMZN_WETH = 0xD51AB7B9c9b8F733bd36b41F53e9BD3F94F41a52;
    address internal constant RH_TESTNET_PLTR_WETH = 0xBEBc379755Fb95061f3d3A5E209d612A1416Ed02;
    address internal constant RH_TESTNET_NFLX_WETH = 0x5D311cD5096c2A48EC838968041A835Da4b4cCF0;
    address internal constant RH_TESTNET_AMD_WETH = 0x06cB034c1a2302d1d0Ac2C225d933594833610dC;

    /// @return e Every stock base configured for this chain; empty on the
    ///         mainnets (v1 scope) and on Base Sepolia.
    function forChain() internal view returns (Entry[] memory e) {
        if (block.chainid == RobinhoodChain.MAINNET_CHAIN_ID || block.chainid == Base.CHAIN_ID) {
            // v1 mainnet: none. Opt in per token through the timelock (see the
            // library notice above); never by editing the testnet branch.
            return e;
        }
        if (block.chainid == RobinhoodChainTestnet.CHAIN_ID) {
            address weth = RobinhoodChainTestnet.WETH9;
            e = new Entry[](5);
            e[0] = _entry("TSLA", RH_TESTNET_TSLA, RH_TESTNET_TSLA_WETH, weth, PYTH_TSLA);
            e[1] = _entry("AMZN", RH_TESTNET_AMZN, RH_TESTNET_AMZN_WETH, weth, PYTH_AMZN);
            e[2] = _entry("PLTR", RH_TESTNET_PLTR, RH_TESTNET_PLTR_WETH, weth, PYTH_PLTR);
            e[3] = _entry("NFLX", RH_TESTNET_NFLX, RH_TESTNET_NFLX_WETH, weth, PYTH_NFLX);
            e[4] = _entry("AMD", RH_TESTNET_AMD, RH_TESTNET_AMD_WETH, weth, PYTH_AMD);
        }
        // Base Sepolia (84532): no stock tokens exist there.
    }

    /// @return The entry for `token` on this chain; reverts if there is none.
    function find(address token) internal view returns (Entry memory) {
        Entry[] memory e = forChain();
        for (uint256 i = 0; i < e.length; i++) {
            if (e[i].token == token) return e[i];
        }
        revert("StockBases: token not listed for this chain");
    }

    /// @dev Band: $1 .. $10,000 — a sanity bound (decimals or orientation
    /// wrong by orders of magnitude), wide enough for any listed stock and the
    /// splits they do. It does not catch a merely wrong price; the
    /// liquidity floors and the Pyth cross-check do that.
    function _entry(string memory symbol, address token, address pool, address quote, bytes32 feed)
        private
        pure
        returns (Entry memory)
    {
        return Entry(
            symbol,
            token,
            pool,
            quote,
            3000,
            feed,
            1e6,
            10_000e6,
            ANCHOR_MAX_AGE,
            OFF_HOURS_MAX_MOVE_BPS,
            OFF_HOURS_TWAP_SECS
        );
    }
}
