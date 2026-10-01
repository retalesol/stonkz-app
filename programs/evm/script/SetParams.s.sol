// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Pack the nine human-readable launchpad parameters into the word
/// `StonkzLaunchpad.setParams` takes, show it, and (only with `BROADCAST=1`)
/// send it.
///
/// Every field defaults to what the launchpad holds **today** (`paramsWord()`),
/// so the operator names only the knobs that change. The script refuses a word
/// `CurveMath.validParams` would reject before it prints anything else, and a
/// dry run (the default) sends nothing: it prints the word, the decoded
/// fields next to the current ones, and the calldata.
///
/// ```
/// LAUNCHPAD_ADDRESS=0x... FEE_PROTOCOL_BPS=2000 FEE_OPS_BPS=500 FEE_BURN_BPS=500 \
///   forge script script/SetParams.s.sol:SetParams --rpc-url $RPC -vvv            # dry run
/// read -s PRIVATE_KEY && export PRIVATE_KEY                                        # launchpad admin
/// LAUNCHPAD_ADDRESS=0x... FEE_PROTOCOL_BPS=2000 FEE_OPS_BPS=500 FEE_BURN_BPS=500 BROADCAST=1 \
///   forge script script/SetParams.s.sol:SetParams --rpc-url $RPC --broadcast -vvv
/// ```
/// Fields (all optional, defaulting to the live value): `FEE_PROTOCOL_BPS`,
/// `FEE_OPS_BPS`, `FEE_BURN_BPS`, `MIN_FEE_BPS`, `MAX_FEE_BPS`,
/// `CB_START_FEE_BPS`, `CB_WINDOW_SECS`, `GRAD_MCAP_USD_1E6` (or
/// `GRAD_MCAP_USD` in whole dollars), `MAX_SUPPLY` (whole tokens).
///
/// On mainnet (`MainnetGuard`) the admin is the timelock: the script never
/// calls the proxy and prints the `setParams` calldata to schedule instead;
/// the same when the signer is not the admin on a testnet.
contract SetParams is Script {
    function run() external returns (uint256 word) {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "SetParams: unexpected chain id");
        address proxy = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(proxy.code.length > 0, "SetParams: set LAUNCHPAD_ADDRESS");
        StonkzLaunchpad pad = StonkzLaunchpad(proxy);

        uint256 current = pad.paramsWord();
        CurveMath.Params memory p = fromEnv(CurveMath.unpack(current));
        word = CurveMath.pack(p);
        print("current", CurveMath.unpack(current));
        print("new    ", p);
        console2.log("word (PARAMS_WORD):", word);
        console2.logBytes32(bytes32(word));
        require(CurveMath.validParams(word), "SetParams: the word fails CurveMath.validParams");
        console2.log("calldata: setParams(uint256), target = proxy, value 0");
        console2.logBytes(abi.encodeCall(pad.setParams, (word)));
        if (word == current) console2.log("(no change against the live word)");

        if (!vm.envOr("BROADCAST", false)) {
            console2.log("dry run: nothing sent. BROADCAST=1 --broadcast to send.");
            return word;
        }
        uint256 pk = vm.envUint("PRIVATE_KEY");
        bool mainnet = MainnetGuard.isMainnet();
        if (mainnet) MainnetGuard.requireTimelockAdmin(pad, gov);
        if (mainnet || pad.admin() != vm.addr(pk)) {
            console2.log(
                "not calling the proxy (signer is not admin, or mainnet); schedule the calldata above"
            );
            return word;
        }
        vm.startBroadcast(pk);
        pad.setParams(word);
        vm.stopBroadcast();
        require(pad.paramsWord() == word, "SetParams: paramsWord() did not take");
        console2.log("setParams sent; paramsWord() now", pad.paramsWord());
    }

    /// Each field from the env, defaulting to `d`.
    function fromEnv(CurveMath.Params memory d) public view returns (CurveMath.Params memory p) {
        p.feeProtocolBps = _u16("FEE_PROTOCOL_BPS", d.feeProtocolBps);
        p.feeOpsBps = _u16("FEE_OPS_BPS", d.feeOpsBps);
        p.feeBurnBps = _u16("FEE_BURN_BPS", d.feeBurnBps);
        p.minFeeBps = _u16("MIN_FEE_BPS", d.minFeeBps);
        p.maxFeeBps = _u16("MAX_FEE_BPS", d.maxFeeBps);
        p.cbStartFeeBps = _u16("CB_START_FEE_BPS", d.cbStartFeeBps);
        uint256 window = vm.envOr("CB_WINDOW_SECS", uint256(d.cbWindowSecs));
        require(window <= type(uint32).max, "SetParams: CB_WINDOW_SECS does not fit uint32");
        p.cbWindowSecs = uint32(window);
        uint256 grad = vm.envOr("GRAD_MCAP_USD_1E6", uint256(d.gradMcapUsd1e6));
        uint256 gradUsd = vm.envOr("GRAD_MCAP_USD", uint256(0));
        if (gradUsd != 0) grad = gradUsd * 1e6;
        require(grad <= type(uint64).max, "SetParams: GRAD_MCAP_USD_1E6 does not fit uint64");
        p.gradMcapUsd1e6 = uint64(grad);
        uint256 supply = vm.envOr("MAX_SUPPLY", uint256(d.maxSupply));
        require(supply <= type(uint64).max, "SetParams: MAX_SUPPLY does not fit uint64");
        p.maxSupply = uint64(supply);
    }

    function print(string memory tag, CurveMath.Params memory p) public pure {
        console2.log(string.concat(tag, " feeProtocolBps  "), p.feeProtocolBps);
        console2.log(string.concat(tag, " feeOpsBps       "), p.feeOpsBps);
        console2.log(string.concat(tag, " feeBurnBps      "), p.feeBurnBps);
        console2.log(
            string.concat(tag, " creatorBucketBps"), 10_000 - p.feeProtocolBps - p.feeOpsBps - p.feeBurnBps
        );
        console2.log(string.concat(tag, " minFeeBps       "), p.minFeeBps);
        console2.log(string.concat(tag, " maxFeeBps       "), p.maxFeeBps);
        console2.log(string.concat(tag, " cbStartFeeBps   "), p.cbStartFeeBps);
        console2.log(string.concat(tag, " cbWindowSecs    "), p.cbWindowSecs);
        console2.log(string.concat(tag, " gradMcapUsd1e6  "), p.gradMcapUsd1e6);
        console2.log(string.concat(tag, " maxSupply       "), p.maxSupply);
    }

    function _u16(string memory name, uint16 d) private view returns (uint16) {
        uint256 v = vm.envOr(name, uint256(d));
        require(v <= type(uint16).max, string.concat("SetParams: ", name, " does not fit uint16"));
        return uint16(v);
    }
}
