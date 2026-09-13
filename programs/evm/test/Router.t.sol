// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockUniversalRouter, MockWETH, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice Atomic native-in / native-out trading, the gap
/// `docs/rh-trade-atomicity-gap.md` was opened to track.
///
/// The property under test is not "the router works" but "the router cannot
/// leave a trader holding something they did not ask for". Every test here is
/// either a happy path that ends with the user holding exactly the intended
/// asset, or a failure that ends with the user holding exactly what they
/// started with.
contract RouterTest is Test {
    StonkzLaunchpad pad;
    StonkzRouter router;
    MockUniversalRouter ur;
    MockWETH weth;
    PushPriceSource oracle;
    MockERC20 base;
    address token;

    address admin = address(0xA11CE);
    address oracleAuth = address(0x0AC1E);
    address creator = address(0xC4EA7);
    address trader;
    uint256 traderKey = 0xA11CE5EED;

    uint8 constant BASE_DECIMALS = 6;
    uint256 constant ONE = 10 ** BASE_DECIMALS;
    /// $1 base, and 1 ETH buys 3,000 of it.
    uint256 constant RATE = 3_000 * ONE;

    /// V3_SWAP_EXACT_IN, the real Universal Router command byte.
    bytes constant CMD = hex"00";
    /// The Universal Router's recipient sentinels. `MSG_SENDER` is whoever
    /// called `execute` — `StonkzRouter` — and is what a Stonkz-composed swap
    /// must use. `ADDRESS_THIS` is the Universal Router itself and would strand
    /// the output there; `test_AMisEncodedRecipientReverts` pins that.
    address constant MSG_SENDER = 0x0000000000000000000000000000000000000001;
    address constant ADDRESS_THIS = 0x0000000000000000000000000000000000000002;

    function setUp() public {
        vm.warp(1_800_000_000);
        trader = vm.addr(traderKey);

        base = new MockERC20("Global Dollar", "USDG", BASE_DECIMALS);
        weth = new MockWETH();
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, admin, admin, oracle, admin);
        ur = new MockUniversalRouter(weth, base, RATE);
        MockSwapRouter02 sr02 = new MockSwapRouter02(weth, base, RATE);
        router = new StonkzRouter(
            IUniversalRouter(address(ur)), pad, IWETH9(address(weth)), ISwapRouter02(address(sr02))
        );

        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);

        vm.prank(creator);
        token = pad.createToken("Coin", "ATOM", "u", 1_000_000_000, address(base), 250, false);

        vm.deal(trader, 100 ether);
        vm.deal(address(weth), 1_000 ether);
    }

    /* ------------------------------------------------------------- encoding */

    /// Encodes an input blob exactly as `V3_SWAP_EXACT_IN` does.
    function _input(address recipient, uint256 amountIn, uint256 amountOutMin, bool payerIsUser)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        inputs = new bytes[](1);
        inputs[0] = abi.encode(recipient, amountIn, amountOutMin, bytes(""), payerIsUser);
    }

    function _buyLeg(uint256 ethIn) internal view returns (StonkzRouter.AggregatorLeg memory) {
        uint256 quoted = (ethIn * RATE) / 1 ether;
        return StonkzRouter.AggregatorLeg({
            // V3-only: StonkzRouter already wrapped + pushed WETH to the UR.
            // Recipient is MSG_SENDER (= StonkzRouter). payerIsUser=false spends
            // the UR's WETH balance.
            commands: CMD,
            inputs: _input(MSG_SENDER, ethIn, 0, false),
            deadline: block.timestamp + 300,
            amountIn: 0,
            quotedOut: quoted,
            maxSlippageBps: 50
        });
    }

    function _sellLeg(uint256 baseIn) internal view returns (StonkzRouter.AggregatorLeg memory) {
        uint256 quoted = (baseIn * 1 ether) / RATE;
        return StonkzRouter.AggregatorLeg({
            commands: CMD,
            // `payerIsUser = false`: the Universal Router spends the base the
            // Stonkz router just handed it.
            inputs: _input(MSG_SENDER, baseIn, 0, false),
            deadline: block.timestamp + 300,
            amountIn: baseIn,
            quotedOut: quoted,
            maxSlippageBps: 50
        });
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (StonkzRouter.PermitData memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                StonkzToken(token).PERMIT_TYPEHASH(),
                trader,
                address(router),
                value,
                StonkzToken(token).nonces(trader),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", StonkzToken(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(traderKey, digest);
        return StonkzRouter.PermitData(value, deadline, v, r, s);
    }

    /// Net base the curve will pay for `amount`, after its own fee.
    function _quoteSellNet(uint256 amount) internal view returns (uint256) {
        (CurveMath.SellFill memory fill,,) = pad.quoteSell(token, amount);
        return fill.netBase;
    }

    function _noPermit() internal pure returns (StonkzRouter.PermitData memory) {
        return StonkzRouter.PermitData(0, 0, 0, bytes32(0), bytes32(0));
    }

    /* ------------------------------------------------------------ happy buy */

    function test_AtomicBuyLandsTokensWithTheTraderInOneCall() public {
        uint256 ethIn = 1 ether;
        StonkzRouter.AggregatorLeg memory leg = _buyLeg(ethIn);

        uint256 ethBefore = trader.balance;
        vm.prank(trader);
        uint256 out = router.buyViaAggregator{value: ethIn}(token, leg, 0, block.timestamp + 600);

        assertGt(out, 0, "tokens delivered");
        assertEq(StonkzToken(token).balanceOf(trader), out, "and they are the trader's");
        assertEq(trader.balance, ethBefore - ethIn, "exactly the ETH sent was spent");

        // The base token was a transient intermediate. It must not have touched
        // the trader's wallet, which is the entire failure the two-step plan
        // suffered from.
        assertEq(base.balanceOf(trader), 0, "the trader never holds the base mint");

        // And the router keeps nothing.
        assertEq(base.balanceOf(address(router)), 0, "router holds no base");
        assertEq(StonkzToken(token).balanceOf(address(router)), 0, "router holds no token");
        assertEq(address(router).balance, 0, "router holds no eth");
    }

    function test_BuyRespectsTheCurveMinimumIndependently() public {
        StonkzRouter.AggregatorLeg memory leg = _buyLeg(1 ether);
        vm.prank(trader);
        uint256 fair = router.buyViaAggregator{value: 1 ether}(token, leg, 0, block.timestamp + 600);

        // The same trade demanding more than the curve can give fails on the
        // curve bound, not the aggregator's.
        StonkzRouter.AggregatorLeg memory leg2 = _buyLeg(1 ether);
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        router.buyViaAggregator{value: 1 ether}(token, leg2, fair * 2, block.timestamp + 600);
    }

    /* ----------------------------------------------------------- happy sell */

    /// A sell with a permit needs no prior `approve` transaction: the whole
    /// thing is one signature over the permit plus the one transaction.
    function test_AtomicSellWithPermitNeedsNoPriorApproval() public {
        vm.prank(trader);
        uint256 held =
            router.buyViaAggregator{value: 2 ether}(token, _buyLeg(2 ether), 0, block.timestamp + 600);

        uint256 toSell = held / 2;
        assertEq(StonkzToken(token).allowance(trader, address(router)), 0, "no standing allowance exists");

        uint256 baseOut = _quoteSellNet(toSell);
        StonkzRouter.AggregatorLeg memory leg = _sellLeg(baseOut);
        StonkzRouter.PermitData memory p = _permit(toSell, block.timestamp + 600);

        uint256 ethBefore = trader.balance;
        vm.prank(trader);
        uint256 ethOut = router.sellViaAggregator(token, toSell, p, 0, leg, 0, block.timestamp + 600);

        assertGt(ethOut, 0, "eth delivered");
        assertEq(trader.balance, ethBefore + ethOut, "and it reached the trader");
        assertEq(StonkzToken(token).balanceOf(trader), held - toSell, "only the sold tokens left");
        assertEq(base.balanceOf(trader), 0, "the trader never holds the base mint");
        assertEq(address(router).balance, 0, "router holds no eth");
        assertEq(base.balanceOf(address(router)), 0, "router holds no base");
    }

    /// The permit is single-use, so a replay of the same signature fails.
    function test_APermitCannotBeReplayed() public {
        vm.prank(trader);
        uint256 held =
            router.buyViaAggregator{value: 2 ether}(token, _buyLeg(2 ether), 0, block.timestamp + 600);

        uint256 toSell = held / 4;
        uint256 baseOut = _quoteSellNet(toSell);
        StonkzRouter.PermitData memory p = _permit(toSell, block.timestamp + 600);

        StonkzRouter.AggregatorLeg memory leg = _sellLeg(baseOut);
        vm.prank(trader);
        router.sellViaAggregator(token, toSell, p, 0, leg, 0, block.timestamp + 600);

        StonkzRouter.AggregatorLeg memory leg2 = _sellLeg(_quoteSellNet(toSell));
        vm.prank(trader);
        vm.expectRevert(bytes("bad signature"));
        router.sellViaAggregator(token, toSell, p, 0, leg2, 0, block.timestamp + 600);
    }

    /// A smart-contract account, or anyone who approved beforehand, skips the
    /// permit by passing a zero deadline.
    function test_SellWorksWithAStandingAllowanceAndNoPermit() public {
        vm.prank(trader);
        uint256 held =
            router.buyViaAggregator{value: 2 ether}(token, _buyLeg(2 ether), 0, block.timestamp + 600);

        uint256 toSell = held / 4;
        vm.prank(trader);
        StonkzToken(token).approve(address(router), type(uint256).max);

        StonkzRouter.AggregatorLeg memory leg = _sellLeg(_quoteSellNet(toSell));
        vm.prank(trader);
        uint256 ethOut =
            router.sellViaAggregator(token, toSell, _noPermit(), 0, leg, 0, block.timestamp + 600);
        assertGt(ethOut, 0);
    }

    /// If the curve beats its quote, the extra base belongs to the seller —
    /// not to this contract and not to the aggregator.
    function test_CurveSurplusGoesToTheSellerNotTheRouter() public {
        vm.prank(trader);
        uint256 held =
            router.buyViaAggregator{value: 3 ether}(token, _buyLeg(3 ether), 0, block.timestamp + 600);

        uint256 toSell = held / 4;
        uint256 baseOut = _quoteSellNet(toSell);
        // Quote the aggregator leg slightly short of what the curve will return.
        StonkzRouter.AggregatorLeg memory leg = _sellLeg(baseOut - 1_000);
        StonkzRouter.PermitData memory p = _permit(toSell, block.timestamp + 600);

        vm.prank(trader);
        router.sellViaAggregator(token, toSell, p, 0, leg, 0, block.timestamp + 600);

        assertEq(base.balanceOf(trader), 1_000, "the surplus is refunded to the seller");
        assertEq(base.balanceOf(address(router)), 0, "and none of it sticks here");
    }

    /* ------------------------------------------------------ atomicity: fail */

    /// The aggregator leg reverting must leave the curve completely untouched
    /// and the trader's ETH where it was.
    function test_AggregatorFailureNeverTouchesTheCurve() public {
        StonkzLaunchpad.Coin memory before_ = pad.coinInfo(token);
        uint256 ethBefore = trader.balance;

        ur.setReverting(true);
        vm.prank(trader);
        vm.expectRevert(MockUniversalRouter.Failed.selector);
        router.buyViaAggregator{value: 1 ether}(token, _buyLeg(1 ether), 0, block.timestamp + 600);

        StonkzLaunchpad.Coin memory after_ = pad.coinInfo(token);
        assertEq(after_.realToken, before_.realToken, "no tokens left the curve");
        assertEq(after_.realBase, before_.realBase, "no base entered it");
        assertEq(after_.protocolAccrued, before_.protocolAccrued, "no fee was taken");
        assertEq(trader.balance, ethBefore, "the trader still has every wei");
    }

    /// And the reverse: the curve leg reverting unwinds the aggregator swap.
    /// This is the case the two-step plan could not offer at all — there, a
    /// failed second step left the trader holding the base mint.
    function test_CurveFailureUnwindsTheAggregatorSwap() public {
        uint256 ethBefore = trader.balance;

        // Pause trading so the curve hop is the leg that fails.
        vm.prank(admin);
        pad.setPause(true, false, false, false, false);

        vm.prank(trader);
        vm.expectRevert(bytes("trading paused"));
        router.buyViaAggregator{value: 1 ether}(token, _buyLeg(1 ether), 0, block.timestamp + 600);

        assertEq(trader.balance, ethBefore, "the ETH never left");
        assertEq(base.balanceOf(trader), 0, "and no base was stranded on the trader");
        assertEq(base.balanceOf(address(router)), 0, "nor on the router");
        assertEq(StonkzToken(token).balanceOf(trader), 0, "and no tokens were delivered");
    }

    function test_CurveFailureOnSellReturnsTheTokens() public {
        vm.prank(trader);
        uint256 held =
            router.buyViaAggregator{value: 2 ether}(token, _buyLeg(2 ether), 0, block.timestamp + 600);

        uint256 toSell = held / 2;
        uint256 baseOut = _quoteSellNet(toSell);
        StonkzRouter.AggregatorLeg memory leg = _sellLeg(baseOut);
        StonkzRouter.PermitData memory p = _permit(toSell, block.timestamp + 600);

        // Demand more base than the curve will pay.
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        router.sellViaAggregator(token, toSell, p, baseOut * 2, leg, 0, block.timestamp + 600);

        assertEq(StonkzToken(token).balanceOf(trader), held, "the seller keeps every token");
        assertEq(StonkzToken(token).balanceOf(address(router)), 0, "none is stranded here");
    }

    /* --------------------------------------------------- the zero-fee bound */

    /// The invariant the API already asserts off-chain, enforced where the
    /// money actually is. A `portionBips` service fee attached to an API key is
    /// taken from the output token, so it presents as delivered-below-quoted.
    function test_ASmuggledAggregatorFeeReverts() public {
        // 1% skimmed from the output, against a 0.5% declared tolerance.
        ur.setFeeBps(100);
        StonkzRouter.AggregatorLeg memory leg = _buyLeg(1 ether);
        uint256 floor_ = router.shortfallFloor(leg.quotedOut, leg.maxSlippageBps);
        uint256 delivered = leg.quotedOut - (leg.quotedOut * 100) / 10_000;

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                StonkzRouter.AggregatorShortfall.selector, leg.quotedOut, floor_, delivered
            )
        );
        router.buyViaAggregator{value: 1 ether}(token, leg, 0, block.timestamp + 600);
    }

    /// A fee small enough to hide inside the declared tolerance is, by
    /// definition, inside the tolerance — the guard is a bound, not a detector.
    /// Worth pinning so nobody later mistakes it for one.
    function test_AFeeInsideTheDeclaredToleranceIsAccepted() public {
        ur.setFeeBps(10); // 0.1% against a 0.5% tolerance
        vm.prank(trader);
        uint256 out =
            router.buyViaAggregator{value: 1 ether}(token, _buyLeg(1 ether), 0, block.timestamp + 600);
        assertGt(out, 0);
    }

    /// The same bound applies to the sell leg's ETH output.
    function test_ASmuggledFeeOnTheSellLegAlsoReverts() public {
        vm.prank(trader);
        uint256 held =
            router.buyViaAggregator{value: 2 ether}(token, _buyLeg(2 ether), 0, block.timestamp + 600);

        uint256 toSell = held / 2;
        uint256 baseOut = _quoteSellNet(toSell);
        StonkzRouter.AggregatorLeg memory leg = _sellLeg(baseOut);
        StonkzRouter.PermitData memory p = _permit(toSell, block.timestamp + 600);

        // 2% skimmed from the ETH output, against a 0.5% declared tolerance.
        ur.setFeeBps(200);
        uint256 floor_ = router.shortfallFloor(leg.quotedOut, leg.maxSlippageBps);
        uint256 delivered = leg.quotedOut - (leg.quotedOut * 200) / 10_000;

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                StonkzRouter.AggregatorShortfall.selector, leg.quotedOut, floor_, delivered
            )
        );
        router.sellViaAggregator(token, toSell, p, 0, leg, 0, block.timestamp + 600);
    }

    /// The tolerance itself is bounded, so nobody can widen it until the check
    /// stops meaning anything.
    function test_TheToleranceCannotBeWidenedPastTheCap() public {
        StonkzRouter.AggregatorLeg memory leg = _buyLeg(1 ether);
        leg.maxSlippageBps = 10_000;
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.SlippageTooWide.selector, 10_000, 500));
        router.buyViaAggregator{value: 1 ether}(token, leg, 0, block.timestamp + 600);
    }

    /// The recipient sentinel is the one part of the opaque calldata that this
    /// contract's whole design depends on, and `docs/robinhood-chain.md` §3.3
    /// names the wrong one. `ADDRESS_THIS` leaves the output inside the
    /// Universal Router — a contract with no owner, where anyone may sweep it.
    /// The balance check catches it, so the mistake costs a reverted
    /// transaction rather than the trade.
    function test_AMisEncodedRecipientReverts() public {
        StonkzRouter.AggregatorLeg memory leg = _buyLeg(1 ether);
        leg.inputs = _input(ADDRESS_THIS, 1 ether, 0, false);

        uint256 floor_ = router.shortfallFloor(leg.quotedOut, leg.maxSlippageBps);
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(StonkzRouter.AggregatorShortfall.selector, leg.quotedOut, floor_, 0)
        );
        router.buyViaAggregator{value: 1 ether}(token, leg, 0, block.timestamp + 600);

        // And the base really did land in the Universal Router, which is the
        // loss this revert prevents.
        assertEq(base.balanceOf(address(router)), 0);
    }

    /// Sending the output straight to the trader — what the Trading API's own
    /// calldata does, and the root of the non-atomic fallback — is likewise
    /// caught rather than silently producing a half-finished trade.
    function test_ARecipientOfTheTraderReverts() public {
        StonkzRouter.AggregatorLeg memory leg = _buyLeg(1 ether);
        leg.inputs = _input(trader, 1 ether, 0, false);

        vm.prank(trader);
        vm.expectRevert();
        router.buyViaAggregator{value: 1 ether}(token, leg, 0, block.timestamp + 600);
    }

    /* ------------------------------------------------------------- surfaces */

    function test_RejectsAnUnknownToken() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.UnknownToken.selector, address(0xDEAD)));
        router.buyViaAggregator{value: 1 ether}(address(0xDEAD), _buyLeg(1 ether), 0, block.timestamp + 600);
    }

    function test_RejectsAnExpiredDeadline() public {
        vm.prank(trader);
        vm.expectRevert(StonkzRouter.DeadlineExpired.selector);
        router.buyViaAggregator{value: 1 ether}(token, _buyLeg(1 ether), 0, block.timestamp - 1);
    }

    function test_RejectsAZeroValueBuy() public {
        vm.prank(trader);
        vm.expectRevert(StonkzRouter.NothingIn.selector);
        router.buyViaAggregator{value: 0}(token, _buyLeg(1 ether), 0, block.timestamp + 600);
    }

    /// The router holds nothing between calls and has no rescue path, so a
    /// stray transfer would be lost. Refuse it instead of accepting it.
    function test_RefusesStrayEth() public {
        vm.prank(trader);
        vm.expectRevert(bytes("unexpected eth"));
        payable(address(router)).transfer(1 ether);
    }

    /// There is no owner, no pause and no sweep. Pinned so none appears later
    /// without a deliberate decision.
    function test_ExposesNoAdminSurface() public {
        string[5] memory sigs = [
            "owner()",
            "setUniversalRouter(address)",
            "setLaunchpad(address)",
            "sweep(address,uint256)",
            "pause()"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(router).call(abi.encodeWithSignature(sigs[i], address(1), uint256(1)));
            assertFalse(ok, "the router must expose no admin surface");
        }
    }

    /* -------------------------------------------------------- fork (opt-in) */

    /// @notice Runs against real Robinhood Chain contracts when an RPC is
    /// configured, and skips otherwise.
    /// @dev `docs/robinhood-chain.md` §12 is explicit that every Uniswap
    /// address on this chain should be re-read on-chain before mainnet rather
    /// than trusted from a registry, and §11.5 notes the public testnet's
    /// deployments do not match mainnet's. This test is the hook for that
    /// verification: `RH_RPC_URL=... forge test --match-test Fork`. It asserts
    /// only what a fork can tell us that a mock cannot — that the pinned
    /// Universal Router address actually holds code.
    function test_ForkUniversalRouterIsDeployed() public {
        string memory rpc = vm.envOr("RH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, RobinhoodChain.MAINNET_CHAIN_ID, "expected Robinhood Chain mainnet");

        assertGt(
            RobinhoodChain.UNIVERSAL_ROUTER.code.length,
            0,
            "Universal Router has no code at the pinned address"
        );
        assertGt(RobinhoodChain.PERMIT2.code.length, 0, "Permit2 has no code at the pinned address");
    }
}
