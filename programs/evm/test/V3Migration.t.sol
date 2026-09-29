// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";

import {CurveMath} from "../src/CurveMath.sol";
import {FeeLocker, ILaunchpadMigrator} from "../src/FeeLocker.sol";
import {StonkzLaunchpad, IGraduationMigrator} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {UniswapV3Migrator} from "../src/UniswapV3Migrator.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {FullMath} from "../src/oracle/uniswap/FullMath.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../src/oracle/uniswap/IUniswapV3.sol";
import {LiquidityAmounts} from "../src/oracle/uniswap/LiquidityAmounts.sol";
import {TickMath} from "../src/oracle/uniswap/TickMath.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {V3Fixture, V3TestSwapper, V3TestSeeder} from "./mocks/V3Fixture.sol";

/// @notice Graduation into a Uniswap v3 position held by `FeeLocker`, and the
/// fees that position earns flowing back into the launchpad's ledgers.
///
/// The pools are Uniswap's own bytecode (`V3Fixture`), not a mock: the
/// arithmetic under test — what a mint charges, what a swap moves, what
/// `collect` pays — is the arithmetic the live pools run.
contract V3MigrationTest is Test {
    uint24 constant FEE = 10_000;
    uint256 constant Q96 = 1 << 96;

    /// Two base assets, one on each side of every token address, so both
    /// `token0`/`token1` orderings are exercised.
    address constant LOW = address(0x1000);
    address constant HIGH = address(0xFFFfFFfFfFFffFFfFFFffffFfFfFffFFfFFFFF00);

    StonkzLaunchpad pad;
    PushPriceSource oracle;
    IUniswapV3Factory factory;
    FeeLocker locker;
    UniswapV3Migrator migrator;
    V3TestSwapper swapper;
    V3TestSeeder seeder;
    MockERC20 usdg; // 6 decimals, at LOW
    MockERC20 weth; // 18 decimals, at HIGH

    address admin = address(0xA11CE);
    address oracleAuth = address(0x0AC1E);
    address migAuth = address(0x11165);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address staker = address(0x57A6E7);
    address anyone = address(0xA0);

    function setUp() public {
        vm.warp(1_800_000_000);
        deployCodeTo("Mocks.sol:MockERC20", abi.encode("Global Dollar", "USDG", uint8(6)), LOW);
        deployCodeTo("Mocks.sol:MockERC20", abi.encode("Wrapped Ether", "WETH", uint8(18)), HIGH);
        usdg = MockERC20(LOW);
        weth = MockERC20(HIGH);

        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, admin, admin, oracle, migAuth);
        factory = V3Fixture.deploy();
        locker = new FeeLocker(ILaunchpadMigrator(address(pad)));
        migrator = new UniswapV3Migrator(factory, address(pad), locker, FEE);
        swapper = new V3TestSwapper();
        seeder = new V3TestSeeder();

        vm.prank(admin);
        pad.setMigrator(IGraduationMigrator(address(migrator)), migAuth);
        vm.startPrank(oracleAuth);
        oracle.pushPrice(LOW, 1_000_000, 0);
        oracle.pushPrice(HIGH, 3_000_000_000, 0);
        vm.stopPrank();

        for (uint256 i = 0; i < 2; i++) {
            MockERC20 b = i == 0 ? usdg : weth;
            b.mint(trader, 100_000_000 * 10 ** b.decimals());
            b.mint(address(swapper), 100_000_000 * 10 ** b.decimals());
            b.mint(address(seeder), 100_000_000 * 10 ** b.decimals());
        }
        vm.startPrank(trader);
        usdg.approve(address(pad), type(uint256).max);
        weth.approve(address(pad), type(uint256).max);
        vm.stopPrank();
    }

    /* ------------------------------------------------------------- helpers */

    struct Snap {
        address token;
        MockERC20 base;
        uint256 T; // tokens migrated (lpReserve)
        uint256 B; // base migrated (realBase)
        uint256 padBase;
        bool tokenIs0;
    }

    function _graduated(MockERC20 base, string memory ticker) internal returns (Snap memory s) {
        vm.prank(creator);
        s.token = pad.createToken("Coin", ticker, "u", 1_000_000_000, address(base), 250, false);
        uint256 step = 2_000 * 10 ** base.decimals();
        if (address(base) == HIGH) step = 3 ether;
        for (uint256 i = 0; i < 60 && pad.coinInfo(s.token).realToken > 0; i++) {
            vm.prank(trader);
            pad.buy(s.token, step, 0);
        }
        assertEq(pad.coinInfo(s.token).realToken, 0, "curve exhausted");
        pad.graduate(s.token);
        s.base = base;
        s.T = pad.coinInfo(s.token).lpReserve;
        s.B = pad.coinInfo(s.token).realBase;
        s.padBase = base.balanceOf(address(pad));
        s.tokenIs0 = s.token < address(base);
    }

    function _migrate(Snap memory s) internal returns (address pool, uint256 liq) {
        vm.recordLogs();
        vm.prank(migAuth);
        pad.migrateLiquidity(s.token);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("LiquidityMigrated(address,address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(pad) && logs[i].topics[0] == sig) {
                (pool, liq) = abi.decode(logs[i].data, (address, uint256));
            }
        }
        assertTrue(pool != address(0), "LiquidityMigrated emitted");
        assertEq(pad.coinInfo(s.token).realBase, 0, "raise released");
        assertEq(pad.coinInfo(s.token).lpReserve, 0, "escrow released");
    }

    function _poolOf(Snap memory s) internal view returns (IUniswapV3Pool) {
        return IUniswapV3Pool(factory.getPool(s.token, address(s.base), FEE));
    }

    /// Relative distance, in bps, between the pool's price and `B / T`.
    function _offPriceBps(Snap memory s) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = _poolOf(s).slot0();
        uint256 priceX96 = FullMath.mulDiv(sqrtP, sqrtP, Q96); // token1 per token0
        (uint256 a0, uint256 a1) = s.tokenIs0 ? (s.T, s.B) : (s.B, s.T);
        uint256 wantX96 = FullMath.mulDiv(a1, Q96, a0);
        uint256 diff = priceX96 > wantX96 ? priceX96 - wantX96 : wantX96 - priceX96;
        return (diff * 10_000) / wantX96;
    }

    function _lockerLiquidity(Snap memory s) internal view returns (uint128 liq) {
        (liq,,,,) = _poolOf(s)
            .positions(
                keccak256(abi.encodePacked(address(locker), migrator.tickLower(), migrator.tickUpper()))
            );
    }

    /// Every unit of the raise is in the pool or escrowed back; every unit of
    /// the escrowed tokens is in the pool or burned; nothing stays anywhere else.
    function _assertAccounted(Snap memory s, uint256 outsideBaseIn, uint256 outsideTokensIn) internal view {
        address pool = address(_poolOf(s));
        uint256 returned = s.base.balanceOf(address(pad)) - (s.padBase - s.B);
        assertEq(
            s.base.balanceOf(pool) + returned,
            s.B + outsideBaseIn,
            "every unit of base is in the pool or escrowed"
        );
        StonkzToken tok = StonkzToken(s.token);
        assertEq(
            tok.balanceOf(pool) + tok.balanceOf(migrator.BURN_ADDRESS()),
            s.T + outsideTokensIn,
            "every escrowed token is in the pool or burned"
        );
        assertEq(s.base.balanceOf(address(migrator)), 0, "the migrator keeps no base");
        assertEq(tok.balanceOf(address(migrator)), 0, "the migrator keeps no tokens");
        assertEq(s.base.balanceOf(address(locker)), 0, "the locker keeps no base");
        assertEq(tok.balanceOf(address(locker)), 0, "the locker keeps no tokens");
    }

    /* --------------------------------------------------------- the happy path */

    function test_MigratesIntoAFullRangePositionOwnedByTheLocker_BaseIsToken1() public {
        _checkCleanMigration(usdg, "V3A");
    }

    function test_MigratesIntoAFullRangePositionOwnedByTheLocker_BaseIsToken0() public {
        _checkCleanMigration(weth, "V3B");
    }

    function _checkCleanMigration(MockERC20 base, string memory ticker) internal {
        Snap memory s = _graduated(base, ticker);
        (address pool, uint256 liq) = _migrate(s);
        IUniswapV3Pool p = IUniswapV3Pool(pool);

        assertEq(pool, factory.getPool(s.token, address(base), FEE), "the 1% pool");
        assertEq(p.fee(), FEE);
        assertLe(_offPriceBps(s), 1, "pool opens at the curve's closing price");
        assertGt(liq, 0);
        assertEq(
            uint256(_lockerLiquidity(s)), liq, "the position is the locker's, for the reported liquidity"
        );
        assertEq(p.liquidity(), uint128(liq), "and it is the pool's only liquidity");

        // All of both sides are in the pool, bar dust: a "full range" v3
        // position spans [tick -887200, 887200], not (0, inf), so its ratio
        // differs from the exact price by ~1e-16 and the mint cannot place
        // a few wei of one side. That dust is burned / escrowed, never kept.
        assertApproxEqRel(base.balanceOf(pool), s.B, 1e6, "the raise is in the pool (to 1e-12)");
        assertApproxEqRel(StonkzToken(s.token).balanceOf(pool), s.T, 1e6, "so is the escrowed 20%");
        _assertAccounted(s, 0, 0);

        FeeLocker.Lock memory l = locker.lockOf(s.token);
        assertEq(l.pool, pool);
        assertEq(l.baseToken, address(base));
        assertEq(l.tickLower, -887_200);
        assertEq(l.tickUpper, 887_200);
        assertEq(l.tokenIs0, s.tokenIs0);
        assertEq(uint256(l.liquidity), liq);
    }

    function test_ASecondMigrationIsRefusedEverywhere() public {
        Snap memory s = _graduated(usdg, "TWICE");
        (address pool, uint256 liq) = _migrate(s);

        vm.prank(migAuth);
        vm.expectRevert(bytes("nothing"));
        pad.migrateLiquidity(s.token);

        vm.prank(address(migrator));
        vm.expectRevert(bytes("registered"));
        locker.register(s.token, address(usdg), pool, -887_200, 887_200, uint128(liq));
    }

    function test_FeeTierIsAConstructorChoice() public {
        UniswapV3Migrator m = new UniswapV3Migrator(factory, address(pad), locker, 3000);
        assertEq(m.tickSpacing(), 60);
        assertEq(m.tickLower(), -887_220);
        assertEq(m.tickUpper(), 887_220);
        vm.expectRevert(bytes("fee tier"));
        new UniswapV3Migrator(factory, address(pad), locker, 1234);
    }

    /* ------------------------------------------------------------- the fees */

    struct Ledger {
        uint256 protocol;
        uint256 ops;
        uint256 burn;
        uint256 bucketBase;
        uint256 bucketToken;
        uint256 creatorBase;
        uint256 creatorToken;
        uint256 protocolAccrued;
        uint256 creatorBucketAccrued;
        uint256 stakerBase;
        uint256 stakerToken;
        uint256 dead;
    }

    function _ledger(Snap memory s) internal view returns (Ledger memory l) {
        StonkzLaunchpad.Coin memory c = pad.coinInfo(s.token);
        l.protocol = pad.protocolRevenue(address(s.base));
        l.ops = pad.stonkzOps(address(s.base));
        l.burn = pad.stonkzBurn(address(s.base));
        l.bucketBase = c.bucketBase;
        l.bucketToken = c.bucketToken;
        l.creatorBase = c.creatorClaimableBase;
        l.creatorToken = c.creatorClaimableToken;
        l.protocolAccrued = c.protocolAccrued;
        l.creatorBucketAccrued = c.creatorBucketAccrued;
        l.stakerBase = c.stakerAccruedBase;
        l.stakerToken = c.stakerAccruedToken;
        l.dead = StonkzToken(s.token).balanceOf(locker.BURN_ADDRESS());
    }

    /// Trade both ways in the pool so both sides earn fees.
    function _churn(Snap memory s) internal {
        address pool = address(_poolOf(s));
        // Buy tokens with base, then sell some back.
        swapper.swapExactIn(pool, !s.tokenIs0, s.B / 5);
        uint256 got = StonkzToken(s.token).balanceOf(address(swapper));
        swapper.swapExactIn(pool, s.tokenIs0, got / 2);
    }

    function test_PoolFeesAreSplitExactlyLikeCurveFees() public {
        Snap memory s = _graduated(usdg, "FEES");
        // A locked staker, so the bucket peels.
        vm.prank(trader);
        StonkzToken(s.token).transfer(staker, 5_000_000e18);
        vm.startPrank(staker);
        StonkzToken(s.token).approve(address(pad), type(uint256).max);
        pad.stake(s.token, 5_000_000e18, 30);
        vm.stopPrank();

        _migrate(s);
        _churn(s);

        (uint256 pendingBase, uint256 pendingTokens) = locker.pendingFees(s.token);
        assertGt(pendingBase, 0, "base fees accrued");
        assertGt(pendingTokens, 0, "token fees accrued");

        Ledger memory before = _ledger(s);
        vm.recordLogs();
        vm.prank(anyone);
        (uint256 baseAmt, uint256 tokenAmt) = locker.claimFees(s.token);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(baseAmt, pendingBase, "pendingFees predicted the base side");
        assertEq(tokenAmt, pendingTokens, "pendingFees predicted the token side");
        Ledger memory after_ = _ledger(s);

        // Base side: the curve's own integer split, into the same ledgers.
        CurveMath.FeeShares memory sb = CurveMath.splitFee(baseAmt);
        assertEq(after_.protocol - before.protocol, sb.protocol, "15% protocol");
        assertEq(after_.ops - before.ops, sb.stonkzOps, "10% buyback");
        assertEq(after_.burn - before.burn, sb.burn, "6% RWA");
        assertEq(after_.bucketBase - before.bucketBase, sb.creatorBucket, "69% bucket");
        assertEq(after_.protocolAccrued - before.protocolAccrued, sb.protocol);
        assertEq(after_.creatorBucketAccrued - before.creatorBucketAccrued, sb.creatorBucket);
        // ...with the staker peel the curve would apply.
        StonkzLaunchpad.Coin memory c = pad.coinInfo(s.token);
        uint256 circ = CurveMath.circulating(c.tokensForSale, c.realToken);
        (uint256 toCreatorB, uint256 toStakersB) =
            CurveMath.splitCreatorBucket(sb.creatorBucket, c.eligibleStaked, circ);
        assertGt(toStakersB, 0, "stakers got a peel");
        assertEq(after_.creatorBase - before.creatorBase, toCreatorB, "creator base");
        assertEq(after_.stakerBase - before.stakerBase, toStakersB, "staker base");

        // Token side: 69% to the bucket (creator + stakers), 31% burned.
        uint256 toBucket = CurveMath.splitFee(tokenAmt).creatorBucket;
        assertEq(
            after_.dead - before.dead, tokenAmt - toBucket, "the treasury legs of the token side are burned"
        );
        assertEq(after_.bucketToken - before.bucketToken, toBucket);
        (uint256 toCreatorT, uint256 toStakersT) =
            CurveMath.splitCreatorBucket(toBucket, c.eligibleStaked, circ);
        assertEq(after_.creatorToken - before.creatorToken, toCreatorT, "creator tokens");
        assertEq(after_.stakerToken - before.stakerToken, toStakersT, "staker tokens");

        // The events the indexer reads: FeeAccrued with the split, then the
        // token side and peel on PoolFeesAccrued, and the locker's own.
        _assertFeeEvents(logs, s, baseAmt, sb, toBucket, toStakersB, toStakersT, tokenAmt);

        // Nothing is left anywhere it should not be.
        assertEq(usdg.balanceOf(address(locker)), 0);
        assertEq(usdg.balanceOf(address(migrator)), 0);
        assertEq(StonkzToken(s.token).balanceOf(address(locker)), 0);
        assertEq(StonkzToken(s.token).balanceOf(address(migrator)), 0);
        // The position is untouched.
        assertEq(uint256(_lockerLiquidity(s)), uint256(locker.lockOf(s.token).liquidity), "principal intact");

        // And the money is claimable by the people it was credited to.
        uint256 cb = usdg.balanceOf(creator);
        uint256 ct = StonkzToken(s.token).balanceOf(creator);
        vm.prank(creator);
        pad.claimCreatorFees(s.token);
        assertEq(usdg.balanceOf(creator) - cb, after_.creatorBase, "creator claimed base");
        assertEq(StonkzToken(s.token).balanceOf(creator) - ct, after_.creatorToken, "creator claimed tokens");

        (uint256 pb, uint256 pt) = pad.pendingStakeRewards(s.token, staker);
        // The accumulator keeps its integer remainder as pool dust, so the
        // one staker is owed the peel to within a wei.
        assertApproxEqAbs(pb, toStakersB, 1, "the one staker is owed the whole peel");
        assertApproxEqAbs(pt, toStakersT, 1);
        uint256 sb0 = usdg.balanceOf(staker);
        vm.prank(staker);
        pad.claimStake(s.token);
        assertEq(usdg.balanceOf(staker) - sb0, pb, "staker claimed");
    }

    function _assertFeeEvents(
        Vm.Log[] memory logs,
        Snap memory s,
        uint256 baseAmt,
        CurveMath.FeeShares memory sb,
        uint256 toBucket,
        uint256 stakersB,
        uint256 stakersT,
        uint256 tokenAmt
    ) internal view {
        bool sawFee;
        bool sawPool;
        bool sawCollected;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (
                l.topics[0]
                    == keccak256("FeeAccrued(address,address,uint256,uint256,uint256,uint256,uint256)")
            ) {
                assertEq(l.emitter, address(pad));
                assertEq(address(uint160(uint256(l.topics[1]))), s.token);
                (uint256 total, uint256 p, uint256 o, uint256 b, uint256 cb) =
                    abi.decode(l.data, (uint256, uint256, uint256, uint256, uint256));
                assertEq(total, baseAmt);
                assertEq(p, sb.protocol);
                assertEq(o, sb.stonkzOps);
                assertEq(b, sb.burn);
                assertEq(cb, sb.creatorBucket);
                sawFee = true;
            } else if (l.topics[0] == keccak256("PoolFeesAccrued(address,uint256,uint256,uint256,uint256)")) {
                assertEq(l.emitter, address(pad));
                (uint256 ba, uint256 ta, uint256 stb, uint256 stt) =
                    abi.decode(l.data, (uint256, uint256, uint256, uint256));
                assertEq(ba, baseAmt);
                assertEq(ta, toBucket);
                assertEq(stb, stakersB);
                assertEq(stt, stakersT);
                sawPool = true;
            } else if (
                l.topics[0] == keccak256("FeesCollected(address,address,uint256,uint256,uint256,uint256)")
            ) {
                assertEq(l.emitter, address(locker));
                (uint256 ba, uint256 ta, uint256 burned, uint256 bucket) =
                    abi.decode(l.data, (uint256, uint256, uint256, uint256));
                assertEq(ba, baseAmt);
                assertEq(ta, tokenAmt);
                assertEq(burned, tokenAmt - toBucket);
                assertEq(bucket, toBucket);
                sawCollected = true;
            }
        }
        assertTrue(sawFee && sawPool && sawCollected, "all three fee events");
    }

    function test_ClaimFeesIsPermissionlessAndIdempotent() public {
        Snap memory s = _graduated(weth, "PERM");
        _migrate(s);
        vm.prank(anyone);
        vm.expectRevert(bytes("nothing"));
        locker.claimFees(s.token);

        _churn(s);
        vm.prank(anyone);
        (uint256 b1,) = locker.claimFees(s.token);
        assertGt(b1, 0);
        (uint256 pb, uint256 pt) = locker.pendingFees(s.token);
        assertEq(pb + pt, 0, "nothing pending right after a claim");
        vm.prank(anyone);
        vm.expectRevert(bytes("nothing"));
        locker.claimFees(s.token);

        // More trading, another claim, from someone else.
        _churn(s);
        vm.prank(trader);
        (uint256 b2,) = locker.claimFees(s.token);
        assertGt(b2, 0);
    }

    function test_FeesKeepFlowingAcrossManyClaims() public {
        Snap memory s = _graduated(usdg, "MANY");
        _migrate(s);
        Ledger memory before = _ledger(s);
        uint256 total;
        for (uint256 i = 0; i < 5; i++) {
            _churn(s);
            (uint256 b,) = locker.claimFees(s.token);
            total += b;
        }
        Ledger memory after_ = _ledger(s);
        CurveMath.FeeShares memory sb = CurveMath.splitFee(total);
        // Across claims the sum of per-claim integer splits can trail the
        // split of the sum by at most one wei per claim per floored leg; the
        // bucket is the remainder, so it absorbs the other three legs' wei.
        assertApproxEqAbs(after_.protocol - before.protocol, sb.protocol, 5);
        assertApproxEqAbs(after_.ops - before.ops, sb.stonkzOps, 5);
        assertApproxEqAbs(after_.burn - before.burn, sb.burn, 5);
        assertApproxEqAbs(after_.creatorBase - before.creatorBase, sb.creatorBucket, 15);
    }

    function test_AnUnregisteredTokenHasNoFees() public {
        vm.expectRevert(bytes("not locked"));
        locker.claimFees(address(0xBAD));
        (uint256 b, uint256 t) = locker.pendingFees(address(0xBAD));
        assertEq(b + t, 0);
    }

    /* ------------------------------------------------------- the principal */

    /// @notice There is no function on the locker, for any caller, that moves
    /// liquidity out of the pool. `claimFees` pokes with `burn(…, 0)` only.
    function test_TheLockerCannotWithdrawPrincipal() public {
        Snap memory s = _graduated(usdg, "NOEXIT");
        (address pool, uint256 liq) = _migrate(s);
        _churn(s);
        locker.claimFees(s.token);

        string[7] memory sigs = [
            "withdraw(address,uint256)",
            "withdraw(address)",
            "burn(address,uint128)",
            "removeLiquidity(address)",
            "sweep(address,address,uint256)",
            "execute(address,bytes)",
            "collect(address)"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(locker).call(abi.encodeWithSignature(sigs[i], s.token, uint256(1)));
            assertFalse(ok, "the locker must expose no exit");
        }
        assertEq(uint256(_lockerLiquidity(s)), liq, "liquidity unchanged after claims");
        assertEq(IUniswapV3Pool(pool).liquidity(), uint128(liq));

        // Nobody else owns that position key either: a stranger's burn on
        // the same range is a burn of their own (empty) position.
        vm.prank(anyone);
        vm.expectRevert();
        IUniswapV3Pool(pool).burn(-887_200, 887_200, 1);
        vm.prank(anyone);
        (uint128 c0, uint128 c1) =
            IUniswapV3Pool(pool).collect(anyone, -887_200, 887_200, type(uint128).max, type(uint128).max);
        assertEq(uint256(c0) + c1, 0, "a stranger collects nothing");
        assertEq(uint256(_lockerLiquidity(s)), liq);
    }

    /* --------------------------------------------------------------- auth */

    function test_OnlyTheLaunchpadCanMigrate() public {
        vm.prank(anyone);
        vm.expectRevert(bytes("only launchpad"));
        migrator.migrate(LOW, HIGH, 1, 1);
    }

    function test_OnlyTheMigratorCanRegister() public {
        vm.prank(anyone);
        vm.expectRevert(bytes("not migrator"));
        locker.register(LOW, HIGH, address(1), -887_200, 887_200, 1);
    }

    function test_OnlyTheLockerCanRouteFees() public {
        vm.prank(anyone);
        vm.expectRevert(bytes("not locker"));
        migrator.accrueFees(LOW, HIGH, 1, 0);
    }

    function test_OnlyTheMigratorCanAccrueExternalFees() public {
        Snap memory s = _graduated(usdg, "GATE");
        vm.prank(anyone);
        vm.expectRevert(bytes("not migrator"));
        pad.accrueExternalFees(s.token, 1, 0);
        vm.prank(address(locker));
        vm.expectRevert(bytes("not migrator"));
        pad.accrueExternalFees(s.token, 1, 0);
        // Even the migrator cannot accrue for a token the launchpad never made.
        vm.prank(address(migrator));
        vm.expectRevert(bytes("unknown token"));
        pad.accrueExternalFees(address(0xBAD), 1, 0);
        vm.prank(address(migrator));
        vm.expectRevert(bytes("nothing"));
        pad.accrueExternalFees(s.token, 0, 0);
    }

    /// @notice The mint/swap callbacks pay out of the migrator's balance, so
    /// only the pool the migrator is mid-call with may trigger them — never
    /// a stranger, and nobody at all between calls.
    function test_OnlyThePoolMayCallTheCallbacksAndOnlyMidCall() public {
        Snap memory s = _graduated(usdg, "CB");
        address pool = factory.createPool(s.token, LOW, FEE);
        usdg.mint(address(migrator), 1e6);

        vm.prank(anyone);
        vm.expectRevert(bytes("pool"));
        migrator.uniswapV3MintCallback(0, 1e6, "");
        vm.prank(anyone);
        vm.expectRevert(bytes("pool"));
        migrator.uniswapV3SwapCallback(0, 1e6, "");
        // The genuine pool, but at rest: still refused.
        vm.prank(pool);
        vm.expectRevert(bytes("pool"));
        migrator.uniswapV3MintCallback(0, 1e6, "");
        vm.prank(pool);
        vm.expectRevert(bytes("pool"));
        migrator.uniswapV3SwapCallback(0, 1e6, "");
        assertEq(usdg.balanceOf(address(migrator)), 1e6, "nothing moved");
    }

    /* ------------------------------------------------- pre-initialised pools */

    /// Someone created and initialised the pool far from the curve price, with
    /// no liquidity: the migrator walks it to the price for free.
    function test_AnEmptyPoolInitialisedOffPriceIsWalkedToThePrice() public {
        Snap memory s = _graduated(usdg, "WALKUP");
        address pool = factory.createPool(s.token, LOW, FEE);
        seeder.initialize(pool, TickMath.getSqrtRatioAtTick(-500_000));
        _migrate(s);
        assertLe(_offPriceBps(s), 1, "opened at the curve price");
        _assertAccounted(s, 0, 0);

        Snap memory d = _graduated(usdg, "WALKDN");
        pool = factory.createPool(d.token, LOW, FEE);
        seeder.initialize(pool, TickMath.getSqrtRatioAtTick(400_000));
        _migrate(d);
        assertLe(_offPriceBps(d), 1, "opened at the curve price");
        _assertAccounted(d, 0, 0);
    }

    /// A pre-created, uninitialised pool is simply ours to initialise.
    function test_MigratesIntoAPreCreatedUninitialisedPool() public {
        Snap memory s = _graduated(weth, "EMPTY");
        factory.createPool(s.token, HIGH, FEE);
        (, uint256 liq) = _migrate(s);
        assertGt(liq, 0);
        assertLe(_offPriceBps(s), 1);
        _assertAccounted(s, 0, 0);
    }

    /// The seeder puts real full-range liquidity in at a price of their
    /// choosing. Returns what they put in, valued at the curve price.
    struct Seed {
        address pool;
        uint256 value; // what went in, at the curve price
        uint256 tokensIn; // what the mint actually charged
        uint256 baseIn;
    }

    function _seedFullRange(Snap memory s, uint256 tokens, uint256 baseAmt, int24 atTick)
        internal
        returns (Seed memory d)
    {
        address pool;
        pool = factory.getPool(s.token, address(s.base), FEE);
        if (pool == address(0)) pool = factory.createPool(s.token, address(s.base), FEE);
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(atTick);
        seeder.initialize(pool, sqrtP);
        vm.prank(trader);
        StonkzToken(s.token).transfer(address(seeder), tokens);
        (uint256 a0, uint256 a1) = s.tokenIs0 ? (tokens, baseAmt) : (baseAmt, tokens);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtRatioAtTick(-887_200), TickMath.getSqrtRatioAtTick(887_200), a0, a1
        );
        (uint256 p0, uint256 p1) = seeder.mint(pool, -887_200, 887_200, liq);
        (uint256 pt, uint256 pb) = s.tokenIs0 ? (p0, p1) : (p1, p0);
        d = Seed(pool, pt * s.B / s.T + pb, pt, pb);
    }

    /// The seeder unwinds after migration; their proceeds at the curve price.
    function _seederValue(Snap memory s, address pool) internal returns (uint256) {
        (uint256 g0, uint256 g1) = seeder.unwind(pool, -887_200, 887_200);
        (uint256 gt, uint256 gb) = s.tokenIs0 ? (g0, g1) : (g1, g0);
        return gt * s.B / s.T + gb;
    }

    /// The tick of the curve price, so seeds can be placed relative to it.
    function _curveTick(Snap memory s) internal view returns (int24) {
        (uint256 a0, uint256 a1) = s.tokenIs0 ? (s.T, s.B) : (s.B, s.T);
        return TickMath.getTickAtSqrtRatio(migrator.sqrtPriceX96For(a0, a1));
    }

    function test_CorrectsAPoolSeededAboveTheCurvePrice() public {
        Snap memory s = _graduated(usdg, "ABOVE");
        // ~50x the price (tick +39000 ≈ e^3.9): base-rich relative to tokens.
        int24 at = _curveTick(s) + (s.tokenIs0 ? int24(39_000) : -int24(39_000));
        Seed memory d = _seedFullRange(s, s.T / 1000, s.B / 20, at);
        _migrate(s);
        assertLe(_offPriceBps(s), 1, "pool opens at the curve price");
        _assertAccounted(s, d.baseIn, d.tokensIn);
        assertLe(_seederValue(s, d.pool), d.value + s.B / 100, "the seeder cannot come out ahead");
    }

    function test_CorrectsAPoolSeededBelowTheCurvePrice() public {
        Snap memory s = _graduated(usdg, "BELOW");
        int24 at = _curveTick(s) - (s.tokenIs0 ? int24(39_000) : -int24(39_000));
        Seed memory d = _seedFullRange(s, s.T / 10, s.B / 10_000, at);
        uint256 deadBefore = StonkzToken(s.token).balanceOf(migrator.BURN_ADDRESS());
        _migrate(s);
        assertLe(_offPriceBps(s), 1, "pool opens at the curve price");
        _assertAccounted(s, d.baseIn, d.tokensIn);
        assertLe(_seederValue(s, d.pool), d.value + s.B / 100, "the seeder cannot come out ahead");
        assertGt(
            StonkzToken(s.token).balanceOf(migrator.BURN_ADDRESS()),
            deadBefore,
            "tokens bought back below the price are burned"
        );
    }

    /// Deeper than half the migrating side can correct: the migration still
    /// completes, at the best price the cap could reach, and the seeder still
    /// does not profit.
    function test_ADeepSeederIsCappedNotObeyed() public {
        Snap memory s = _graduated(usdg, "DEEP");
        usdg.mint(address(seeder), s.B * 100);
        int24 at = _curveTick(s) + (s.tokenIs0 ? int24(46_000) : -int24(46_000)); // ~100x
        Seed memory d = _seedFullRange(s, s.T / 2, s.B * 50, at);
        (, uint256 liq) = _migrate(s);
        assertGt(liq, 0, "graduated");
        _assertAccounted(s, d.baseIn, d.tokensIn);
        assertLe(_seederValue(s, d.pool), d.value + s.B / 100, "the seeder cannot come out ahead");
    }

    function test_ADeepCheapSeederIsCappedNotObeyed() public {
        Snap memory s = _graduated(weth, "DEEPLO");
        uint256 tokens = StonkzToken(s.token).balanceOf(trader) / 2;
        int24 at = _curveTick(s) - (s.tokenIs0 ? int24(46_000) : -int24(46_000));
        Seed memory d = _seedFullRange(s, tokens, s.B / 1000, at);
        (, uint256 liq) = _migrate(s);
        assertGt(liq, 0, "graduated");
        _assertAccounted(s, d.baseIn, d.tokensIn);
        assertLe(_seederValue(s, d.pool), d.value + s.B / 100, "the seeder cannot come out ahead");
    }

    /// Any full-range seed, either side, any depth: graduation completes, the
    /// seeder never ends up ahead beyond the pool fee on the corrective swap,
    /// and the raise is all in the pool or escrowed.
    function testFuzz_NoSeedBlocksOrProfits(uint256 seedT, uint256 seedB, int24 skew) public {
        Snap memory s = _graduated(usdg, "FUZZ");
        seedT = bound(seedT, 1e18, s.T * 2);
        seedB = bound(seedB, 1e6, s.B * 20);
        skew = int24(bound(int256(skew), -60_000, 60_000));
        usdg.mint(address(seeder), seedB);
        int24 at = _curveTick(s) + skew;
        Seed memory d = _seedFullRange(s, seedT, seedB, at);
        (, uint256 liq) = _migrate(s);
        assertGt(liq, 0, "graduated");
        _assertAccounted(s, d.baseIn, d.tokensIn);
        assertLe(_seederValue(s, d.pool), d.value + s.B / 100 + 1, "the seeder cannot come out ahead");
    }

    /// A seed at exactly the curve price is deposited alongside, untouched.
    function test_MigratesIntoAPoolAlreadyAtTheCurvePrice() public {
        Snap memory s = _graduated(usdg, "SAME");
        Seed memory d = _seedFullRange(s, s.T / 1000, s.B / 1000, _curveTick(s));
        vm.recordLogs();
        _migrate(s);
        assertLe(_offPriceBps(s), 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 corrected = keccak256("PoolCorrected(address,address,bool,uint256,uint256)");
        uint256 swaps;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == corrected) swaps++;
        }
        // The seed sits on the nearest tick, not the exact price, so at most
        // one tiny correction; and the seeder gains nothing from it.
        assertLe(swaps, 1);
        assertTrue(IUniswapV3Pool(d.pool).liquidity() > 0);
    }

    /* ----------------------------------------------------------- the price */

    function test_SqrtPriceIsExactAcrossMagnitudes() public view {
        // token0 = 2e26 token atoms, token1 = 13_800e6 USDG atoms.
        uint160 p = migrator.sqrtPriceX96For(2e26, 13_800e6);
        uint256 priceX96 = FullMath.mulDiv(p, p, Q96);
        assertApproxEqRel(priceX96, FullMath.mulDiv(13_800e6, Q96, 2e26), 1e12); // 1e-6 relative
        // Reversed ordering: a huge ratio.
        p = migrator.sqrtPriceX96For(13_800e6, 2e26);
        priceX96 = FullMath.mulDiv(p, p, Q96);
        assertApproxEqRel(priceX96, FullMath.mulDiv(2e26, Q96, 13_800e6), 1e12);
        // Clamped, never out of the pool's range.
        assertEq(migrator.sqrtPriceX96For(type(uint128).max, 1), TickMath.MIN_SQRT_RATIO + 1);
        assertEq(migrator.sqrtPriceX96For(1, type(uint128).max), TickMath.MAX_SQRT_RATIO - 1);
    }

    /// The launchpad's reentrancy guard is left unlocked by the new entry
    /// point, and its storage layout has not grown.
    function test_AccrueExternalFeesLeavesTheGuardAndLayoutAlone() public {
        Snap memory s = _graduated(usdg, "LOCK");
        _migrate(s);
        _churn(s);
        locker.claimFees(s.token);
        assertEq(uint256(vm.load(address(pad), bytes32(uint256(15)))), 1, "_lock back to 1");
        assertEq(uint256(vm.load(address(pad), bytes32(uint256(17)))), 0, "nothing after pauser");
        // And the curve's own ledgers still work afterwards.
        vm.startPrank(trader);
        StonkzToken(s.token).approve(address(pad), 1e18);
        pad.stake(s.token, 1e18, 0);
        vm.stopPrank();
    }
}
