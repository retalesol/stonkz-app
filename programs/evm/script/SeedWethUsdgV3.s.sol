// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {V3LiquidityHelper} from "../src/testnet/V3LiquidityHelper.sol";
import {V3ExactInputQuoter} from "../src/testnet/V3ExactInputQuoter.sol";
import {TestnetUsdg} from "../src/testnet/TestnetUsdg.sol";
import {LaunchpadRetargetPatch} from "../src/testnet/LaunchpadRetargetPatch.sol";

interface IERC20Seed {
    function approve(address spender, uint256 value) external returns (bool);
}

interface IWETH9Seed {
    function deposit() external payable;
    function approve(address spender, uint256 value) external returns (bool);
}

interface IUniswapV3FactorySeed {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3PoolSeed {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title Seed WETH/USDG Uniswap V3 liquidity on RH testnet 46630.
contract SeedWethUsdgV3 is Script {
    uint24 internal constant FEE = 3000;
    uint160 internal constant SQRT_WETH_TOKEN0 = 3_961_408_125_713_217_069_514_752;
    uint160 internal constant SQRT_USDG_TOKEN0 = 1_584_563_250_285_286_751_870_879_006_720_000;
    address internal constant COPIUM = 0x821742F0169c261aa4B7d6602B6c40B1615aBC0e;
    /// Current launchpad implementation before this script (from ERC1967 slot).
    address internal constant LAUNCHPAD_IMPL = 0x22Bc74dCb42bD1da02fd2476A807ca2F5A87823f;

    function run() external {
        require(RobinhoodChainTestnet.isTestnet(), "not 46630");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address launchpad = vm.envAddress("RH_LAUNCHPAD_ADDRESS");

        address weth = RobinhoodChainTestnet.WETH9;
        address factory = RobinhoodChainTestnet.UNISWAP_V3_FACTORY;

        uint256 ethAmount = vm.envOr("ETH_AMOUNT_WEI", uint256(0.05 ether));
        uint128 liquidity = uint128(vm.envOr("LIQUIDITY", uint256(1e12)));
        require(me.balance >= ethAmount + 0.01 ether, "need ETH");

        vm.startBroadcast(pk);

        StonkzLaunchpad pad = StonkzLaunchpad(launchpad);

        TestnetUsdg usdg = new TestnetUsdg(me);
        usdg.mint(me, 10_000_000 * 1e6);

        // Tiny patch (full launchpad exceeds EIP-170) → retarget → restore impl.
        LaunchpadRetargetPatch patch = new LaunchpadRetargetPatch();
        pad.upgradeToAndCall(address(patch), "");
        LaunchpadRetargetPatch(launchpad).adminRetargetBase(COPIUM, address(usdg));
        pad.upgradeToAndCall(LAUNCHPAD_IMPL, "");

        V3ExactInputQuoter quoter = new V3ExactInputQuoter(factory);
        V3LiquidityHelper helper = new V3LiquidityHelper();

        bool usdgIsToken0 = address(usdg) < weth;
        uint160 sqrtPriceX96 = usdgIsToken0 ? SQRT_USDG_TOKEN0 : SQRT_WETH_TOKEN0;

        address pool = IUniswapV3FactorySeed(factory).getPool(weth, address(usdg), FEE);
        if (pool == address(0)) {
            pool = IUniswapV3FactorySeed(factory).createPool(weth, address(usdg), FEE);
            IUniswapV3PoolSeed(pool).initialize(sqrtPriceX96);
        } else {
            (uint160 existing,,,,,,) = IUniswapV3PoolSeed(pool).slot0();
            if (existing == 0) IUniswapV3PoolSeed(pool).initialize(sqrtPriceX96);
        }

        IWETH9Seed(weth).deposit{value: ethAmount}();
        require(IWETH9Seed(weth).approve(address(helper), type(uint256).max), "weth approve");
        require(IERC20Seed(address(usdg)).approve(address(helper), type(uint256).max), "usdg approve");
        (uint256 paid0, uint256 paid1) = helper.mintFullRange(pool, liquidity);

        vm.stopBroadcast();

        console2.log("=== seed complete ===");
        console2.log("TestnetUsdg", address(usdg));
        console2.log("usdgIsToken0", usdgIsToken0);
        console2.log("WETH_USDG_V3_POOL", pool);
        console2.log("pool liquidity", IUniswapV3PoolSeed(pool).liquidity());
        console2.log("paid0", paid0);
        console2.log("paid1", paid1);
        console2.log("RH_V3_QUOTER_ADDRESS", address(quoter));
        console2.log("RH_V3_FEE_TIER_OVERRIDES=USDG:3000");
        console2.log("BASE_MINT_OVERRIDES_RH=USDG:%s", address(usdg));
        console2.log("RH_ROUTER_ADDRESS=0xc50F5886a739aF267C164ACaef38036e61C21625");
        console2.log("token0", IUniswapV3PoolSeed(pool).token0());
        console2.log("token1", IUniswapV3PoolSeed(pool).token1());
    }
}
