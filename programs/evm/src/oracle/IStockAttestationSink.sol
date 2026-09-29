// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @dev First four bytes of a signed stock-price attestation ("STKA"). The
/// router routes `priceUpdate` entries starting with it to the attestation
/// sink instead of Pyth (whose update blobs start with "PNAU").
bytes4 constant STOCK_ATTESTATION_MAGIC = 0x53544b41;

/// @notice Where `StonkzRouter` posts signed stock-price attestations
/// (`StockPriceSourceV2`). Must never revert for a bad, stale or duplicate
/// attestation: it returns `false` and the launch carries on.
interface IStockAttestationSink {
    function postAttestation(bytes calldata att) external returns (bool accepted);
}
