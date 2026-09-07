// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice A base mint. Decimals are a constructor argument because the two
/// realistic bases on Robinhood Chain differ: ETH/WETH is 18 and USDG is 6, and
/// the curve derivation is sensitive to which one it is.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}

/// @notice Chainlink `AggregatorV3Interface`, with the failure modes chain 4663
/// actually exposes: a stale round, a carried-over answer, and an aggregator
/// that reverts outright.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    bool public reverting;

    constructor(uint8 _decimals, int256 _answer) {
        decimals = _decimals;
        answer = _answer;
        updatedAt = block.timestamp;
        roundId = 1;
        answeredInRound = 1;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
        roundId += 1;
        answeredInRound = roundId;
    }

    /// @notice Advance the round without answering it — the case
    /// `answeredInRound < roundId` is meant to catch.
    function staleRound() external {
        roundId += 1;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        require(!reverting, "aggregator down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @notice The slice of `UniswapV2Pair` the migrator touches, with v2's actual
/// `mint` accounting so the pre-seeded-pool test is meaningful rather than
/// assumed.
contract MockV2Pair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, uint32(block.timestamp));
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        uint256 a0 = b0 - r0;
        uint256 a1 = b1 - r1;

        if (totalSupply == 0) {
            liquidity = _sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
            totalSupply += MINIMUM_LIQUIDITY;
            balanceOf[address(0xdead)] += MINIMUM_LIQUIDITY;
        } else {
            // v2 prices the deposit off existing reserves and keeps the excess
            // of the over-supplied side. This is the line the migrator's
            // deviation guard exists to protect against.
            uint256 l0 = (a0 * totalSupply) / r0;
            uint256 l1 = (a1 * totalSupply) / r1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "insufficient liquidity minted");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        r0 = uint112(b0);
        r1 = uint112(b1);
    }

    /// @notice Seed the pair directly, the way a sniper would.
    function sync() external {
        r0 = uint112(MockERC20(token0).balanceOf(address(this)));
        r1 = uint112(MockERC20(token1).balanceOf(address(this)));
        if (totalSupply == 0) {
            totalSupply = MINIMUM_LIQUIDITY;
            balanceOf[msg.sender] = MINIMUM_LIQUIDITY;
        }
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        require(getPair[a][b] == address(0), "exists");
        pair = address(new MockV2Pair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}
