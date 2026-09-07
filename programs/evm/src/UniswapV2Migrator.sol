// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

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
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
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
/// The `$STONKZ` protocol-owned liquidity in Phase 7 has the opposite
/// requirement (it must retain fee-collect authority) and therefore needs a v3
/// or v4 position in an immutable locker instead. That is deliberately **not**
/// implemented here — Phase 7 is out of scope and the token does not exist.
contract UniswapV2Migrator {
    /// @dev `0xdead` rather than `address(0)`: UniswapV2Pair's own `_burn`
    /// path treats the zero address specially in some forks, and a visible
    /// dead-address balance is easier for a user to verify on the explorer.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice How far the pair's existing price may sit from the price implied
    /// by the amounts we are depositing, in basis points, before we refuse.
    /// @dev A v2 pair address is deterministic from the token pair, so anyone
    /// can create and seed it ahead of the graduation transaction at whatever
    /// price they like (`docs/robinhood-chain.md` §4.4, point 2). `mint` prices
    /// a deposit off the *existing* reserves and silently keeps the excess of
    /// the over-supplied side for the incumbent LPs — so migrating into a
    /// manipulated pair donates the curve's raise to the sniper. This bound
    /// turns that from a silent loss into a revert.
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 100;

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

    constructor(IUniswapV2Factory _factory, address _launchpad) {
        factory = _factory;
        launchpad = _launchpad;
    }

    /// @notice Create the pair if needed, deposit both sides, and burn every LP
    /// token minted. This contract keeps no LP and has no withdrawal path.
    function migrate(address token, address baseToken, uint256 tokenAmount, uint256 baseAmount)
        external
        returns (address pool, uint256 liquidityBurned)
    {
        require(msg.sender == launchpad, "only launchpad");
        require(tokenAmount > 0 && baseAmount > 0, "one-sided");

        pool = factory.getPair(token, baseToken);
        if (pool == address(0)) {
            pool = factory.createPair(token, baseToken);
        } else {
            _requireUnmanipulated(pool, token, tokenAmount, baseAmount);
        }

        // The launchpad has already sent both sides here.
        require(IERC20Min(token).transfer(pool, tokenAmount), "token transfer");
        require(IERC20Min(baseToken).transfer(pool, baseAmount), "base transfer");

        liquidityBurned = IUniswapV2Pair(pool).mint(BURN_ADDRESS);
        require(liquidityBurned > 0, "no liquidity");

        emit Migrated(token, baseToken, pool, tokenAmount, baseAmount, liquidityBurned);
    }

    /// @dev Compares the pair's reserve ratio against the ratio we are about to
    /// deposit. An empty pair is fine — we set the price. A pair already at our
    /// price is fine, and is the normal case if a graduation is retried.
    function _requireUnmanipulated(
        address pool,
        address token,
        uint256 tokenAmount,
        uint256 baseAmount
    ) private view {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pool).getReserves();
        if (r0 == 0 || r1 == 0) return;

        (uint256 reserveToken, uint256 reserveBase) =
            IUniswapV2Pair(pool).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        // Cross-multiply rather than divide: `base/token` truncates to zero for
        // any realistic memecoin ratio.
        uint256 lhs = reserveBase * tokenAmount;
        uint256 rhs = baseAmount * reserveToken;
        uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
        uint256 scale = lhs > rhs ? lhs : rhs;
        require(diff * 10_000 <= scale * MAX_PRICE_DEVIATION_BPS, "pool price manipulated");
    }
}
