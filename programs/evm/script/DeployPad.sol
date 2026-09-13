// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";

/// @dev Deploys UUPS implementations behind ERC1967 proxies for tests and scripts.
library DeployPad {
    function pushOracle(address admin, address oracleAuthority, uint64 defaultMaxAge)
        internal
        returns (PushPriceSource oracle)
    {
        PushPriceSource impl = new PushPriceSource();
        bytes memory data = abi.encodeCall(PushPriceSource.initialize, (admin, oracleAuthority, defaultMaxAge));
        oracle = PushPriceSource(address(new ERC1967Proxy(address(impl), data)));
    }

    function launchpad(
        address admin,
        address protocolWithdrawAuthority,
        address opsWithdrawAuthority,
        IPriceSource priceSource,
        address migrationAuthority
    ) internal returns (StonkzLaunchpad pad) {
        StonkzLaunchpad impl = new StonkzLaunchpad();
        bytes memory data = abi.encodeCall(
            StonkzLaunchpad.initialize,
            (admin, protocolWithdrawAuthority, opsWithdrawAuthority, priceSource, migrationAuthority)
        );
        pad = StonkzLaunchpad(address(new ERC1967Proxy(address(impl), data)));
    }
}
