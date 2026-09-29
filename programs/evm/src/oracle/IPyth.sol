// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The slice of Pyth Core (Pyth's `pyth-sdk-solidity` `IPyth`)
/// this system uses, ABI-identical to it. `Price` is `PythStructs.Price`.
///
/// Pull model: a price only lands on chain when someone submits a signed
/// Hermes update with `updatePriceFeeds` and pays `getUpdateFee`. The router
/// does that inside the launch transaction, so no keeper and no server key is
/// involved in pricing a launch.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    /// Reverts (`PriceFeedNotFound`) for a feed that was never updated.
    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}
