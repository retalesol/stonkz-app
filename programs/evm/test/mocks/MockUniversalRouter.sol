// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {MockERC20} from "./Mocks.sol";

/// @notice Minimal WETH9 for router tests (deposit / withdraw / ERC-20).
contract MockWETH {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "balance");
        balanceOf[msg.sender] -= wad;
        emit Withdrawal(msg.sender, wad);
        emit Transfer(msg.sender, address(0), wad);
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "eth");
    }

    /// @dev Unbacked mint for sell-leg tests (pair with `vm.deal` on this contract).
    function mint(address to, uint256 value) external {
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

/// @notice A stand-in for Uniswap's Universal Router with the real call shape.
///
/// After StonkzRouter's local-wrap change, aggregator buys push WETH into this
/// mock then call `execute` with `msg.value == 0`. Aggregator sells push base
/// and expect WETH out (router unwraps locally — UR unwrap is broken on 46630).
contract MockUniversalRouter {
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;

    address internal constant MSG_SENDER = 0x0000000000000000000000000000000000000001;
    address internal constant ADDRESS_THIS = 0x0000000000000000000000000000000000000002;
    uint256 internal constant CONTRACT_BALANCE = 1 << 255;

    MockWETH public immutable weth;
    MockERC20 public immutable base;
    /// Base atoms delivered per wei in. Set to the base token's scale.
    uint256 public rate;

    uint256 public feeBps;
    address public feeRecipient;

    bool public reverting;

    error Failed();

    constructor(MockWETH _weth, MockERC20 _base, uint256 _rate) {
        weth = _weth;
        base = _base;
        rate = _rate;
        feeRecipient = address(0xFEE);
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    receive() external payable {}

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "Transaction deadline passed");
        if (reverting) revert Failed();
        require(commands.length == inputs.length, "LengthMismatch");

        for (uint256 i = 0; i < commands.length; i++) {
            bytes1 command = commands[i] & 0x3f;
            (address recipient, uint256 amountIn, uint256 amountOutMin,, bool payerIsUser) =
                abi.decode(inputs[i], (address, uint256, uint256, bytes, bool));

            if (command == V3_SWAP_EXACT_IN) {
                require(!payerIsUser, "mock: only router-paid input");
                address to = _resolve(recipient);

                // Prefer WETH→base when we hold WETH (aggregator buy after local wrap).
                uint256 wethBal = weth.balanceOf(address(this));
                if (wethBal > 0) {
                    uint256 spend = amountIn >= CONTRACT_BALANCE ? wethBal : amountIn;
                    require(wethBal >= spend, "V3InsufficientWeth");
                    require(weth.transfer(address(0xdead), spend), "weth sink");
                    uint256 out = _afterFee((spend * rate) / 1 ether);
                    require(out >= amountOutMin, "V3TooLittleReceived");
                    base.mint(to, out);
                    continue;
                }

                // Otherwise base→WETH (aggregator sell).
                uint256 baseBal = base.balanceOf(address(this));
                uint256 spendBase = amountIn >= CONTRACT_BALANCE ? baseBal : amountIn;
                require(baseBal >= spendBase, "V3InsufficientInput");
                require(base.transfer(address(0xdead), spendBase), "base sink");
                uint256 wethOut = _afterFee((spendBase * 1 ether) / rate);
                require(wethOut >= amountOutMin, "V3TooLittleReceived");
                weth.mint(to, wethOut);
            } else {
                revert("mock: unsupported command");
            }
        }
    }

    function _afterFee(uint256 amount) private view returns (uint256) {
        if (feeBps == 0) return amount;
        return amount - (amount * feeBps) / 10_000;
    }

    function _resolve(address recipient) private view returns (address) {
        if (recipient == MSG_SENDER) return msg.sender;
        if (recipient == ADDRESS_THIS) return address(this);
        return recipient;
    }
}

/// @notice SwapRouter02 stand-in for `buyViaV3` / `sellViaV3` unit tests.
contract MockSwapRouter02 {
    MockWETH public immutable weth;
    MockERC20 public immutable base;
    uint256 public rate;

    constructor(MockWETH _weth, MockERC20 _base, uint256 _rate) {
        weth = _weth;
        base = _base;
        rate = _rate;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        if (params.tokenIn == address(weth) && params.tokenOut == address(base)) {
            require(weth.transferFrom(msg.sender, address(0xdead), params.amountIn), "weth");
            amountOut = (params.amountIn * rate) / 1 ether;
            base.mint(params.recipient, amountOut);
            return amountOut;
        }
        if (params.tokenIn == address(base) && params.tokenOut == address(weth)) {
            require(base.transferFrom(msg.sender, address(0xdead), params.amountIn), "base");
            amountOut = (params.amountIn * 1 ether) / rate;
            weth.mint(params.recipient, amountOut);
            return amountOut;
        }
        revert("pair");
    }
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
}
