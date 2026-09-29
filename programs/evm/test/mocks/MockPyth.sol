// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPyth} from "../../src/oracle/IPyth.sol";

/// @notice Pyth Core's pull flow, minus the signatures: an "update" is
/// `abi.encode(id, price, conf, expo, publishTime)`, it costs `feePerUpdate`
/// wei each, only a newer `publishTime` overwrites, and reading a feed that
/// was never updated reverts `PriceFeedNotFound` — the behaviours the router
/// and `PythPriceSource` depend on. (Pyth's `pyth-sdk-solidity` is not
/// vendored in `lib/`.)
contract MockPyth is IPyth {
    error PriceFeedNotFound();
    error InsufficientFee();

    uint256 public feePerUpdate;
    mapping(bytes32 => Price) internal _prices;
    uint256 public updates;

    constructor(uint256 _feePerUpdate) {
        feePerUpdate = _feePerUpdate;
    }

    function createUpdate(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(id, price, conf, expo, publishTime);
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < feePerUpdate * updateData.length) revert InsufficientFee();
        for (uint256 i = 0; i < updateData.length; i++) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint256));
            if (publishTime > _prices[id].publishTime) _prices[id] = Price(price, conf, expo, publishTime);
        }
        updates += updateData.length;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory p) {
        p = _prices[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
    }
}
