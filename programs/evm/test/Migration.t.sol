// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {UniswapV2Migrator, IUniswapV2Factory} from "../src/UniswapV2Migrator.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {StonkzV2Factory, StonkzV2Pair} from "../src/testnet/StonkzV2Factory.sol";
import {DeployPad} from "../script/DeployPad.sol";

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
    StonkzV2Factory factory;
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
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, admin, admin, oracle, migAuth);
        factory = new StonkzV2Factory();
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
        StonkzV2Pair pair = StonkzV2Pair(pool);

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

    // A v2 pair address is deterministic from the token pair, so anyone can
    // create and seed it ahead of the graduation transaction at a price of
    // their choosing. `mint` prices a deposit off the existing reserves and
    // silently keeps the excess of the over-supplied side for the incumbent
    // LPs — and the previous migrator's answer, reverting, turned the pair
    // into a permanent dust-cheap veto on graduation (L-1). The migrator now
    // swaps the pair back to the curve price and deposits at it. What these
    // tests pin, in every skew:
    //   1. graduation completes;
    //   2. the pool opens at the curve's graduation price;
    //   3. the seeder's LP is worth no more, at that price, than what they put
    //      in (plus at most the 0.3% fee on our corrective swap);
    //   4. every unit of the raise is either in the pool or escrowed back on
    //      the launchpad — none of it reaches the seeder.

    /// @dev The sniper gets curve tokens the honest way (from a buyer) and
    /// seeds the pair as a real LP.
    function _seed(address token, uint256 tokens, uint256 baseAmt) internal returns (StonkzV2Pair pair) {
        address pool = factory.getPair(token, address(base));
        if (pool == address(0)) pool = factory.createPair(token, address(base));
        pair = StonkzV2Pair(pool);
        if (tokens > 0) {
            vm.prank(trader);
            StonkzToken(token).transfer(sniper, tokens);
        }
        vm.startPrank(sniper);
        if (tokens > 0) StonkzToken(token).transfer(pool, tokens);
        if (baseAmt > 0) base.transfer(pool, baseAmt);
        pair.mint(sniper);
        vm.stopPrank();
    }

    function _reserves(StonkzV2Pair pair, address token) internal view returns (uint256 rt, uint256 rb) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rt, rb) = pair.token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// Relative distance, in bps, between the pair's price and `B / T`.
    function _offPriceBps(StonkzV2Pair pair, address token, uint256 T, uint256 B)
        internal
        view
        returns (uint256)
    {
        (uint256 rt, uint256 rb) = _reserves(pair, token);
        uint256 lhs = rb * T;
        uint256 rhs = B * rt;
        uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
        return (diff * 10_000) / rhs;
    }

    /// The sniper's pro-rata claim on the pair, valued at the curve price.
    function _sniperValue(StonkzV2Pair pair, address token, uint256 T, uint256 B)
        internal
        view
        returns (uint256)
    {
        (uint256 rt, uint256 rb) = _reserves(pair, token);
        uint256 lp = pair.balanceOf(sniper);
        uint256 supply = pair.totalSupply();
        return (rt * lp / supply) * B / T + rb * lp / supply;
    }

    struct Snap {
        address token;
        uint256 T;
        uint256 B;
        uint256 padBase;
    }

    function _graduatedSnap(string memory ticker) internal returns (Snap memory s) {
        s.token = _graduatedCoin(ticker);
        s.T = pad.coinInfo(s.token).lpReserve;
        s.B = pad.coinInfo(s.token).realBase;
        s.padBase = base.balanceOf(address(pad));
    }

    function _migrate(Snap memory s) internal {
        vm.prank(migAuth);
        pad.migrateLiquidity(s.token);
        assertEq(pad.coinInfo(s.token).realBase, 0, "raise released");
        assertEq(pad.coinInfo(s.token).lpReserve, 0, "escrow released");
    }

    /// Where the raise went: the pool, plus base the migrator escrowed back.
    function _assertRaiseAccounted(Snap memory s, StonkzV2Pair pair, uint256 sniperBaseIn) internal view {
        (, uint256 rb) = _reserves(pair, s.token);
        uint256 returned = base.balanceOf(address(pad)) - (s.padBase - s.B);
        assertEq(rb + returned, s.B + sniperBaseIn, "every unit of base is in the pool or escrowed");
        assertEq(base.balanceOf(address(migrator)), 0, "the migrator keeps no base");
        assertEq(StonkzToken(s.token).balanceOf(address(migrator)), 0, "the migrator keeps no tokens");
        assertEq(pair.balanceOf(address(migrator)), 0, "the migrator keeps no LP");
    }

    /// Seeded at ~1000x the curve price with real depth: the old migrator
    /// reverted forever here.
    function test_RestoresAPairSeededFarAboveTheCurvePrice() public {
        Snap memory s = _graduatedSnap("SNIPE");
        uint256 seedT = s.T / 1_000;
        uint256 seedB = s.B; // 1000x the price the curve would give seedT
        StonkzV2Pair pair = _seed(s.token, seedT, seedB);
        uint256 seedValue = seedT * s.B / s.T + seedB;

        _migrate(s);

        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1, "pool opens at the curve price");
        assertLe(_sniperValue(pair, s.token, s.T, s.B), seedValue, "the seeder cannot come out ahead");
        _assertRaiseAccounted(s, pair, seedB);
        assertGt(base.balanceOf(address(pad)), s.padBase - s.B, "the seeder's excess base is escrowed");
    }

    /// The mirror image: seeded far below the curve price, token-heavy.
    function test_RestoresAPairSeededFarBelowTheCurvePrice() public {
        Snap memory s = _graduatedSnap("CHEAP");
        uint256 seedT = s.T / 10;
        uint256 seedB = s.B / 10_000; // 1/1000 of the curve price
        StonkzV2Pair pair = _seed(s.token, seedT, seedB);
        uint256 seedValue = seedT * s.B / s.T + seedB;
        uint256 supplyBefore = StonkzToken(s.token).balanceOf(migrator.BURN_ADDRESS());

        _migrate(s);

        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1, "pool opens at the curve price");
        // The only thing the seeder can collect is the 0.3% fee on the
        // corrective swap, which is itself bounded by half the raise.
        assertLe(
            _sniperValue(pair, s.token, s.T, s.B),
            seedValue + (s.B * 3) / 1_000,
            "the seeder cannot come out ahead beyond the swap fee"
        );
        _assertRaiseAccounted(s, pair, seedB);
        assertGt(
            StonkzToken(s.token).balanceOf(migrator.BURN_ADDRESS()),
            supplyBefore,
            "the seeder's excess tokens are bought back and burned"
        );
    }

    /// Dust: the cheapest possible veto under the old migrator. A few wei on
    /// each side at an absurd price, in both directions.
    function test_DustGriefingAboveThePriceCannotBlockGraduation() public {
        Snap memory s = _graduatedSnap("DUSTUP");
        StonkzV2Pair pair = _seed(s.token, 1e6, 1e6); // 1 base-wei per token-wei
        _migrate(s);
        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1);
        assertLe(_sniperValue(pair, s.token, s.T, s.B), 1e6 * s.B / s.T + 1e6);
        assertGe(
            pair.balanceOf(migrator.BURN_ADDRESS()) * 10_000 / pair.totalSupply(), 9_999, "dead LP is ~all"
        );
        _assertRaiseAccounted(s, pair, 1e6);
    }

    function test_DustGriefingBelowThePriceCannotBlockGraduation() public {
        Snap memory s = _graduatedSnap("DUSTDN");
        StonkzV2Pair pair = _seed(s.token, 1e18, 1); // one whole token for one base-wei
        _migrate(s);
        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1);
        assertGe(pair.balanceOf(migrator.BURN_ADDRESS()) * 10_000 / pair.totalSupply(), 9_999);
        _assertRaiseAccounted(s, pair, 1);
    }

    /// A seeder deep enough that half the migrating side cannot restore the
    /// price: graduation still completes, never below the pair's corrected
    /// price, and the seeder still cannot come out ahead.
    function test_ADeepSeederIsCappedNotObeyed() public {
        Snap memory s = _graduatedSnap("DEEP");
        uint256 seedT = s.T / 2;
        uint256 seedB = s.B * 50; // 100x price, with 50x the raise behind it
        base.mint(sniper, seedB);
        StonkzV2Pair pair = _seed(s.token, seedT, seedB);
        uint256 seedValue = seedT * s.B / s.T + seedB;

        _migrate(s);

        assertGt(pair.balanceOf(migrator.BURN_ADDRESS()), 0, "graduated");
        assertLe(_sniperValue(pair, s.token, s.T, s.B), seedValue, "the seeder cannot come out ahead");
        _assertRaiseAccounted(s, pair, seedB);
    }

    /// The same, token-heavy: half the raise cannot buy the pair back up to
    /// the curve price, so the rest is deposited at the pair's price. Nothing
    /// is gifted and graduation completes.
    function test_ADeepCheapSeederIsCappedNotObeyed() public {
        Snap memory s = _graduatedSnap("DEEPLO");
        uint256 seedT = StonkzToken(s.token).balanceOf(trader) / 2;
        seedT = seedT > s.T * 3 ? s.T * 3 : seedT;
        uint256 seedB = s.B / 1_000;
        StonkzV2Pair pair = _seed(s.token, seedT, seedB);
        uint256 seedValue = seedT * s.B / s.T + seedB;

        _migrate(s);

        assertGt(pair.balanceOf(migrator.BURN_ADDRESS()), 0, "graduated");
        assertLe(
            _sniperValue(pair, s.token, s.T, s.B),
            seedValue + (s.B * 3) / 1_000,
            "the seeder cannot come out ahead beyond the swap fee"
        );
        _assertRaiseAccounted(s, pair, seedB);
    }

    /// Any seed, either side of the price, any depth: graduation completes,
    /// the seeder never ends up ahead (bar the corrective swap's fee), and the
    /// raise is all in the pool or escrowed.
    function testFuzz_NoSeedBlocksOrProfits(uint256 seedT, uint256 seedB) public {
        Snap memory s = _graduatedSnap("FUZZ");
        seedT = bound(seedT, 1e6, s.T * 2);
        seedB = bound(seedB, 1, s.B * 20);
        vm.assume(seedT * seedB > 1e8); // v2's first mint needs sqrt(a0*a1) > 1000
        base.mint(sniper, seedB);
        StonkzV2Pair pair = _seed(s.token, seedT, seedB);
        uint256 seedValue = seedT * s.B / s.T + seedB;

        _migrate(s);

        assertGt(pair.balanceOf(migrator.BURN_ADDRESS()), 0, "graduated");
        assertLe(
            _sniperValue(pair, s.token, s.T, s.B),
            seedValue + (s.B * 3) / 1_000 + 1,
            "the seeder cannot come out ahead beyond the swap fee"
        );
        _assertRaiseAccounted(s, pair, seedB);
    }

    /// Someone sent both sides and synced, but minted no LP: the reserves are
    /// ownerless. (This is the old `test_RefusesToMigrateIntoAManipulatedPool`
    /// setup, which used to revert.)
    function test_AnOwnerlessSkewedDonationIsCorrected() public {
        Snap memory s = _graduatedSnap("GIFT");
        address pool = factory.createPair(s.token, address(base));
        vm.startPrank(trader);
        StonkzToken(s.token).transfer(pool, StonkzToken(s.token).balanceOf(trader) / 100_000);
        base.transfer(pool, 500_000 * ONE);
        vm.stopPrank();
        StonkzV2Pair(pool).sync();

        _migrate(s);
        StonkzV2Pair pair = StonkzV2Pair(pool);
        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1);
        assertEq(pair.balanceOf(migrator.BURN_ADDRESS()), pair.totalSupply(), "every LP token is dead");
        _assertRaiseAccounted(s, pair, 500_000 * ONE);
    }

    /// One-sided donations into an empty pair, synced or not, cannot skew the
    /// first mint either way.
    function test_AOneSidedTokenDonationIsBurnedNotPriced() public {
        Snap memory s = _graduatedSnap("ONETOK");
        address pool = factory.createPair(s.token, address(base));
        vm.prank(trader);
        StonkzToken(s.token).transfer(pool, s.T / 2);
        StonkzV2Pair(pool).sync();

        _migrate(s);
        StonkzV2Pair pair = StonkzV2Pair(pool);
        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1);
        assertEq(pair.balanceOf(migrator.BURN_ADDRESS()), pair.totalSupply());
        _assertRaiseAccounted(s, pair, 0);
    }

    function test_AnUnsyncedOneSidedBaseDonationIsEscrowedNotPriced() public {
        Snap memory s = _graduatedSnap("ONEBAS");
        address pool = factory.createPair(s.token, address(base));
        vm.prank(sniper);
        base.transfer(pool, 1_000 * ONE); // no sync: the migrator does it

        _migrate(s);
        StonkzV2Pair pair = StonkzV2Pair(pool);
        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1);
        assertEq(pair.balanceOf(migrator.BURN_ADDRESS()), pair.totalSupply());
        _assertRaiseAccounted(s, pair, 1_000 * ONE);
    }

    /// A pair someone created but left empty is fine: we set the price.
    function test_MigratesIntoAnEmptyPreCreatedPair() public {
        Snap memory s = _graduatedSnap("EMPTY");
        address pool = factory.createPair(s.token, address(base));

        _migrate(s);
        StonkzV2Pair pair = StonkzV2Pair(pool);
        assertEq(pair.balanceOf(migrator.BURN_ADDRESS()), pair.totalSupply());
        assertEq(base.balanceOf(pool), s.B, "the whole raise, exactly");
        assertEq(StonkzToken(s.token).balanceOf(pool), s.T, "the whole escrow, exactly");
    }

    /// And a pair already sitting at our price takes the deposit untouched,
    /// which is what a retry after a partially-successful release looks like.
    function test_MigratesIntoAPairAlreadyAtTheCurvePrice() public {
        Snap memory s = _graduatedSnap("SAME");
        base.mint(sniper, s.B / 1000);
        StonkzV2Pair pair = _seed(s.token, s.T / 1000, s.B / 1000);

        vm.recordLogs();
        _migrate(s);
        assertLe(_offPriceBps(pair, s.token, s.T, s.B), 1);
        assertGt(pair.balanceOf(migrator.BURN_ADDRESS()), 0);
        // No correction was needed, so none happened.
        bytes32 corrected = keccak256("PoolCorrected(address,address,bool,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != corrected, "no correction swap");
        }
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
        uint256 needed = (69_000_000_000 * 10 ** BASE_DECIMALS) / mcapBase + 1;
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
