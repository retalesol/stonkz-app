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

        pool = factory.getPair(token, baseToken);
        if (pool == address(0)) pool = factory.createPair(token, baseToken);

        // The launchpad has already sent both sides here.
        if (tokenAmount > 0) IERC20Min(token).transfer(pool, tokenAmount);
        if (baseAmount > 0) IERC20Min(baseToken).transfer(pool, baseAmount);

        liquidityBurned = IUniswapV2Pair(pool).mint(BURN_ADDRESS);

        emit Migrated(token, baseToken, pool, tokenAmount, baseAmount, liquidityBurned);
    }
}
