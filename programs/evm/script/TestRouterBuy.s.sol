// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console2} from "forge-std/Script.sol";
import {StonkzRouter} from "../src/StonkzRouter.sol";

contract TestRouterBuy is Script {
  function run() external {
    StonkzRouter router = StonkzRouter(payable(0xC4146582Ee47eb390Ff9C16E568b9d4D1b409513));
    address token = 0xB9C37853787b71d91Db900E10CA96231aC0Df429;
    // WRAP_ETH only, MSG_SENDER, CONTRACT_BALANCE = 1<<255
    bytes memory commands = hex"0b";
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = abi.encode(address(1), uint256(1) << 255);
    StonkzRouter.AggregatorLeg memory leg = StonkzRouter.AggregatorLeg({
      commands: commands,
      inputs: inputs,
      deadline: block.timestamp + 300,
      amountIn: 0,
      quotedOut: 0.001 ether,
      maxSlippageBps: 0
    });
    uint256 pk = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(pk);
    try router.buyViaAggregator{value: 0.001 ether}(token, leg, 0, block.timestamp + 300) returns (uint256 out) {
      console2.log("ok", out);
    } catch Error(string memory reason) {
      console2.log("revert string", reason);
    } catch (bytes memory data) {
      console2.logBytes(data);
    }
    vm.stopBroadcast();
  }
}
