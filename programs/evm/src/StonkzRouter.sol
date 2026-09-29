// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeErc20} from "./SafeErc20.sol";
import {StonkzLaunchpad} from "./StonkzLaunchpad.sol";
import {StonkzToken} from "./StonkzToken.sol";
import {IPyth} from "./oracle/IPyth.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
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

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
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
    /// @notice Chain-local WETH. The Universal Router on RH **testnet** still
    /// pins mainnet aeWETH (`0x0Bd7…`), which has no code on 46630 — so
    /// `WRAP_ETH`/`UNWRAP_WETH` via UR revert. Direct WETH pairs use this
    /// address with `buyWithEth` / `sellForEth` instead.
    IWETH9 public immutable weth;
    /// @notice Uniswap SwapRouter02 for `buyViaV3` / `sellViaV3`. On RH testnet
    /// the Universal Router's CREATE2 pool address does not match the live V3
    /// factory, so pinned-fee aggregator hops use SwapRouter02 instead.
    ISwapRouter02 public immutable swapRouter02;
    /// @notice Hard ceiling on `msg.value` per buy, in native wei; `0` means no cap.
    /// @dev Set only on chains where "testing" means real funds (Arc: native USDC,
    /// 18 decimals at the EVM layer, so 25 USDC is `25e18`). The API and the UI
    /// enforce the same number; this is the layer that cannot be bypassed.
    uint256 public immutable maxBuyNative;
    /// @notice Pyth Core, for the in-transaction price update every launch
    /// entry point accepts. `address(0)` where the chain has none (the launch
    /// then relies on whatever price is already on chain; a non-empty update
    /// reverts `NoPyth`).
    IPyth public immutable pyth;

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

    /// @notice Launch parameters for `createAndBuyWithEth`: the arguments of
    /// `StonkzLaunchpad.createToken`, in the same order.
    struct CreateParams {
        string name;
        string ticker;
        string uri;
        uint256 supply;
        address baseToken;
        uint16 feeBps;
        bool cashback;
    }

    error AggregatorShortfall(uint256 quoted, uint256 floor, uint256 received);
    error SlippageTooWide(uint256 requested, uint256 max);
    error UnknownToken(address token);
    error DeadlineExpired();
    error NothingIn();
    error CurveShortfall(uint256 needed, uint256 available);
    error EthTransferFailed();
    error NoPyth();
    error UpdateFeeUnpaid(uint256 fee, uint256 value);

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

    error BuyAboveCap(uint256 value, uint256 cap);

    constructor(
        IUniversalRouter _universalRouter,
        StonkzLaunchpad _launchpad,
        IWETH9 _weth,
        ISwapRouter02 _swapRouter02,
        uint256 _maxBuyNative,
        IPyth _pyth
    ) {
        require(
            address(_universalRouter) != address(0) && address(_launchpad) != address(0)
                && address(_weth) != address(0) && address(_swapRouter02) != address(0),
            "zero"
        );
        universalRouter = _universalRouter;
        launchpad = _launchpad;
        weth = _weth;
        swapRouter02 = _swapRouter02;
        maxBuyNative = _maxBuyNative;
        pyth = _pyth;
    }

    /// @dev Every native-in entry point runs through this before touching a curve.
    modifier underCap() {
        if (maxBuyNative != 0 && msg.value > maxBuyNative) revert BuyAboveCap(msg.value, maxBuyNative);
        _;
    }

    /* ------------------------------------------------------ direct WETH pair */

    /// @notice Native ETH → WETH (chain-local) → curve buy. One signature.
    /// @dev Prefer this over `buyViaAggregator`+`WRAP_ETH` whenever the coin's
    /// base is this contract's `weth` — UR wrap is not trustworthy on RH testnet.
    function buyWithEth(address token, uint256 minTokenOut, uint256 deadline)
        external
        payable
        underCap
        nonReentrant
        before(deadline)
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert NothingIn();
        require(_baseOf(token) == address(weth), "not weth pair");
        tokensOut = _buyWithWeth(token, msg.value, minTokenOut);
    }

    /// @notice Launch a WETH-based coin with the caller as its creator and
    /// dev-buy it with `msg.value`, in one transaction.
    ///
    /// Tokens are deployed with CREATE, so a coin's address is unknown until
    /// its creation lands; a dev buy sent as a second transaction therefore
    /// leaves a window in which anyone watching `TokenCreated` can buy first.
    /// Here the creation and the buy share a transaction, so the creator's
    /// fill is the first fill the curve ever sees.
    ///
    /// The launchpad records — and emits in `TokenCreated` — `msg.sender` as
    /// the creator, not this router (`StonkzLaunchpad.createTokenFor`, which
    /// only this router may call). The curve's own `Trade` names the router as
    /// trader, exactly as on `buyWithEth`; `AtomicBuy` names the user.
    ///
    /// @param p Launch parameters; `p.baseToken` must be this router's `weth`.
    /// @param priceUpdate Signed Pyth (Hermes) price updates, submitted before
    ///        the launch so it snapshots a seconds-old price. Its fee
    ///        (`pyth.getUpdateFee`) comes out of `msg.value`. Empty: no update,
    ///        the launch uses the price already on chain.
    /// @param minTokenOut Floor on the dev buy, enforced by the launchpad.
    ///        Ignored when nothing is left for a buy after the update fee.
    /// @param deadline Wall-clock bound on the whole transaction.
    /// @return token The new coin.
    /// @return tokensOut Tokens delivered to the caller; `0` when `msg.value`
    ///         only covered the update fee (a plain launch, still attributed to
    ///         the caller).
    function createAndBuyWithEth(
        CreateParams calldata p,
        bytes[] calldata priceUpdate,
        uint256 minTokenOut,
        uint256 deadline
    ) external payable underCap nonReentrant before(deadline) returns (address token, uint256 tokensOut) {
        require(p.baseToken == address(weth), "not weth pair");
        uint256 fee = _updatePrice(priceUpdate);
        token = _create(p);
        uint256 amount = msg.value - fee;
        if (amount > 0) tokensOut = _buyWithWeth(token, amount, minTokenOut);
    }

    /// @notice Launch a coin on any base with the caller as its creator and no
    /// dev buy, after an optional in-transaction Pyth update — so every app
    /// launch, with or without a buy, goes through the router.
    /// @param priceUpdate As in `createAndBuyWithEth`; empty for none.
    /// @dev `msg.value` pays the update fee; anything above it is refunded.
    function createWithPriceUpdate(CreateParams calldata p, bytes[] calldata priceUpdate, uint256 deadline)
        external
        payable
        nonReentrant
        before(deadline)
        returns (address token)
    {
        uint256 fee = _updatePrice(priceUpdate);
        token = _create(p);
        if (msg.value > fee) _sendEth(msg.sender, msg.value - fee);
    }

    /// @dev Submit `priceUpdate` to Pyth, paying its fee from `msg.value`.
    function _updatePrice(bytes[] calldata priceUpdate) private returns (uint256 fee) {
        if (priceUpdate.length == 0) return 0;
        if (address(pyth) == address(0)) revert NoPyth();
        fee = pyth.getUpdateFee(priceUpdate);
        if (fee > msg.value) revert UpdateFeeUnpaid(fee, msg.value);
        pyth.updatePriceFeeds{value: fee}(priceUpdate);
    }

    function _create(CreateParams calldata p) private returns (address) {
        return launchpad.createTokenFor(
            msg.sender, p.name, p.ticker, p.uri, p.supply, p.baseToken, p.feeBps, p.cashback
        );
    }

    /// @dev Wrap `amount` of `msg.value`, buy `token` on the curve, hand the
    /// caller the tokens and any unspent ETH, and emit `AtomicBuy` (`ethIn` =
    /// `amount`, i.e. net of any Pyth update fee). The caller has checked that
    /// `token`'s base is `weth`.
    function _buyWithWeth(address token, uint256 amount, uint256 minTokenOut)
        private
        returns (uint256 tokensOut)
    {
        weth.deposit{value: amount}();
        SafeErc20.safeApprove(address(weth), address(launchpad), amount);
        uint256 spent;
        (spent, tokensOut) = _buyMeasured(address(weth), token, amount, minTokenOut);
        SafeErc20.safeApprove(address(weth), address(launchpad), 0);

        require(StonkzToken(token).transfer(msg.sender, tokensOut), "token transfer");
        _refundBase(address(weth), amount - spent);
        emit AtomicBuy(msg.sender, token, amount, spent, tokensOut);
    }

    /// @notice Native ETH → local WETH → SwapRouter02 V3 → curve buy.
    /// @dev Prefer this over `buyViaAggregator` on RH testnet: UR's V3 CREATE2
    /// pool address does not match the factory SwapRouter02 uses.
    function buyViaV3(
        address token,
        uint24 fee,
        uint256 quotedBaseOut,
        uint256 maxSlippageBps,
        uint256 minTokenOut,
        uint256 deadline
    ) external payable nonReentrant underCap before(deadline) returns (uint256 tokensOut) {
        if (msg.value == 0) revert NothingIn();
        address base = _baseOf(token);

        weth.deposit{value: msg.value}();
        SafeErc20.safeApprove(address(weth), address(swapRouter02), msg.value);
        uint256 delivered = swapRouter02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: base,
                fee: fee,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        SafeErc20.safeApprove(address(weth), address(swapRouter02), 0);
        _requireQuoteHonouredValues(quotedBaseOut, maxSlippageBps, delivered);

        SafeErc20.safeApprove(base, address(launchpad), delivered);
        uint256 spent;
        (spent, tokensOut) = _buyMeasured(base, token, delivered, minTokenOut);
        SafeErc20.safeApprove(base, address(launchpad), 0);

        require(StonkzToken(token).transfer(msg.sender, tokensOut), "token transfer");
        _refundBase(base, delivered - spent);
        if (address(this).balance > 0) _sendEth(msg.sender, address(this).balance);
        emit AtomicBuy(msg.sender, token, msg.value, delivered, tokensOut);
    }

    /// @notice Curve sell → SwapRouter02 V3 → local WETH unwrap → ETH.
    function sellViaV3(
        address token,
        uint256 amountToken,
        PermitData calldata permitData,
        uint256 minBaseOut,
        uint24 fee,
        uint256 quotedEthOut,
        uint256 maxSlippageBps,
        uint256 minEthOut,
        uint256 amountInBase,
        uint256 deadline
    ) external nonReentrant before(deadline) returns (uint256 ethOut) {
        if (amountToken == 0) revert NothingIn();
        address base = _baseOf(token);

        if (permitData.deadline != 0) _permitOrFallThrough(token, permitData);
        require(StonkzToken(token).transferFrom(msg.sender, address(this), amountToken), "token pull");
        require(StonkzToken(token).approve(address(launchpad), amountToken), "approve");
        uint256 baseOut = launchpad.sell(token, amountToken, minBaseOut);
        if (baseOut < amountInBase) revert CurveShortfall(amountInBase, baseOut);
        uint256 surplus = baseOut - amountInBase;

        SafeErc20.safeApprove(base, address(swapRouter02), amountInBase);
        uint256 wethOut = swapRouter02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: base,
                tokenOut: address(weth),
                fee: fee,
                recipient: address(this),
                amountIn: amountInBase,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        SafeErc20.safeApprove(base, address(swapRouter02), 0);
        _requireQuoteHonouredValues(quotedEthOut, maxSlippageBps, wethOut);
        require(wethOut >= minEthOut, "slippage");

        if (surplus > 0) SafeErc20.safeTransfer(base, msg.sender, surplus);
        weth.withdraw(wethOut);
        ethOut = wethOut;
        _sendEth(msg.sender, ethOut);
        emit AtomicSell(msg.sender, token, amountToken, baseOut, ethOut);
    }

    /// @notice Curve sell → unwrap WETH → native ETH. One signature with permit.
    function sellForEth(
        address token,
        uint256 amountToken,
        PermitData calldata permitData,
        uint256 minBaseOut,
        uint256 minEthOut,
        uint256 deadline
    ) external nonReentrant before(deadline) returns (uint256 ethOut) {
        if (amountToken == 0) revert NothingIn();
        address base = _baseOf(token);
        require(base == address(weth), "not weth pair");

        if (permitData.deadline != 0) _permitOrFallThrough(token, permitData);
        require(StonkzToken(token).transferFrom(msg.sender, address(this), amountToken), "token pull");
        require(StonkzToken(token).approve(address(launchpad), amountToken), "approve");
        uint256 baseOut = launchpad.sell(token, amountToken, minBaseOut);
        require(baseOut >= minEthOut, "slippage");

        weth.withdraw(baseOut);
        ethOut = baseOut;
        _sendEth(msg.sender, ethOut);
        emit AtomicSell(msg.sender, token, amountToken, baseOut, ethOut);
    }

    /// @dev Only the Universal Router (mid-trade unwrap via UR) or chain-local
    /// WETH (`withdraw`) may push ETH here. A stray transfer from anyone else
    /// would sit in a contract with no sweep function and be lost, so refuse
    /// it rather than accept it silently.
    receive() external payable {
        require(msg.sender == address(universalRouter) || msg.sender == address(weth), "unexpected eth");
    }

    /* ------------------------------------------------------------------ buy */

    /// @notice Native ETH in, launched token out, atomically.
    ///
    /// Wraps `msg.value` into chain-local WETH here (UR `WRAP_ETH` on RH
    /// testnet still targets mainnet aeWETH and reverts), pushes that WETH to
    /// the Universal Router, swaps to the coin's base with **this contract**
    /// as recipient, then spends the whole delivered amount on the curve.
    ///
    /// @param token The launched coin.
    /// @param leg The aggregator hop. Must be a V3-only swap (no WRAP_ETH) —
    ///        WETH is already on the Universal Router's balance. `leg.quotedOut`
    ///        is denominated in the base token; `leg.amountIn` is unused.
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
    ) external payable nonReentrant underCap before(deadline) returns (uint256 tokensOut) {
        if (msg.value == 0) revert NothingIn();
        address base = _baseOf(token);

        // Local wrap — do not send ETH into UR (broken WRAP_ETH on 46630).
        weth.deposit{value: msg.value}();
        require(weth.transfer(address(universalRouter), msg.value), "weth push");

        uint256 baseBefore = IERC20(base).balanceOf(address(this));
        universalRouter.execute(leg.commands, leg.inputs, leg.deadline);
        uint256 delivered = IERC20(base).balanceOf(address(this)) - baseBefore;
        _requireQuoteHonoured(leg, delivered);

        // Approve exactly what will be spent, and let the launchpad consume all
        // of it. A standing allowance on a contract that anyone can call is an
        // unnecessary standing risk.
        SafeErc20.safeApprove(base, address(launchpad), delivered);
        uint256 spent;
        (spent, tokensOut) = _buyMeasured(base, token, delivered, minTokenOut);
        SafeErc20.safeApprove(base, address(launchpad), 0);

        require(StonkzToken(token).transfer(msg.sender, tokensOut), "token transfer");

        // The router may not have spent every wei — return the remainder rather
        // than stranding it here.
        _refundBase(base, delivered - spent);
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
        if (permitData.deadline != 0) _permitOrFallThrough(token, permitData);
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
        // requires: the payer is this contract, not the signer. Leg must be
        // V3-only (no UNWRAP_WETH) — UR unwrap targets mainnet aeWETH on 46630.
        SafeErc20.safeTransfer(base, address(universalRouter), leg.amountIn);

        uint256 wethBefore = weth.balanceOf(address(this));
        universalRouter.execute(leg.commands, leg.inputs, leg.deadline);
        uint256 wethOut = weth.balanceOf(address(this)) - wethBefore;
        _requireQuoteHonoured(leg, wethOut);
        require(wethOut >= minEthOut, "slippage");

        if (surplus > 0) SafeErc20.safeTransfer(base, msg.sender, surplus);

        weth.withdraw(wethOut);
        ethOut = wethOut;
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
        _requireQuoteHonouredValues(leg.quotedOut, leg.maxSlippageBps, received);
    }

    function _requireQuoteHonouredValues(uint256 quotedOut, uint256 maxSlippageBps, uint256 received)
        private
        pure
    {
        uint256 floor_ = shortfallFloor(quotedOut, maxSlippageBps);
        if (received < floor_) revert AggregatorShortfall(quotedOut, floor_, received);
    }

    /// @dev Buy on the curve and measure what it really took. A buy that would
    /// overshoot the curve's remaining allocation is capped by the launchpad,
    /// which pulls only `f.grossBase`; handing it `amountBase` and assuming
    /// it spent all of it strands the rest in this contract, which has no
    /// rescue function by design.
    function _buyMeasured(address base, address token, uint256 amountBase, uint256 minTokenOut)
        private
        returns (uint256 spent, uint256 tokensOut)
    {
        uint256 before = IERC20(base).balanceOf(address(this));
        tokensOut = launchpad.buy(token, amountBase, minTokenOut);
        spent = before - IERC20(base).balanceOf(address(this));
        require(spent <= amountBase, "curve overdraw");
    }

    /// @dev Return unspent base to the trader: as ETH when the base is the
    /// chain's WETH (so `receive` only ever sees WETH's own unwrap), as the
    /// token otherwise.
    function _refundBase(address base, uint256 amount) private {
        if (amount == 0) return;
        if (base == address(weth)) {
            weth.withdraw(amount);
            _sendEth(msg.sender, amount);
        } else {
            SafeErc20.safeTransfer(base, msg.sender, amount);
        }
    }

    /// @dev A permit is a public signature: anyone can front-run the sell and
    /// submit it first, consuming the nonce. The allowance it grants is the
    /// one this contract needs either way, so a failed permit falls through
    /// to the `transferFrom`, which then succeeds on that allowance or reverts
    /// with the honest reason.
    function _permitOrFallThrough(address token, PermitData calldata permitData) private {
        try StonkzToken(token)
            .permit(
                msg.sender,
                address(this),
                permitData.value,
                permitData.deadline,
                permitData.v,
                permitData.r,
                permitData.s
            ) {}
            catch {}
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
