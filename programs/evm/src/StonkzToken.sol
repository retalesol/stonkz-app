// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title A launched Stonkz memecoin.
/// @notice Fixed supply, minted once in the constructor to the launchpad. There
/// is no mint function and no owner, which is the EVM equivalent of the Solana
/// side setting mint and freeze authority to `None` at creation. `burn` exists
/// only so the launchpad can destroy the unsold allocation on an early
/// oracle-triggered graduation, and it can only burn its own balance.
contract StonkzToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice The launchpad. Immutable, and holds no privilege beyond `burn`.
    address public immutable launchpad;
    string public uri;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, string memory _uri, uint256 _supply) {
        name = _name;
        symbol = _symbol;
        uri = _uri;
        launchpad = msg.sender;
        totalSupply = _supply;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);
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

    /// @notice Destroy tokens the launchpad itself holds. Nothing else can be burned.
    function burn(uint256 value) external {
        require(msg.sender == launchpad, "only launchpad");
        require(balanceOf[msg.sender] >= value, "balance");
        unchecked {
            balanceOf[msg.sender] -= value;
            totalSupply -= value;
        }
        emit Transfer(msg.sender, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "to zero");
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
