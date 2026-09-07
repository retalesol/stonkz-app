// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {MockERC20} from "./Mocks.sol";

/// @notice A stand-in for Uniswap's Universal Router with the real call shape.
///
/// The entrypoint signature is the genuine one — `execute(bytes commands,
/// bytes[] inputs, uint256 deadline)` — and each input blob is encoded exactly
/// as `V3_SWAP_EXACT_IN` encodes it: `(recipient, amountIn, amountOutMin, path,
/// payerIsUser)`. That matters for this suite specifically, because the whole
/// point of `StonkzRouter` is that **it** must be the recipient rather than the
/// user, and the `payerIsUser = false` flag is what lets the router pay from
/// its own balance on the sell leg. Both of those live in the encoding, so a
/// mock that invented its own encoding would test nothing.
///
/// The price is a fixed rate rather than a curve — this contract exists to
/// prove the composition, not to reimplement Uniswap.
contract MockUniversalRouter {
    /// Real Universal Router command bytes.
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant WRAP_ETH = 0x0b;
    bytes1 internal constant UNWRAP_WETH = 0x0c;

    /// @dev The Universal Router's two recipient sentinels, and they are easy
    /// to get backwards. `MSG_SENDER` is whoever called `execute` — for us,
    /// `StonkzRouter`. `ADDRESS_THIS` is the **Universal Router itself**, used
    /// to park an intermediate hop inside a multi-command sequence. Encoding
    /// `ADDRESS_THIS` as the final recipient strands the output in the
    /// Universal Router, where anyone can sweep it.
    address internal constant MSG_SENDER = 0x0000000000000000000000000000000000000001;
    address internal constant ADDRESS_THIS = 0x0000000000000000000000000000000000000002;

    MockERC20 public immutable base;
    /// Base atoms delivered per wei in. Set to the base token's scale.
    uint256 public rate;

    /// @notice Basis points skimmed from the output before delivery.
    /// @dev This is the `portionBips` service fee Uniswap can attach to an API
    /// key, taken from the output token. The API is supposed to assert it is
    /// absent on every quote; this switch is here so the router's on-chain
    /// backstop can be tested rather than assumed.
    uint256 public feeBps;
    address public feeRecipient;

    bool public reverting;

    error Failed();

    constructor(MockERC20 _base, uint256 _rate) {
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
                if (msg.value > 0) {
                    // ETH in, base out.
                    uint256 out = _afterFee((amountIn == 0 ? msg.value : amountIn) * rate / 1 ether);
                    require(out >= amountOutMin, "V3TooLittleReceived");
                    base.mint(_resolve(recipient), out);
                } else {
                    // Base in, ETH out. `payerIsUser == false` means the router
                    // spends the balance already sitting in it, which is how
                    // `StonkzRouter` pays for its sell leg.
                    require(!payerIsUser, "mock: only router-paid input");
                    require(base.balanceOf(address(this)) >= amountIn, "V3InsufficientInput");
                    uint256 out = _afterFee(amountIn * 1 ether / rate);
                    require(out >= amountOutMin, "V3TooLittleReceived");
                    (bool ok,) = _resolve(recipient).call{value: out}("");
                    require(ok, "eth out");
                }
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
