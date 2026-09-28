// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice `createToken` must bound `supply`.
///
/// The curve is safe for the product's supply set (1e6, 5e8, 1e9, 1e12 whole
/// tokens), but the contract used to accept any `supply` whose `supply * 1e18`
/// and `k` merely fit a uint256. A creator calling the contract directly could
/// pick a supply (e.g. 5e40 against an 18-decimal base) for which the coin
/// launches and trades normally but `mcapBase = virtualBase * supply`
/// overflows once `virtualBase` has roughly doubled. From then on `graduate`
/// reverts on both triggers; once the curve is exhausted `buy`/`sell` also
/// revert ("curve complete"), so every buyer's base is frozen in the pad for
/// good and the tokens they hold have no market.
contract LaunchSupplyTest is Test {
    StonkzLaunchpad pad;
    PushPriceSource oracle;
    MockERC20 weth;

    address admin = address(0xA11CE);
    address oracleAuth = address(0x0AC1E);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);

    /// WETH-like base: 18 decimals, $4,000.
    uint256 constant PRICE_1E6 = 4_000e6;
    /// A supply the contract used to accept that bricks graduation.
    uint256 constant POISON_SUPPLY = 5e40;

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, address(0xC01D1), address(0xC01D2), oracle, admin);
        vm.prank(oracleAuth);
        oracle.pushPrice(address(weth), PRICE_1E6, 0);

        weth.mint(trader, 1_000 ether);
        vm.prank(trader);
        weth.approve(address(pad), type(uint256).max);
    }

    /// The arithmetic the fix exists for: a completed curve at the poison
    /// supply overflows `mcapBase`, which `graduate` evaluates unconditionally.
    function test_PoisonSupplyOverflowsMcapAtCompletion() public {
        uint256 s = POISON_SUPPLY * 1e18;
        CurveMath.CurveParams memory p = CurveMath.deriveCurve(s, PRICE_1E6, 18);
        // Creation arithmetic is fine: k and the opening mcap both fit...
        assertGt(this.mcapOf(CurveMath.State(p.virtualBase, p.virtualToken, 0, p.tokensForSale, p.k), s), 0);
        // ...but at exhaustion (virtualBase = 4 * VB0, SPEC.md section 1) it is not.
        CurveMath.State memory done =
            CurveMath.State(4 * p.virtualBase, p.virtualToken - p.tokensForSale, 3 * p.virtualBase, 0, p.k);
        vm.expectRevert(stdError.arithmeticError);
        this.mcapOf(done, s);
    }

    function mcapOf(CurveMath.State memory st, uint256 s) external pure returns (uint256) {
        return CurveMath.mcapBase(st, s);
    }

    function test_CreateTokenRefusesSupplyAboveTheAllowedSet() public {
        vm.prank(creator);
        vm.expectRevert(bytes("supply"));
        pad.createToken("Poison", "POISON", "u", POISON_SUPPLY, address(weth), 250, false);

        vm.prank(creator);
        vm.expectRevert(bytes("supply"));
        pad.createToken("Big", "BIG", "u", 1e12 + 1, address(weth), 250, false);
    }

    /// Every supply the product offers still launches, and the largest one
    /// still runs the curve to exhaustion and graduates on an 18-decimal base.
    function test_AllowedSuppliesLaunchAndTheLargestGraduates() public {
        uint256[4] memory supplies = [uint256(1e6), 5e8, 1e9, 1e12];
        address token;
        for (uint256 i = 0; i < supplies.length; i++) {
            vm.prank(creator);
            token = pad.createToken("Coin", "OK", "u", supplies[i], address(weth), 250, false);
        }
        vm.prank(trader);
        pad.buy(token, 100 ether, 0);
        assertTrue(pad.coinInfo(token).complete, "curve exhausted");
        pad.graduate(token);
        assertTrue(pad.coinInfo(token).graduated, "graduated");
    }
}
