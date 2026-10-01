// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CurveMath} from "./CurveMath.sol";
import {StonkzLaunchpad} from "./StonkzLaunchpad.sol";

/// @title Read-side helpers the launchpad no longer carries itself.
/// @notice `quoteBuy`, `quoteSell` and `marketCap` used to be launchpad views.
/// The launchpad sits at the EIP-170 ceiling and gave those bytes to the
/// runtime-parameter store (`setParams`), so the same arithmetic now runs
/// here, off the hot path, against `coinInfo` and `paramsWord`. Stateless and
/// permissionless: deploy one per chain or call it from a test.
contract StonkzLens {
    function params(StonkzLaunchpad pad) external view returns (CurveMath.Params memory) {
        return CurveMath.unpack(pad.paramsWord());
    }

    function quoteBuy(StonkzLaunchpad pad, address token, uint256 amountBase)
        external
        view
        returns (CurveMath.BuyFill memory fill, CurveMath.FeeShares memory shares, uint16 bps)
    {
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        uint256 w = pad.paramsWord();
        bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp, w);
        fill = CurveMath.buyQuote(_state(c), bps, amountBase);
        shares = CurveMath.splitFee(fill.fee, w);
    }

    function quoteSell(StonkzLaunchpad pad, address token, uint256 amountToken)
        external
        view
        returns (CurveMath.SellFill memory fill, CurveMath.FeeShares memory shares, uint16 bps)
    {
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        uint256 w = pad.paramsWord();
        bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp, w);
        fill = CurveMath.sellQuote(_state(c), bps, amountToken);
        shares = CurveMath.splitFee(fill.fee, w);
    }

    /// @return base Market cap in base atoms at the curve's spot price.
    /// @return usd1e6 The same at the coin's creation price (the launchpad's
    /// old `marketCap` convention; `graduate` uses a fresh oracle read).
    function marketCap(StonkzLaunchpad pad, address token) external view returns (uint256 base, uint256 usd1e6) {
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        base = CurveMath.mcapBase(_state(c), c.supply);
        usd1e6 = CurveMath.mcapUsd1e6(base, c.creationPrice1e6, c.baseDecimals);
    }

    function _state(StonkzLaunchpad.Coin memory c) private pure returns (CurveMath.State memory) {
        return CurveMath.State(c.virtualBase, c.virtualToken, c.realBase, c.realToken, c.k);
    }
}
