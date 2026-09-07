// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {UniswapV2Migrator, IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20, MockV2Factory, MockV2Pair} from "./mocks/Mocks.sol";

/// @notice Graduation into a burned Uniswap v2 position.
///
/// The plan's original wording was "burn the LP and keep the fee-claim
/// authority". `docs/robinhood-chain.md` §4.2 establishes that those two
/// clauses are mutually exclusive on v2 — the pool has no `collect`, fees
/// accrue into reserves, and the LP token *is* the fee claim, so burning it
/// forfeits the fees at the same instant it locks the principal. We take the
/// burn and give up the fees, because nobody is promised them and "the
/// liquidity is gone" is then verifiable on an explorer with no trust in any
/// Stonkz contract. These tests pin that choice down so it cannot drift back.
contract MigrationTest is Test {
    StonkzLaunchpad pad;
    PushPriceSource oracle;
    UniswapV2Migrator migrator;
    MockV2Factory factory;
    MockERC20 base;

    address admin = address(0xA11CE);
    address oracleAuth = address(0x0AC1E);
    address migAuth = address(0x11165);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address sniper = address(0x5417E);

    uint8 constant BASE_DECIMALS = 6;
    uint256 constant ONE = 10 ** BASE_DECIMALS;

    function setUp() public {
        vm.warp(1_800_000_000);
        base = new MockERC20("Global Dollar", "USDG", BASE_DECIMALS);
        oracle = new PushPriceSource(admin, oracleAuth, 90_000);
        pad = new StonkzLaunchpad(admin, admin, admin, oracle, migAuth);
        factory = new MockV2Factory();
        migrator = new UniswapV2Migrator(IUniswapV2Factory(address(factory)), address(pad));

        vm.prank(admin);
        pad.setMigrator(IGraduationMigrator(address(migrator)), migAuth);
        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);

        base.mint(trader, 10_000_000 * ONE);
        vm.prank(trader);
        base.approve(address(pad), type(uint256).max);
        base.mint(sniper, 1_000_000 * ONE);
    }

    function _graduatedCoin(string memory ticker) internal returns (address token) {
        vm.prank(creator);
        token = pad.createToken("Coin", ticker, "u", 1_000_000_000, address(base), 250, false);
        for (uint256 i = 0; i < 40 && pad.coinInfo(token).realToken > 0; i++) {
            vm.prank(trader);
            pad.buy(token, 2_000 * ONE, 0);
        }
        assertEq(pad.coinInfo(token).realToken, 0, "curve exhausted");
        pad.graduate(token);
    }

    function test_MigrationBurnsEveryLpTokenItMints() public {
        address token = _graduatedCoin("BURN");
        uint256 baseRaised = pad.coinInfo(token).realBase;
        uint256 lpReserve = pad.coinInfo(token).lpReserve;
        assertGt(baseRaised, 0);
        assertGt(lpReserve, 0);

        vm.prank(migAuth);
        pad.migrateLiquidity(token);

        address pool = factory.getPair(token, address(base));
        MockV2Pair pair = MockV2Pair(pool);

        // Both sides are in the pool.
        assertEq(base.balanceOf(pool), baseRaised, "the raise moved into the pool");
        assertEq(StonkzToken(token).balanceOf(pool), lpReserve, "so did the escrowed 20%");

        // And every LP token that exists is at the dead address. Nothing is
        // held by the migrator, the launchpad, the creator or the admin.
        uint256 dead = pair.balanceOf(migrator.BURN_ADDRESS());
        assertEq(dead, pair.totalSupply(), "every LP token is burned");
        assertEq(pair.balanceOf(address(migrator)), 0, "the migrator keeps none");
        assertEq(pair.balanceOf(address(pad)), 0, "the launchpad keeps none");
        assertEq(pair.balanceOf(creator), 0, "the creator keeps none");
        assertEq(pair.balanceOf(admin), 0, "the admin keeps none");

        // The launchpad's ledger is zeroed, so the release cannot repeat.
        assertEq(pad.coinInfo(token).realBase, 0);
        assertEq(pad.coinInfo(token).lpReserve, 0);
        vm.prank(migAuth);
        vm.expectRevert(bytes("nothing"));
        pad.migrateLiquidity(token);
    }

    /// @notice The migrator has no withdrawal path at all — not a gated one.
    function test_TheMigratorHasNoWayToRetrieveLiquidity() public {
        address token = _graduatedCoin("NOEXIT");
        vm.prank(migAuth);
        pad.migrateLiquidity(token);

        // There is no such function on the contract, on any role.
        for (uint256 i = 0; i < 4; i++) {
            string[4] memory sigs = [
                "withdraw(address,uint256)",
                "collect(address)",
                "removeLiquidity(address)",
                "sweep(address,address,uint256)"
            ];
            (bool ok,) = address(migrator).call(abi.encodeWithSignature(sigs[i], token, uint256(1)));
            assertFalse(ok, "the migrator must expose no exit");
        }
    }

    function test_OnlyTheLaunchpadCanCallMigrate() public {
        vm.prank(sniper);
        vm.expectRevert(bytes("only launchpad"));
        migrator.migrate(address(base), address(base), 1, 1);
    }

    function test_OnlyTheMigrationAuthorityCanRelease() public {
        address token = _graduatedCoin("AUTH");
        vm.prank(sniper);
        vm.expectRevert(bytes("not migration authority"));
        pad.migrateLiquidity(token);
    }

    function test_CannotMigrateBeforeGraduation() public {
        vm.prank(creator);
        address token = pad.createToken("Coin", "EARLY", "u", 1_000_000_000, address(base), 250, false);
        vm.prank(trader);
        pad.buy(token, 100 * ONE, 0);

        vm.prank(migAuth);
        vm.expectRevert(bytes("not graduated"));
        pad.migrateLiquidity(token);
    }

    /* --------------------------------------------------- the sniper hazard */

    /// A v2 pair address is deterministic from the token pair, so anyone can
    /// create and seed it ahead of the graduation transaction at a price of
    /// their choosing. `mint` prices a deposit off the existing reserves and
    /// silently keeps the excess of the over-supplied side for the incumbent
    /// LPs — so migrating into a manipulated pair hands the curve's raise to
    /// whoever seeded it. `docs/robinhood-chain.md` §4.4, point 2.
    function test_RefusesToMigrateIntoAManipulatedPool() public {
        address token = _graduatedCoin("SNIPE");

        // The sniper front-runs the release, creating the canonical pair and
        // seeding it at roughly 1000x the curve's closing price.
        address pool = factory.createPair(token, address(base));
        vm.startPrank(trader);
        StonkzToken(token).transfer(pool, StonkzToken(token).balanceOf(trader) / 100_000);
        base.transfer(pool, 500_000 * ONE);
        vm.stopPrank();
        MockV2Pair(pool).sync();

        vm.prank(migAuth);
        vm.expectRevert(bytes("pool price manipulated"));
        pad.migrateLiquidity(token);

        // The funds are still on the launchpad, not lost, and the release can
        // be retried once the pool is dealt with.
        assertGt(pad.coinInfo(token).realBase, 0, "the raise is intact");
        assertGt(pad.coinInfo(token).lpReserve, 0, "so is the escrow");
    }

    /// A pair someone created but left empty is fine: we set the price.
    function test_MigratesIntoAnEmptyPreCreatedPair() public {
        address token = _graduatedCoin("EMPTY");
        address pool = factory.createPair(token, address(base));

        vm.prank(migAuth);
        pad.migrateLiquidity(token);
        assertEq(MockV2Pair(pool).balanceOf(migrator.BURN_ADDRESS()), MockV2Pair(pool).totalSupply());
    }

    /// And a pair already sitting at our price is fine, which is what a retry
    /// after a partially-successful release looks like.
    function test_MigratesIntoAPairAlreadyAtTheCurvePrice() public {
        address token = _graduatedCoin("SAME");
        uint256 baseRaised = pad.coinInfo(token).realBase;
        uint256 lpReserve = pad.coinInfo(token).lpReserve;

        address pool = factory.createPair(token, address(base));
        // Seed at exactly the ratio the migrator is about to deposit.
        vm.prank(trader);
        StonkzToken(token).transfer(pool, lpReserve / 1000);
        base.mint(pool, baseRaised / 1000);
        MockV2Pair(pool).sync();

        vm.prank(migAuth);
        pad.migrateLiquidity(token);
        assertGt(MockV2Pair(pool).balanceOf(migrator.BURN_ADDRESS()), 0);
    }

    /* ------------------------------------------------------ the burn on exit */

    /// @notice An oracle-triggered graduation leaves unsold tokens on the
    /// curve. They are burned rather than folded into the pool: adding them
    /// would open the pool below the curve's closing price, which the whole
    /// parameter choice exists to prevent.
    function test_OracleGraduationBurnsTheUnsoldAllocation() public {
        vm.prank(creator);
        address token = pad.createToken("Coin", "BURNU", "u", 1_000_000_000, address(base), 250, false);

        // Buy most of the way up, then let the oracle re-price the base so the
        // $69K threshold is met while tokens remain unsold.
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(trader);
            pad.buy(token, 2_000 * ONE, 0);
        }
        uint256 unsold = pad.coinInfo(token).realToken;
        assertGt(unsold, 0, "tokens remain on the curve");
        uint256 supplyBefore = StonkzToken(token).totalSupply();

        (uint256 mcapBase,) = pad.marketCap(token);
        // Price the base high enough that the mcap clears $69,000.
        uint256 needed =
            (69_000_000_000 * 10 ** BASE_DECIMALS) / mcapBase + 1;
        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), needed, 0);

        pad.graduate(token);

        assertEq(pad.coinInfo(token).graduationReason, 1, "graduated on price");
        assertEq(pad.coinInfo(token).realToken, 0, "the curve is empty");
        assertEq(
            StonkzToken(token).totalSupply(),
            supplyBefore - unsold,
            "the unsold allocation is destroyed, not banked"
        );
    }

    function test_OnlyTheLaunchpadCanBurn() public {
        vm.prank(creator);
        address token = pad.createToken("Coin", "NOBURN", "u", 1_000_000_000, address(base), 250, false);
        vm.prank(sniper);
        vm.expectRevert(bytes("only launchpad"));
        StonkzToken(token).burn(1);
    }
}
