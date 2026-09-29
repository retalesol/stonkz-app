// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {SafeErc20} from "./SafeErc20.sol";

interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function sync() external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function token0() external view returns (address);
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @title Graduation into a Uniswap v2 pool with the LP tokens burned.
/// @notice Chosen over v3/v4 on the strength of `docs/robinhood-chain.md` §4.3:
///
/// - Nobody is promised the graduated pool's fees, so v2's inability to separate
///   the fee claim from the principal claim costs us nothing here.
/// - v2 is the only variant where "the liquidity is burned" is verifiable by a
///   user with a block explorer, trusting no Stonkz contract. For a launchpad
///   that is a product asset, not an implementation detail.
/// - Burned v2 LP autocompounds by construction: fees accrue into reserves and
///   the tokens that could withdraw them no longer exist, so the floor thickens
///   permanently with no locker, no keeper and no upgrade surface.
///
/// ## A pre-seeded pair cannot block graduation (L-1)
///
/// A v2 pair address is deterministic from the token pair, so anyone can
/// create and seed it before graduation at whatever price they like
/// (`docs/robinhood-chain.md` §4.4, point 2). `mint` prices a deposit off the
/// *existing* reserves and keeps the excess of the over-supplied side for the
/// incumbent LPs, so migrating blindly into such a pair donates part of the
/// raise to whoever seeded it. The previous migrator refused (`"pool price
/// manipulated"`) — which made the pair a permanent, dust-cheap veto on
/// graduation. This one restores the curve's closing price instead:
///
/// 1. `sync` the pair, so a direct transfer counts as reserves.
/// 2. If the reserve ratio is off the ratio being deposited (`tokenAmount :
///    baseAmount`, the curve's graduation price), **swap against the pair**
///    with part of the migrating assets until its reserves are back on that
///    price (exact, fee-inclusive v2 swap-to-ratio). The swap only
///    ever buys below / sells above the graduation price, so it is an
///    arbitrage *against* the seeder: they lose the mispricing, never gain it.
///    It is capped at `MAX_CORRECTION_BPS` of the side being spent.
/// 3. Deposit at exactly that ratio, so `mint` gifts (next to) nothing to the
///    incumbent LPs. (If the cap stopped the correction short, deposit at the
///    pair's own ratio instead, for the same reason.)
/// 4. Whatever cannot be deposited at that ratio is surplus. Surplus tokens
///    are sent to the dead address (as `graduate` burns the unsold
///    allocation — adding them would open the pool below the curve). Surplus
///    base is returned to the launchpad, where no ledger can pay it out: it
///    is escrow that only a governance upgrade can route. It is **not**
///    donated to the pair: with a deep seeder that would hand them a pro-rata
///    share of it, which is exactly the leak this contract exists to close.
///    When the correction is uncapped the surplus base equals the seeder's
///    own excess (`reserveBase - price * reserveToken`), so it is their loss,
///    not the raise.
///
/// Consequences, each pinned in `test/Migration.t.sol`: the seeder can never
/// end up with more value (at the graduation price) than they put in, bar
/// the 0.3% fee on the corrective swap; the pool opens at the graduation price
/// in either skew direction (unless the seeder is deeper than the cap can
/// correct); an empty pair and a pair already at the price migrate as before;
/// an ownerless one-sided donation is topped up to the price rather than
/// allowed to skew the first mint;
/// and nothing on this path reverts because of what an outsider did to the
/// pair, so graduation can always complete.
///
/// The `$STONKZ` protocol-owned liquidity in Phase 7 has the opposite
/// requirement (it must retain fee-collect authority) and therefore needs a v3
/// or v4 position in an immutable locker instead. That is deliberately **not**
/// implemented here — Phase 7 is out of scope and the token does not exist.
contract UniswapV2Migrator {
    /// @dev `0xdead` rather than `address(0)`: UniswapV2Pair's own `_burn`
    /// path treats the zero address specially in some forks, and a visible
    /// dead-address balance is easier for a user to verify on the explorer.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Most of either migrating side the price correction may spend,
    /// in basis points. A seeder deep enough to need more than this is running
    /// an open arbitrage against the whole market; the migration still
    /// completes, at the best price half the migrating side could restore.
    uint256 public constant MAX_CORRECTION_BPS = 5_000;

    IUniswapV2Factory public immutable factory;
    /// @notice The launchpad that may call `migrate`.
    address public immutable launchpad;

    event Migrated(
        address indexed token,
        address indexed baseToken,
        address pool,
        uint256 tokenAmount,
        uint256 baseAmount,
        uint256 liquidityBurned
    );
    /// @notice The pair was off the graduation price and was swapped back.
    /// `tokenIn` true: tokens sold for base; false: base sold for tokens.
    event PoolCorrected(
        address indexed token, address pool, bool tokenIn, uint256 amountIn, uint256 amountOut
    );
    /// @notice What could not be deposited at the pair's ratio: tokens sent to
    /// `BURN_ADDRESS`, base returned to the launchpad as escrow.
    event Surplus(address indexed token, uint256 tokensBurned, uint256 baseReturned);

    constructor(IUniswapV2Factory _factory, address _launchpad) {
        factory = _factory;
        launchpad = _launchpad;
    }

    /// @notice Create the pair if needed, restore the graduation price if the
    /// pair was pre-seeded off it, deposit, and burn every LP token minted.
    /// This contract keeps no LP, no balance and has no withdrawal path.
    /// @dev `Migrated` reports the amounts the launchpad handed over, as before;
    /// `PoolCorrected` and `Surplus` report what the correction did with them.
    function migrate(address token, address baseToken, uint256 tokenAmount, uint256 baseAmount)
        external
        returns (address pool, uint256 liquidityBurned)
    {
        require(msg.sender == launchpad, "only launchpad");
        require(tokenAmount > 0 && baseAmount > 0, "one-sided");

        pool = factory.getPair(token, baseToken);
        if (pool == address(0)) pool = factory.createPair(token, baseToken);
        IUniswapV2Pair pair = IUniswapV2Pair(pool);
        bool tokenIs0 = pair.token0() == token;

        // Direct transfers become reserves, so everything below reasons about
        // one set of numbers (and `mint` cannot count a donation as ours).
        pair.sync();

        // What this contract holds; the launchpad has already sent both sides.
        uint256 t = tokenAmount;
        uint256 b = baseAmount;
        uint256 tDep;
        uint256 bDep;
        (uint256 rt, uint256 rb) = _reserves(pair, tokenIs0);

        if (rt != 0 && rb != 0) {
            bool capped;
            (t, b, capped) = _correct(pair, token, baseToken, tokenIs0, tokenAmount, baseAmount);
            // Deposit at one exact ratio, so `mint` has (next to) no excess to
            // gift the incumbents. Normally that is the curve's own `T : B`:
            // the pair now sits on it up to integer rounding, and rounding can
            // only be material when a reserve is a few wei — i.e. when the
            // incumbents' share is dust. If the correction was capped (a seeder
            // deeper than half the migrating side), the pair is still off the
            // price and its incumbents are not dust, so match the pair instead.
            (uint256 num, uint256 den) = (tokenAmount, baseAmount); // tokens per base
            if (capped) (num, den) = _reserves(pair, tokenIs0);
            tDep = Math.mulDiv(b, num, den);
            if (tDep <= t) {
                bDep = b;
            } else {
                tDep = t;
                bDep = Math.mulDiv(t, den, num);
            }
        } else if (rt != 0 || rb != 0) {
            // A one-sided donation into a pair nobody holds LP in (v2 cannot
            // reach a one-sided reserve once liquidity exists, and cannot swap
            // against one either). Top it up to `T : B` instead: deposit only
            // the complement of what is already there, and treat the rest of
            // that side as surplus below. The donation is ours after the mint.
            tDep = rt == 0 ? tokenAmount : (tokenAmount > rt ? tokenAmount - rt : 1);
            bDep = rb == 0 ? baseAmount : (baseAmount > rb ? baseAmount - rb : 1);
        } else {
            (tDep, bDep) = (tokenAmount, baseAmount);
        }

        SafeErc20.safeTransfer(token, pool, tDep);
        SafeErc20.safeTransfer(baseToken, pool, bDep);
        liquidityBurned = pair.mint(BURN_ADDRESS);
        require(liquidityBurned > 0, "no liquidity");

        if (t > tDep || b > bDep) {
            if (t > tDep) SafeErc20.safeTransfer(token, BURN_ADDRESS, t - tDep);
            if (b > bDep) SafeErc20.safeTransfer(baseToken, launchpad, b - bDep);
            emit Surplus(token, t - tDep, b - bDep);
        }

        emit Migrated(token, baseToken, pool, tokenAmount, baseAmount, liquidityBurned);
    }

    /// @dev Swap the pair back to the deposit ratio `T : B`, spending at most
    /// `MAX_CORRECTION_BPS` of the side sold. Returns what this contract holds
    /// afterwards, and whether the cap stopped the correction short.
    ///
    /// The size is the exact v2 swap that leaves the *reserves* at the target
    /// ratio `R = rIn' / rOut'` (not Uniswap's profit-maximising size, which
    /// stops 0.3% short because of the fee — the pool must open *at* the
    /// curve price). With `f = 997/1000`, `out = a·f·rOut / (rIn + a·f)`, and
    /// `(rIn + a) / (rOut - out) = R` reduces to
    /// `997a² + 1997·rIn·a + 1000·rIn² − 1000·R·rOut·rIn = 0`, whose positive
    /// root is `(sqrt(9·rIn² + 3,988,000·R·rOut·rIn) − 1997·rIn) / 1994`.
    /// The trade moves the pair *to* the target and never past it, so every
    /// unit is bought below, or sold above, the graduation price.
    function _correct(
        IUniswapV2Pair pair,
        address token,
        address baseToken,
        bool tokenIs0,
        uint256 T,
        uint256 B
    ) private returns (uint256 t, uint256 b, bool capped) {
        (t, b) = (T, B);
        (uint256 rt, uint256 rb) = _reserves(pair, tokenIs0);

        bool tokenIn;
        uint256 rIn;
        uint256 rOut;
        uint256 rrr; // R · rOut · rIn
        if (rt * B < rb * T) {
            // Too few tokens for the base in the pair: overpriced. Sell tokens.
            (tokenIn, rIn, rOut) = (true, rt, rb);
            rrr = Math.mulDiv(rt * rb, T, B);
        } else if (rb * T < rt * B) {
            // Too few base for the tokens: underpriced. Buy tokens with base.
            (tokenIn, rIn, rOut) = (false, rb, rt);
            rrr = Math.mulDiv(rt * rb, B, T);
        } else {
            return (t, b, false);
        }

        uint256 root = Math.sqrt(9 * rIn * rIn + 3_988_000 * rrr);
        if (root <= 1997 * rIn) return (t, b, false);
        uint256 amountIn = (root - 1997 * rIn) / 1994;
        uint256 cap = ((tokenIn ? T : B) * MAX_CORRECTION_BPS) / 10_000;
        if (amountIn > cap) (amountIn, capped) = (cap, true);

        // UniswapV2Library.getAmountOut, verbatim.
        uint256 amountOut = (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
        if (amountOut == 0) return (t, b, capped);

        SafeErc20.safeTransfer(tokenIn ? token : baseToken, address(pair), amountIn);
        // The output side is the one we did not send.
        bool out0 = tokenIn != tokenIs0;
        pair.swap(out0 ? amountOut : 0, out0 ? 0 : amountOut, address(this), "");

        if (tokenIn) (t, b) = (T - amountIn, B + amountOut);
        else (t, b) = (T + amountOut, B - amountIn);
        emit PoolCorrected(token, address(pair), tokenIn, amountIn, amountOut);
    }

    function _reserves(IUniswapV2Pair pair, bool tokenIs0) private view returns (uint256 rt, uint256 rb) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rt, rb) = tokenIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}
