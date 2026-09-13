// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Mintable 6-decimal USDG stand-in for RH testnet Uniswap seeding.
/// @dev Real USDG (`0x7E95…`) is owner-gated; admin has 0 balance. Coins with
/// `realBase == 0` may be retargeted to this mint so ETH→USDG Uniswap routing
/// can be exercised end-to-end on 46630.
contract TestnetUsdg {
    string public constant name = "Testnet Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable minter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address minter_) {
        require(minter_ != address(0), "minter");
        minter = minter_;
    }

    function mint(address to, uint256 value) external {
        require(msg.sender == minter, "minter");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
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
