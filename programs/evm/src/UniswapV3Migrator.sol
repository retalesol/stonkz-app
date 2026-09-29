// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {FeeLocker} from "./FeeLocker.sol";
import {SafeErc20} from "./SafeErc20.sol";
import {FullMath} from "./oracle/uniswap/FullMath.sol";
import {LiquidityAmounts} from "./oracle/uniswap/LiquidityAmounts.sol";
import {TickMath} from "./oracle/uniswap/TickMath.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "./oracle/uniswap/IUniswapV3.sol";

interface IERC20Approve {
    function approve(address spender, uint256 value) external returns (bool);
}

interface ILaunchpadAccrue {
    function accrueExternalFees(address token, uint256 baseAmount, uint256 tokenAmount) external;
}

/// @title Graduation into a Uniswap v3 position held by `FeeLocker`.
///
/// @notice The v2 migrator burned the LP and, with it, every fee the pool
/// would ever earn (`UniswapV2Migrator.sol`'s header explains why that was
/// the right call *for v2*). v3 separates the fee claim from the principal
/// claim: `collect` pays fees without touching liquidity. So the raise and
/// the 20% escrow become one **full-range** position owned by the immutable
/// `FeeLocker`, whose only exit is `claimFees` — the principal is as gone as
/// a burned LP token, and post-graduation trading keeps paying the curve's
/// 15/10/6/69 split into the launchpad's ledgers.
///
/// ## Opening price
///
/// The pool is initialised at the curve's closing price, `baseAmount /
/// tokenAmount`, so the first DEX trade sees exactly the price the last curve
/// trade saw — the same invariant the v2 migrator enforced.
///
/// ## A pre-initialised pool cannot block graduation
///
/// A v3 pool for `(token, base, fee)` is deterministic too, so anyone can
/// create it, initialise it at any price and even seed liquidity. The answer
/// is the v2 one, and simpler here: swap **toward** the graduation price with
/// a `sqrtPriceLimitX96` equal to it, spending at most `MAX_CORRECTION_BPS`
/// of the side being sold. The pool's own swap loop stops at the limit, so
/// every unit is bought below, or sold above, the graduation price — an
/// arbitrage against whoever mis-seeded, never for them — and an initialised
/// pool with **no** liquidity is simply walked to the price for free. Then a
/// full-range position is minted at the pool's resulting price with as much
/// of both sides as that price admits; what it does not admit is surplus.
/// Surplus tokens are burned (as `graduate` burns the unsold allocation),
/// surplus base is escrowed back on the launchpad, where no ledger can pay
/// it out. Nothing on this path reverts because of what an outsider did to
/// the pool.
///
/// The one cost an outsider can impose is gas: a pool initialised far from
/// the price with no liquidity makes the corrective swap step through empty
/// tick-bitmap words (on the order of ten million gas from one extreme of
/// the range). The migration authority pays it once; the graduation completes.
///
/// ## Fee routing
///
/// `FeeLocker.claimFees` hands collected fees to *the launchpad's current
/// migrator* (`accrueFees`), which forwards them to
/// `StonkzLaunchpad.accrueExternalFees` — the launchpad admits only its
/// `migrator`, so no new launchpad storage was needed. A later migrator that
/// reuses the same locker keeps the flow alive by implementing `accrueFees`.
contract UniswapV3Migrator {
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Most of either migrating side the price correction may spend,
    /// in basis points. Same bound, same reasoning, as the v2 migrator.
    uint256 public constant MAX_CORRECTION_BPS = 5_000;

    IUniswapV3Factory public immutable factory;
    /// @notice The launchpad that may call `migrate` and that receives fees.
    address public immutable launchpad;
    /// @notice Where every position goes and the only caller of `accrueFees`.
    FeeLocker public immutable locker;
    /// @notice Pool fee tier (1e-6 units): 10000 = 1%, 3000 = 0.3%.
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    /// @dev The pool a callback is expected from, for the duration of one
    /// `mint`/`swap`. Zero at rest, so no callback is accepted at rest.
    address private _pool;

    event Migrated(
        address indexed token,
        address indexed baseToken,
        address pool,
        uint256 tokenAmount,
        uint256 baseAmount,
        uint128 liquidity
    );
    /// @notice The pool was off the graduation price and was swapped toward
    /// it. `tokenIn` true: tokens sold for base; false: base sold for tokens.
    event PoolCorrected(
        address indexed token, address pool, bool tokenIn, uint256 amountIn, uint256 amountOut
    );
    /// @notice What the pool's price did not admit: tokens sent to
    /// `BURN_ADDRESS`, base returned to the launchpad as escrow.
    event Surplus(address indexed token, uint256 tokensBurned, uint256 baseReturned);

    constructor(IUniswapV3Factory _factory, address _launchpad, FeeLocker _locker, uint24 _fee) {
        require(address(_factory) != address(0) && _launchpad != address(0), "zero");
        require(address(_locker.launchpad()) == _launchpad, "locker launchpad");
        int24 spacing = _factory.feeAmountTickSpacing(_fee);
        require(spacing > 0, "fee tier");
        factory = _factory;
        launchpad = _launchpad;
        locker = _locker;
        fee = _fee;
        tickSpacing = spacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickLower = (TickMath.MIN_TICK / spacing) * spacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickUpper = (TickMath.MAX_TICK / spacing) * spacing;
    }

    /* ------------------------------------------------------------ migrate */

    /// @notice Create/initialise the pool at the graduation price, correct a
    /// pre-seeded one toward it, mint the full-range position to the locker.
    /// @return pool The v3 pool. @return liquidity The position's liquidity,
    /// reported by the launchpad as `LiquidityMigrated.liquidityBurned`.
    function migrate(address token, address baseToken, uint256 tokenAmount, uint256 baseAmount)
        external
        returns (address pool, uint256 liquidity)
    {
        require(msg.sender == launchpad, "only launchpad");
        require(tokenAmount > 0 && baseAmount > 0, "one-sided");

        bool tokenIs0 = token < baseToken;
        pool = factory.getPool(token, baseToken, fee);
        if (pool == address(0)) pool = factory.createPool(token, baseToken, fee);
        IUniswapV3Pool p = IUniswapV3Pool(pool);

        (uint256 a0, uint256 a1) = tokenIs0 ? (tokenAmount, baseAmount) : (baseAmount, tokenAmount);
        uint160 target = sqrtPriceX96For(a0, a1);
        (uint160 sqrtP,,,,,,) = p.slot0();
        if (sqrtP == 0) {
            p.initialize(target);
            sqrtP = target;
        }

        // What this contract holds, per pool side.
        uint256 h0 = a0;
        uint256 h1 = a1;
        if (sqrtP != target) {
            (h0, h1) = _correct(p, token, tokenIs0, a0, a1, sqrtP, target);
            (sqrtP,,,,,,) = p.slot0();
        }

        uint128 liq = _fitLiquidity(sqrtP, h0, h1);
        require(liq > 0, "no liquidity");
        _pool = pool;
        (uint256 paid0, uint256 paid1) = p.mint(address(locker), tickLower, tickUpper, liq, "");
        _pool = address(0);
        locker.register(token, baseToken, pool, tickLower, tickUpper, liq);

        (uint256 tLeft, uint256 bLeft) = tokenIs0 ? (h0 - paid0, h1 - paid1) : (h1 - paid1, h0 - paid0);
        if (tLeft > 0 || bLeft > 0) {
            if (tLeft > 0) SafeErc20.safeTransfer(token, BURN_ADDRESS, tLeft);
            if (bLeft > 0) SafeErc20.safeTransfer(baseToken, launchpad, bLeft);
            emit Surplus(token, tLeft, bLeft);
        }

        liquidity = liq;
        emit Migrated(token, baseToken, pool, tokenAmount, baseAmount, liq);
    }

    /// @dev Swap toward `target` with the pool's own price limit, spending at
    /// most `MAX_CORRECTION_BPS` of the side sold. Returns what this contract
    /// holds afterwards, per pool side.
    function _correct(
        IUniswapV3Pool p,
        address token,
        bool tokenIs0,
        uint256 a0,
        uint256 a1,
        uint160 sqrtP,
        uint160 target
    ) private returns (uint256 h0, uint256 h1) {
        // sqrtP is sqrt(token1 / token0): above the target, token0 is dear —
        // sell it (zeroForOne) down to the target; below, buy it with token1.
        bool zeroForOne = sqrtP > target;
        uint256 spend = ((zeroForOne ? a0 : a1) * MAX_CORRECTION_BPS) / 10_000;
        if (spend == 0) return (a0, a1);
        _pool = address(p);
        // `spend` is at most half a token balance, far below 2^255.
        // forge-lint: disable-next-line(unsafe-typecast)
        (int256 d0, int256 d1) = p.swap(address(this), zeroForOne, int256(spend), target, "");
        _pool = address(0);
        // Positive delta: paid by us (never more than `spend`, so never more
        // than held); negative: received. Both differences are non-negative.
        // forge-lint: disable-start(unsafe-typecast)
        h0 = uint256(int256(a0) - d0);
        h1 = uint256(int256(a1) - d1);
        uint256 amountIn = uint256(zeroForOne ? d0 : d1);
        uint256 amountOut = uint256(-(zeroForOne ? d1 : d0));
        // forge-lint: disable-end(unsafe-typecast)
        if (amountIn > 0 || amountOut > 0) {
            emit PoolCorrected(token, address(p), zeroForOne == tokenIs0, amountIn, amountOut);
        }
    }

    /// @dev The most liquidity `(h0, h1)` pays for at `sqrtP`, shaved until
    /// the pool's round-up charge fits what is held (see `LiquidityAmounts`).
    function _fitLiquidity(uint160 sqrtP, uint256 h0, uint256 h1) private view returns (uint128 liq) {
        uint160 sA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sB = TickMath.getSqrtRatioAtTick(tickUpper);
        liq = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sA, sB, h0, h1);
        for (uint256 i = 0; i < 8 && liq > 0; i++) {
            (uint256 n0, uint256 n1) = LiquidityAmounts.getAmountsForLiquidityUp(sqrtP, sA, sB, liq);
            if (n0 <= h0 && n1 <= h1) return liq;
            // About one wei of the offending side, in liquidity units.
            uint256 over = n0 > h0 ? (h0 == 0 ? 1 : h0) : (h1 == 0 ? 1 : h1);
            uint256 step = uint256(liq) / over + 1;
            // `step < liq` on this branch, so it fits.
            // forge-lint: disable-next-line(unsafe-typecast)
            liq = step >= liq ? 0 : liq - uint128(step);
        }
        return 0;
    }

    /// @notice `sqrt(amount1 / amount0) * 2^96`, clamped inside the pool's
    /// admissible range.
    function sqrtPriceX96For(uint256 amount0, uint256 amount1) public pure returns (uint160) {
        require(amount0 > 0 && amount1 > 0, "one-sided");
        uint256 r;
        if (amount1 / amount0 < (1 << 63)) {
            // ratio · 2^192 fits: full precision.
            r = Math.sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0));
        } else {
            r = Math.sqrt(FullMath.mulDiv(amount1, 1 << 128, amount0)) << 32;
        }
        if (r <= TickMath.MIN_SQRT_RATIO) return TickMath.MIN_SQRT_RATIO + 1;
        if (r >= TickMath.MAX_SQRT_RATIO) return TickMath.MAX_SQRT_RATIO - 1;
        // Bounded by the two clamps above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(r);
    }

    /* ---------------------------------------------------------- callbacks */

    /// @dev Only the pool this contract is minting on, only mid-`mint`.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        IUniswapV3Pool p = _expectedPool();
        if (amount0Owed > 0) SafeErc20.safeTransfer(p.token0(), address(p), amount0Owed);
        if (amount1Owed > 0) SafeErc20.safeTransfer(p.token1(), address(p), amount1Owed);
    }

    /// @dev Only the pool this contract is swapping on, only mid-`swap`.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        IUniswapV3Pool p = _expectedPool();
        // Guarded positive, so the casts cannot truncate.
        // forge-lint: disable-start(unsafe-typecast)
        if (amount0Delta > 0) SafeErc20.safeTransfer(p.token0(), address(p), uint256(amount0Delta));
        if (amount1Delta > 0) SafeErc20.safeTransfer(p.token1(), address(p), uint256(amount1Delta));
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _expectedPool() private view returns (IUniswapV3Pool) {
        address pool = _pool;
        require(pool != address(0) && msg.sender == pool, "pool");
        return IUniswapV3Pool(pool);
    }

    /* -------------------------------------------------------- fee routing */

    /// @notice Forward fees the locker has just transferred here into the
    /// launchpad's ledgers. Locker only; the launchpad admits this contract
    /// only while it is the configured migrator.
    function accrueFees(address token, address baseToken, uint256 baseAmount, uint256 tokenAmount) external {
        require(msg.sender == address(locker), "not locker");
        if (baseAmount > 0) SafeErc20.safeApprove(baseToken, launchpad, baseAmount);
        if (tokenAmount > 0) require(IERC20Approve(token).approve(launchpad, tokenAmount), "approve");
        ILaunchpadAccrue(launchpad).accrueExternalFees(token, baseAmount, tokenAmount);
    }
}
