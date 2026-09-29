// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {ReferralVault} from "../src/ReferralVault.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {BaseSepolia} from "../src/config/BaseSepolia.sol";
import {RouterWiring} from "./RouterWiring.sol";
import {MainnetGuard} from "./MainnetGuard.sol";

/// @title Deploy the standalone `ReferralVault` beside an existing launchpad.
///
/// Non-upgradeable and holds only what the operator moves into it, so it can
/// be deployed (and redeployed) without touching the launchpad proxy.
///
/// ```
/// export PRIVATE_KEY=0x...
/// LAUNCHPAD_ADDRESS=0x... EXPECT_CHAIN_ID=84532 \
/// REFERRAL_SIGNER=0x<api signer address> REFERRAL_MAX_PER_DAY=2000000000000000000 \
///   forge script script/DeployReferralVault.s.sol:DeployReferralVault --rpc-url $RPC --broadcast -vvv
/// ```
///
/// - `REFERRAL_SIGNER`: the address of the API's `REFERRAL_SIGNER_KEY_EVM`
///   (message signing only; it holds no funds). Required and non-zero.
/// - `REFERRAL_MAX_PER_DAY`: WETH wei all referrers together may claim per
///   rolling day — the blast radius of a leaked signer. Required and non-zero
///   (`0` would leave WETH disabled). `type(uint256).max` removes the cap;
///   refused on mainnet.
/// - `WETH_ADDRESS`: optional override; defaults to the chain's pinned WETH9.
/// - `ADMIN`: testnets only, defaults to the deployer. On mainnet the vault's
///   admin is the launchpad's admin — the timelock — and the guard checks the
///   launchpad is already governed before anything is deployed.
contract DeployReferralVault is Script {
    address internal constant BASE_MAINNET_WETH9 = 0x4200000000000000000000000000000000000006;

    function run() external {
        // First: a mainnet run without the governance env stops here.
        MainnetGuard.Governance memory gov = MainnetGuard.requireOnMainnet();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "DeployReferralVault: unexpected chain id");

        address launchpad = vm.envOr("LAUNCHPAD_ADDRESS", vm.envOr("RH_LAUNCHPAD_ADDRESS", address(0)));
        require(launchpad != address(0), "DeployReferralVault: set LAUNCHPAD_ADDRESS");
        require(launchpad.code.length > 0, "DeployReferralVault: no code at launchpad");

        address signer = vm.envAddress("REFERRAL_SIGNER");
        require(signer != address(0), "DeployReferralVault: REFERRAL_SIGNER is zero");
        uint256 cap = vm.envUint("REFERRAL_MAX_PER_DAY");
        require(cap != 0, "DeployReferralVault: REFERRAL_MAX_PER_DAY is zero (WETH would stay disabled)");

        address admin;
        if (MainnetGuard.isMainnet()) {
            require(cap != type(uint256).max, "DeployReferralVault: an uncapped vault is not allowed on mainnet");
            StonkzLaunchpad pad = StonkzLaunchpad(launchpad);
            MainnetGuard.requireTimelockAdmin(pad, gov);
            admin = pad.admin();
        } else {
            admin = vm.envOr("ADMIN", vm.addr(vm.envUint("PRIVATE_KEY")));
        }

        address weth = vm.envOr("WETH_ADDRESS", address(0));
        if (weth == address(0)) weth = _pinnedWeth();
        require(weth != address(0), "DeployReferralVault: set WETH_ADDRESS on this chain");
        require(weth.code.length > 0, "DeployReferralVault: no code at WETH");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        ReferralVault vault = new ReferralVault(admin, signer, weth, launchpad, cap);
        vm.stopBroadcast();

        require(vault.admin() == admin, "DeployReferralVault: admin mismatch");
        require(vault.signer() == signer, "DeployReferralVault: signer mismatch");
        require(vault.maxPerDay(weth) == cap, "DeployReferralVault: cap mismatch");

        console2.log("chain          ", block.chainid);
        console2.log("ReferralVault  ", address(vault));
        console2.log("admin          ", admin);
        console2.log("signer         ", signer);
        console2.log("weth           ", weth);
        console2.log("maxPerDay (wei)", cap);
        console2.log("launchpadPauser", vault.launchpadPauser());
        console2.log("Next: REFERRAL_VAULT_ADDRESS_<NET> on the API, deployments/<chainId>.json,");
        console2.log("      then fund: withdrawTreasury(0, weth, amount, vault) from the protocol authority.");
    }

    function _pinnedWeth() internal view returns (address) {
        if (
            RobinhoodChainTestnet.isTestnet() || BaseSepolia.isTestnet()
                || block.chainid == RobinhoodChain.MAINNET_CHAIN_ID
        ) {
            (, address weth,,) = RouterWiring.forChain();
            return weth;
        }
        if (block.chainid == 8453) return BASE_MAINNET_WETH9;
        return address(0);
    }
}
