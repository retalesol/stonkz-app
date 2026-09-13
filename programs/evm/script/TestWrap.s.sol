// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console2} from "forge-std/Script.sol";
interface IUR { function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable; }
interface IWETH { function deposit() external payable; function balanceOf(address) external view returns (uint256); function approve(address,uint256) external returns (bool); }
interface IPad { function buy(address,uint256,uint256) external returns (uint256); }

contract TestWrap is Script {
  function run() external {
    address ur = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address weth = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address pad = 0x2588E500B1e5fCF18253F44b6f2607BF2B14161C;
    address token = 0xB9C37853787b71d91Db900E10CA96231aC0Df429;
    uint256 pk = vm.envUint("PRIVATE_KEY");
    address me = vm.addr(pk);
    vm.startBroadcast(pk);
    // Direct path: deposit + approve + buy
    IWETH(weth).deposit{value: 0.001 ether}();
    IWETH(weth).approve(pad, 0.001 ether);
    uint256 out = IPad(pad).buy(token, 0.001 ether, 0);
    console2.log("bought", out);
    vm.stopBroadcast();
  }
}
