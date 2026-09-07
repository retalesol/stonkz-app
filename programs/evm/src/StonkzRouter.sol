// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {StonkzLaunchpad} from "./StonkzLaunchpad.sol";
import {StonkzToken} from "./StonkzToken.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title Atomic native-in / native-out trading for Robinhood Chain.
/// @notice Closes the gap recorded in `docs/rh-trade-atomicity-gap.md`.
///
/// Uniswap's Trading API returns calldata addressed to the Universal Router
/// with the *user's own EOA* as the swap recipient. Handed to a wallet as
/// "step 1 of 2", it ends with the base token sitting in the user's wallet and
/// a second signature still required to reach the curve — so a trader who stops
/// signing partway is left holding something they never asked for. This
/// contract is the construction `docs/robinhood-chain.md` §3.3 prescribes
/// instead: it makes *itself* the swap recipient, checks what actually arrived,
/// and calls the curve in the same transaction. One signature, and any leg
/// reverting reverts all of them.
///
/// ## Encoding the recipient — the one thing the caller must get right
///
/// The swap's recipient must resolve to **this contract**. The Universal
/// Router has two sentinels and they are easy to transpose:
/// `MSG_SENDER = address(1)` is whoever called `execute`, and
/// `ADDRESS_THIS = address(2)` is *the Universal Router itself*. Since this
/// contract is the one calling `execute`, the correct value is `MSG_SENDER`
/// (or this contract's literal address). `ADDRESS_THIS` — which both
/// `docs/robinhood-chain.md` §3.3 and the original gap note asked for — parks
/// the output inside the Universal Router, where it holds no owner and anyone
/// may sweep it.
///
/// Getting it wrong is not silently expensive here: nothing arrives, the
/// balance check below fails, and the transaction reverts. That is the point
/// of measuring the outcome rather than trusting the encoding.
///
/// ## What this contract trusts, and what it refuses to
///
/// The Universal Router commands are opaque bytes built off-chain. This
/// contract deliberately does **not** try to parse them — a decoder is a
/// second implementation of Uniswap's encoding and would rot the first time
/// they add a command. It pins the router address at construction and then
/// judges the call purely on its *outcome*: the balance actually delivered,
/// measured here, against the amount the caller says was quoted. An arbitrary
/// `execute` payload therefore cannot do anything useful, because a payload
/// that fails to deliver the quoted amount reverts the transaction.
///
/// That outcome check is also how the "zero Stonkz fee on the aggregator hop"
/// invariant is enforced on-chain. Uniswap can attach a service fee to an API
/// key, taken from the output token and surfaced as `portionBips`
/// (`docs/robinhood-chain.md` §3.2). The API asserts that field is absent on
/// every quote, but the API is not the thing holding the money. A fee smuggled
/// into calldata this contract is handed shows up as delivered-below-quoted,
/// and `AggregatorShortfall` stops it here too.
///
/// ## What this contract never holds
///
/// Nothing, between transactions. Every path ends by forwarding the output and
/// sweeping any residue to the caller. There is no owner, no admin, no pause,
/// no upgrade path and no rescue function: it holds no balance worth rescuing,
/// and an admin key on a contract in the middle of a trade is a liability
/// rather than a safety net.
contract StonkzRouter {
    /// @notice The Universal Router. Immutable — a settable target on a
    /// contract that grants token approvals is a drain waiting for a
    /// compromised key.
    IUniversalRouter public immutable universalRouter;
    /// @notice The curve. Also immutable, and the only contract this one
    /// approves.
    StonkzLaunchpad public immutable launchpad;

    /// @notice Ceiling on the tolerance a caller may declare against the
    /// aggregator's quote.
    /// @dev Without a ceiling, a caller (or a compromised API) could pass
    /// `maxSlippageBps = 10000` and switch the shortfall check off entirely,
    /// which is exactly the check that catches a smuggled fee. 500 bps is the
    /// same bound Uniswap's own `integratorFees` field accepts.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;
    uint256 private constant BPS_DEN = 10_000;

    /// @notice One leg of a trade executed through the aggregator.
    /// @param commands Universal Router command bytes, built off-chain.
    /// @param inputs One input blob per command. The swap's recipient must
    ///        resolve to this contract — encode the `MSG_SENDER` sentinel
    ///        (`address(1)`), not `ADDRESS_THIS`. If it does not, `quotedOut`
    ///        never arrives and the transaction reverts.
    /// @param deadline Passed through to the Universal Router.
    /// @param amountIn Exact amount this contract will hand the router. Ignored
    ///        on the buy path, where the input is `msg.value`.
    /// @param quotedOut What the aggregator said this leg would deliver.
    /// @param maxSlippageBps Tolerance against `quotedOut`, capped at
    ///        `MAX_SLIPPAGE_BPS`.
    struct AggregatorLeg {
        bytes commands;
        bytes[] inputs;
        uint256 deadline;
        uint256 amountIn;
        uint256 quotedOut;
        uint256 maxSlippageBps;
    }

    /// @notice An EIP-2612 authorisation, so a sell stays one signature.
    /// @dev `deadline == 0` means "no permit, use an existing allowance",
    /// which is the path a smart-contract account or a prior approval takes.
    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    error AggregatorShortfall(uint256 quoted, uint256 floor, uint256 received);
    error SlippageTooWide(uint256 requested, uint256 max);
    error UnknownToken(address token);
    error DeadlineExpired();
    error NothingIn();
    error CurveShortfall(uint256 needed, uint256 available);
    error EthTransferFailed();

    event AtomicBuy(
        address indexed trader,
        address indexed token,
        uint256 ethIn,
        uint256 baseFromAggregator,
        uint256 tokensOut
    );
    event AtomicSell(
        address indexed trader, address indexed token, uint256 tokensIn, uint256 baseFromCurve, uint256 ethOut
    );

    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    constructor(IUniversalRouter _universalRouter, StonkzLaunchpad _launchpad) {
        require(address(_universalRouter) != address(0) && address(_launchpad) != address(0), "zero");
        universalRouter = _universalRouter;
        launchpad = _launchpad;
    }

    /// @dev Only the Universal Router may push ETH here, and only mid-trade.
    /// A stray transfer from anyone else would sit in a contract with no sweep
    /// function and be lost, so refuse it rather than accept it silently.
    receive() external payable {
        require(msg.sender == address(universalRouter), "unexpected eth");
    }

    /* ------------------------------------------------------------------ buy */

    /// @notice Native ETH in, launched token out, atomically.
    ///
    /// Swaps `msg.value` to the coin's base token through the Universal Router
    /// with **this contract** as recipient, then spends the whole delivered
    /// amount on the curve and forwards the result to the caller.
    ///
    /// @param token The launched coin.
    /// @param leg The aggregator hop. `leg.quotedOut` is denominated in the
    ///        base token; `leg.amountIn` is unused because the input is
    ///        `msg.value`.
    /// @param minTokenOut Floor on the curve hop, enforced by the launchpad.
    ///        Independent of the aggregator bound: the two legs move for
    ///        unrelated reasons and collapsing them into one number would let
    ///        a bad fill on either hide inside the other's tolerance.
    /// @param deadline Wall-clock bound on the whole trade.
    /// @return tokensOut Launched tokens delivered to the caller.
    function buyViaAggregator(
        address token,
        AggregatorLeg calldata leg,
        uint256 minTokenOut,
        uint256 deadline
    ) external payable nonReentrant before(deadline) returns (uint256 tokensOut) {
        if (msg.value == 0) revert NothingIn();
        address base = _baseOf(token);

        uint256 baseBefore = IERC20(base).balanceOf(address(this));
        universalRouter.execute{value: msg.value}(leg.commands, leg.inputs, leg.deadline);
        uint256 delivered = IERC20(base).balanceOf(address(this)) - baseBefore;
        _requireQuoteHonoured(leg, delivered);

        // Approve exactly what will be spent, and let the launchpad consume all
        // of it. A standing allowance on a contract that anyone can call is an
        // unnecessary standing risk.
        IERC20(base).approve(address(launchpad), delivered);
        tokensOut = launchpad.buy(token, delivered, minTokenOut);
        IERC20(base).approve(address(launchpad), 0);

        require(StonkzToken(token).transfer(msg.sender, tokensOut), "token transfer");

        // The router may not have spent every wei — return the remainder rather
        // than stranding it here.
        if (address(this).balance > 0) _sendEth(msg.sender, address(this).balance);

        emit AtomicBuy(msg.sender, token, msg.value, delivered, tokensOut);
    }

    /* ----------------------------------------------------------------- sell */

    /// @notice Launched token in, native ETH out, atomically and — with a
    /// permit — in a single signature.
    ///
    /// Sells on the curve first, then swaps the base proceeds to ETH through
    /// the Universal Router with this contract as recipient.
    ///
    /// @param token The launched coin.
    /// @param amountToken Tokens to sell.
    /// @param permitData EIP-2612 authorisation, or `deadline == 0` to rely on
    ///        an existing allowance.
    /// @param minBaseOut Floor on the curve hop, enforced by the launchpad.
    /// @param leg The aggregator hop. `leg.amountIn` is the exact base amount
    ///        the off-chain quote was built against, and `leg.quotedOut` is
    ///        denominated in ETH.
    /// @param minEthOut Floor on what the caller finally receives.
    /// @param deadline Wall-clock bound on the whole trade.
    /// @return ethOut Wei delivered to the caller.
    function sellViaAggregator(
        address token,
        uint256 amountToken,
        PermitData calldata permitData,
        uint256 minBaseOut,
        AggregatorLeg calldata leg,
        uint256 minEthOut,
        uint256 deadline
    ) external nonReentrant before(deadline) returns (uint256 ethOut) {
        if (amountToken == 0) revert NothingIn();
        address base = _baseOf(token);

        // One signature: the permit authorises the pull that follows, in the
        // same transaction, so there is no window in which the user has
        // approved this contract but not yet traded.
        if (permitData.deadline != 0) {
            StonkzToken(token)
                .permit(
                    msg.sender,
                    address(this),
                    permitData.value,
                    permitData.deadline,
                    permitData.v,
                    permitData.r,
                    permitData.s
                );
        }
        require(StonkzToken(token).transferFrom(msg.sender, address(this), amountToken), "token pull");

        require(StonkzToken(token).approve(address(launchpad), amountToken), "approve");
        uint256 baseOut = launchpad.sell(token, amountToken, minBaseOut);

        // The aggregator leg was quoted off-chain against an exact input, so it
        // has to be handed exactly that. The curve can return more than the
        // quote assumed — another fill may have moved the price in the seller's
        // favour between quote and inclusion — and that surplus belongs to the
        // seller, not to this contract and not to the router.
        if (baseOut < leg.amountIn) revert CurveShortfall(leg.amountIn, baseOut);
        uint256 surplus = baseOut - leg.amountIn;

        // The Universal Router spends from its own balance when the command is
        // encoded with `payerIsUser = false`, which is the shape this path
        // requires: the payer is this contract, not the signer.
        require(IERC20(base).transfer(address(universalRouter), leg.amountIn), "base to router");

        uint256 ethBefore = address(this).balance;
        universalRouter.execute(leg.commands, leg.inputs, leg.deadline);
        ethOut = address(this).balance - ethBefore;
        _requireQuoteHonoured(leg, ethOut);
        require(ethOut >= minEthOut, "slippage");

        if (surplus > 0) require(IERC20(base).transfer(msg.sender, surplus), "surplus");
        _sendEth(msg.sender, ethOut);

        emit AtomicSell(msg.sender, token, amountToken, baseOut, ethOut);
    }

    /* -------------------------------------------------------------- helpers */

    /// @notice The floor a leg must clear, for a client that wants to show it.
    function shortfallFloor(uint256 quotedOut, uint256 maxSlippageBps) public pure returns (uint256) {
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooWide(maxSlippageBps, MAX_SLIPPAGE_BPS);
        return quotedOut - (quotedOut * maxSlippageBps) / BPS_DEN;
    }

    /// @dev The single check that both bounds ordinary slippage and catches a
    /// fee smuggled into calldata this contract did not build. They are the
    /// same measurement — an output fee is indistinguishable from an adverse
    /// price, and neither is acceptable past the declared tolerance — so one
    /// check is honest and two would be theatre.
    function _requireQuoteHonoured(AggregatorLeg calldata leg, uint256 received) private pure {
        uint256 floor_ = shortfallFloor(leg.quotedOut, leg.maxSlippageBps);
        if (received < floor_) revert AggregatorShortfall(leg.quotedOut, floor_, received);
    }

    function _baseOf(address token) private view returns (address base) {
        base = launchpad.coinInfo(token).baseToken;
        if (base == address(0)) revert UnknownToken(token);
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
