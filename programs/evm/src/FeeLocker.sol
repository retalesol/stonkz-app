// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CurveMath} from "./CurveMath.sol";
import {SafeErc20} from "./SafeErc20.sol";
import {FullMath} from "./oracle/uniswap/FullMath.sol";
import {IUniswapV3Pool} from "./oracle/uniswap/IUniswapV3.sol";

interface IERC20Locker {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @dev The one launchpad read the locker needs: who the current migrator is.
interface ILaunchpadMigrator {
    function migrator() external view returns (address);
}

/// @dev What the locker asks the migrator to do with collected fees. Reached
/// through `launchpad.migrator()` at call time, never pinned: a future
/// migrator that keeps this locker keeps its fee flow.
interface IFeeRouter {
    function accrueFees(address token, address baseToken, uint256 baseAmount, uint256 tokenAmount) external;
}

/// @title Immutable holder of graduated coins' Uniswap v3 positions.
///
/// @notice Every coin `UniswapV3Migrator` graduates ends up as one full-range
/// position in this contract's name, keyed in the pool by
/// `(address(this), tickLower, tickUpper)`. This contract has **no** function
/// that calls `burn` with a non-zero amount, no owner, no admin and no
/// upgrade path, so the principal can never leave the pool — that is
/// checkable by reading this file, exactly as "the LP tokens are at 0x…dEaD"
/// was checkable for the v2 migrator. What the position *earns* is a
/// different matter and the reason this contract exists: `claimFees` is
/// permissionless and routes every collected fee into the launchpad's
/// existing ledgers, so post-graduation trading pays the same 15/10/6/69
/// split, to the same creator, stakers and treasuries, as the curve did.
///
/// ## Routing
///
/// - **Base side** (the raise asset): handed to the launchpad whole; its
///   `accrueExternalFees` splits it 15% protocol / 10% buyback / 6% RWA /
///   69% creator bucket with the curve's own arithmetic and staker peel.
/// - **Token side**: the 69% bucket share goes to the launchpad (creator +
///   stakers, in tokens, like a cashback-window fill). The other 31% — the
///   treasury legs — is **burned** to `0x…dEaD`. Swapping it to base in the
///   same pool would be sandwichable and would move the price of the very
///   pool being collected from; burning is deterministic, needs no price and
///   shrinks the float for every holder. The treasuries therefore earn from
///   the base side only, which is where the value is anyway.
///
/// Positions are owned directly in the pool rather than through the
/// NonfungiblePositionManager: RH testnet (46630) has no NFPM, and owning the
/// key directly removes a dependency on every chain. `uniswapV3MintCallback`
/// is not implemented here — the migrator mints *to* this address and pays.
contract FeeLocker {
    using SafeErc20 for address;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant Q128 = 1 << 128;

    struct Lock {
        address pool;
        address baseToken;
        int24 tickLower;
        int24 tickUpper;
        bool tokenIs0;
        uint128 liquidity;
    }

    /// @notice The launchpad whose ledgers receive the fees and whose
    /// `migrator` may register positions and is asked to route them.
    ILaunchpadMigrator public immutable launchpad;

    mapping(address => Lock) private _locks;
    uint256 private _guard = 1;

    event PositionLocked(
        address indexed token, address indexed pool, int24 tickLower, int24 tickUpper, uint128 liquidity
    );
    /// @notice One `claimFees`: what the pool paid out, and where it went.
    /// `tokensBurned + tokensToBucket == tokenAmount`; all of `baseAmount`
    /// went to the launchpad.
    event FeesCollected(
        address indexed token,
        address indexed pool,
        uint256 baseAmount,
        uint256 tokenAmount,
        uint256 tokensBurned,
        uint256 tokensToBucket
    );

    constructor(ILaunchpadMigrator _launchpad) {
        require(address(_launchpad) != address(0), "zero launchpad");
        launchpad = _launchpad;
    }

    modifier nonReentrant() {
        require(_guard == 1, "reentrant");
        _guard = 2;
        _;
        _guard = 1;
    }

    /// @notice Record the position the current migrator just minted to this
    /// contract. Verified against the pool, once per token, forever.
    function register(
        address token,
        address baseToken,
        address pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external {
        require(msg.sender == launchpad.migrator(), "not migrator");
        require(_locks[token].pool == address(0), "registered");
        require(liquidity > 0, "no liquidity");
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        bool tokenIs0 = t0 == token;
        require((tokenIs0 && t1 == baseToken) || (t1 == token && t0 == baseToken), "pool tokens");
        (uint128 held,,,,) = p.positions(_key(tickLower, tickUpper));
        require(held >= liquidity, "no position");
        _locks[token] = Lock(pool, baseToken, tickLower, tickUpper, tokenIs0, liquidity);
        emit PositionLocked(token, pool, tickLower, tickUpper, liquidity);
    }

    /// @notice Collect whatever the position has earned and route it.
    /// Permissionless: the caller pays gas and gets nothing else.
    /// @dev `burn(…, 0)` is the v3 "poke" that moves accrued fee growth into
    /// `tokensOwed` without touching liquidity; `collect` then pays it out.
    function claimFees(address token)
        external
        nonReentrant
        returns (uint256 baseAmount, uint256 tokenAmount)
    {
        Lock memory l = _locks[token];
        require(l.pool != address(0), "not locked");
        IUniswapV3Pool p = IUniswapV3Pool(l.pool);
        p.burn(l.tickLower, l.tickUpper, 0);
        (uint128 c0, uint128 c1) =
            p.collect(address(this), l.tickLower, l.tickUpper, type(uint128).max, type(uint128).max);
        (tokenAmount, baseAmount) = l.tokenIs0 ? (uint256(c0), uint256(c1)) : (uint256(c1), uint256(c0));
        require(baseAmount > 0 || tokenAmount > 0, "nothing");

        // The bucket's share of the token side, by the same integer split the
        // launchpad applies; the treasury legs are burned (see the header).
        uint256 toBucket = CurveMath.splitFee(tokenAmount).creatorBucket;
        uint256 toBurn = tokenAmount - toBucket;
        if (toBurn > 0) require(IERC20Locker(token).transfer(BURN_ADDRESS, toBurn), "burn");

        address router = launchpad.migrator();
        require(router != address(0), "no router");
        if (baseAmount > 0) l.baseToken.safeTransfer(router, baseAmount);
        if (toBucket > 0) require(IERC20Locker(token).transfer(router, toBucket), "transfer");
        if (baseAmount > 0 || toBucket > 0) {
            IFeeRouter(router).accrueFees(token, l.baseToken, baseAmount, toBucket);
        }

        emit FeesCollected(token, l.pool, baseAmount, tokenAmount, toBurn, toBucket);
    }

    /* ---------------------------------------------------------------- views */

    function lockOf(address token) external view returns (Lock memory) {
        return _locks[token];
    }

    /// @notice Fees the position has earned and not yet collected, in the
    /// pool's own accounting: `tokensOwed` plus fee growth since the last
    /// poke, exactly as `Position.update` would compute it on the next one.
    /// What `claimFees(token)` would return right now.
    function pendingFees(address token) external view returns (uint256 baseAmount, uint256 tokenAmount) {
        Lock memory l = _locks[token];
        if (l.pool == address(0)) return (0, 0);
        IUniswapV3Pool p = IUniswapV3Pool(l.pool);
        (uint128 liq, uint256 in0Last, uint256 in1Last, uint128 owed0, uint128 owed1) =
            p.positions(_key(l.tickLower, l.tickUpper));
        (uint256 in0, uint256 in1) = _feeGrowthInside(p, l.tickLower, l.tickUpper);
        uint256 a0 = owed0;
        uint256 a1 = owed1;
        unchecked {
            // Fee growth wraps by design (v3 `Tick.getFeeGrowthInside`).
            a0 += FullMath.mulDiv(in0 - in0Last, liq, Q128);
            a1 += FullMath.mulDiv(in1 - in1Last, liq, Q128);
        }
        (tokenAmount, baseAmount) = l.tokenIs0 ? (a0, a1) : (a1, a0);
    }

    /// @dev v3-core `Tick.getFeeGrowthInside`, off the pool's public state.
    function _feeGrowthInside(IUniswapV3Pool p, int24 lower, int24 upper)
        private
        view
        returns (uint256 inside0, uint256 inside1)
    {
        (, int24 tick,,,,,) = p.slot0();
        uint256 g0 = p.feeGrowthGlobal0X128();
        uint256 g1 = p.feeGrowthGlobal1X128();
        (,, uint256 lo0, uint256 lo1,,,,) = p.ticks(lower);
        (,, uint256 up0, uint256 up1,,,,) = p.ticks(upper);
        unchecked {
            (uint256 below0, uint256 below1) = tick >= lower ? (lo0, lo1) : (g0 - lo0, g1 - lo1);
            (uint256 above0, uint256 above1) = tick < upper ? (up0, up1) : (g0 - up0, g1 - up1);
            inside0 = g0 - below0 - above0;
            inside1 = g1 - below1 - above1;
        }
    }

    function _key(int24 lower, int24 upper) private view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), lower, upper));
    }
}
