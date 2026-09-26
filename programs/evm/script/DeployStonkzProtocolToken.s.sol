// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {StonkzProtocolToken} from "../src/StonkzProtocolToken.sol";

/// @title Deploy `$STONKZ` on Robinhood Chain (4663 / 46630).
///
/// Initial 1B supply and every privileged role go to
/// `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`. Override the admin with
/// `STONKZ_ADMIN` only if a different key should hold mint/burn/freeze.
///
/// The broadcaster pays gas and is **not** granted roles unless it is that
/// admin. Fund the broadcaster on Robinhood Chain; do not send ETH to any
/// third party.
///
/// ```
/// cd programs/evm
/// forge script script/DeployStonkzProtocolToken.s.sol:DeployStonkzProtocolToken \
///   --rpc-url https://rpc.mainnet.chain.robinhood.com \
///   --broadcast --verify -vvv
/// ```
///
/// Dry-run by omitting `--broadcast`. Use the testnet RPC and chain 46630 first.
contract DeployStonkzProtocolToken is Script {
    address internal constant INITIAL_RECIPIENT = 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca;

    function run() external {
        require(
            RobinhoodChain.isRobinhoodChain(),
            "DeployStonkzProtocolToken: not Robinhood Chain (expected 4663/46630)"
        );

        address admin = vm.envOr("STONKZ_ADMIN", INITIAL_RECIPIENT);
        require(admin != address(0), "DeployStonkzProtocolToken: zero admin");

        vm.startBroadcast();
        StonkzProtocolToken token = new StonkzProtocolToken(admin, INITIAL_RECIPIENT);
        vm.stopBroadcast();

        console2.log("STONKZ_TOKEN_ADDRESS=", address(token));
        console2.log("admin               =", admin);
        console2.log("initialRecipient    =", INITIAL_RECIPIENT);
        console2.log("initialSupply       =", token.INITIAL_SUPPLY());
        console2.log("recipientBalance    =", token.balanceOf(INITIAL_RECIPIENT));
        console2.log("contractURI         =", token.contractURI());
    }
}
