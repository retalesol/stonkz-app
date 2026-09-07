// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Minimal safe ERC-20 call wrappers.
/// @notice Closes security finding M4 (`docs/security-review-findings.md`).
///
/// The contracts here always did `require(IERC20(t).transfer(...))`, so an
/// unchecked `false` return was never the exposure. The real exposure is the
/// other direction: a token that returns **no data at all** from `transfer` /
/// `transferFrom` / `approve` — a well-known non-standard shape, most famously
/// mainnet USDT — makes Solidity's ABI decode of the declared `bool` return
/// revert. That is fail-closed rather than a loss, but it silently means such
/// a token can never be used as a base asset: `createToken` would appear to
/// work and every trade against it would revert.
///
/// These wrappers accept both shapes: the call must succeed, and its return
/// data must be either empty or a `true` bool. Anything else reverts with a
/// named error rather than a bare string, so a failure is attributable.
///
/// Only used for **foreign** tokens (base assets, whatever an operator
/// configures). Calls to this repo's own `StonkzToken` stay direct typed
/// calls: it is a known-standard implementation in this same tree, and
/// routing them through a low-level call would lose type checking for no gain.
library SafeErc20 {
    error TransferFailed(address token, address to, uint256 amount);
    error TransferFromFailed(address token, address from, address to, uint256 amount);
    error ApproveFailed(address token, address spender, uint256 amount);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!_succeeded(ok, data)) revert TransferFailed(token, to, amount);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!_succeeded(ok, data)) revert TransferFromFailed(token, from, to, amount);
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!_succeeded(ok, data)) revert ApproveFailed(token, spender, amount);
    }

    /// @dev Empty return data counts as success only because the call itself
    /// succeeded. A call to an address with no code also returns `ok == true`
    /// with empty data, which is why every caller here reaches these wrappers
    /// with an address that has already been established as a live token
    /// (a base asset the admin configured, or a token this factory deployed).
    function _succeeded(bool ok, bytes memory data) private pure returns (bool) {
        if (!ok) return false;
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}
