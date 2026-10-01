// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzLens} from "../src/StonkzLens.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {IStockAttestationSink, STOCK_ATTESTATION_MAGIC} from "../src/oracle/IStockAttestationSink.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockUniversalRouter, MockWETH, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {LegacyStonkzLaunchpad} from "./mocks/LegacyLaunchpad.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {UpgradeParams} from "../script/UpgradeParams.s.sol";
import {SetParams} from "../script/SetParams.s.sol";
import {SetRouterConfig} from "../script/SetRouterConfig.s.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev An attestation sink that only records what reached it.
contract RecordingSink is IStockAttestationSink {
    uint256 public count;
    bytes public last;

    function postAttestation(bytes calldata att) external returns (bool) {
        count++;
        last = att;
        return true;
    }
}

/// @notice The runtime parameters: `StonkzLaunchpad.setParams` (one packed
/// `CurveMath.Params` word), `setTrustedRouter`, and `StonkzRouter.setConfig`.
///
/// What is pinned here: the word is validated to the same bounds the Solana
/// program applies; a changed split lands in the vaults, the per-coin ledgers
/// and the `Trade` / `FeeAccrued` legs to the wei on the very next fill; the
/// cashback shape and the creator-fee / supply gates read the word; a new
/// graduation threshold reshapes *new* curves and moves the oracle trigger
/// for every coin, without touching an existing curve; and the router's knobs
/// move without a router redeploy, gated by the launchpad's admin.
contract ParamsTest is Test {
    StonkzLaunchpad pad;
    StonkzLens lens;
    StonkzRouter router;
    PushPriceSource oracle;
    MockERC20 base;
    MockWETH weth;
    MockUniversalRouter ur;
    MockSwapRouter02 sr02;

    address admin = address(0xA11CE);
    address oracleAuth = address(0x0AC1E);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);

    uint8 constant BASE_DECIMALS = 6;
    uint256 constant ONE = 10 ** BASE_DECIMALS;
    uint256 constant FILL = 400 * ONE;
    uint256 constant SUPPLY = 1_000_000_000;
    uint256 constant PYTH_FEE = 1e9;

    bytes32 constant TRADE = keccak256(
        "Trade(address,address,bool,uint256,uint256,uint16,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
    );
    bytes32 constant FEE_ACCRUED =
        keccak256("FeeAccrued(address,address,uint256,uint256,uint256,uint256,uint256)");

    event ParamsSet(uint256 params);
    event TrustedRouterSet(address router);
    event ConfigSet(uint256 maxBuyNative, address pyth, address attestationSink);

    function setUp() public {
        vm.warp(1_800_000_000);
        base = new MockERC20("Global Dollar", "USDG", BASE_DECIMALS);
        weth = new MockWETH();
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, admin, admin, oracle, admin);
        lens = new StonkzLens();

        ur = new MockUniversalRouter(weth, base, 3_000e6);
        sr02 = new MockSwapRouter02(weth, base, 3_000e6);
        router = _router(0, IPyth(address(0)), IStockAttestationSink(address(0)));
        // As deployed: the implementation's constructor names the router.
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        vm.prank(admin);
        pad.upgradeToAndCall(address(impl), "");

        vm.startPrank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);
        oracle.pushPrice(address(weth), 3_000e6, 0);
        vm.stopPrank();

        for (uint256 i = 0; i < 2; i++) {
            address who = [trader, creator][i];
            base.mint(who, 5_000_000 * ONE);
            vm.prank(who);
            base.approve(address(pad), type(uint256).max);
        }
        vm.deal(trader, 100 ether);
        vm.deal(creator, 100 ether);
    }

    /* -------------------------------------------------------------- helpers */

    function _router(uint256 cap, IPyth pyth, IStockAttestationSink sink) internal returns (StonkzRouter) {
        return new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            cap,
            pyth,
            sink
        );
    }

    function _defaults() internal pure returns (CurveMath.Params memory) {
        return CurveMath.unpack(CurveMath.DEFAULT_PARAMS);
    }

    function _set(CurveMath.Params memory p) internal returns (uint256 w) {
        w = CurveMath.pack(p);
        vm.prank(admin);
        pad.setParams(w);
    }

    function _launch(string memory ticker, uint16 feeBps, bool cashback) internal returns (address) {
        vm.prank(creator);
        return pad.createToken("Coin", ticker, "ipfs://x", SUPPLY, address(base), feeBps, cashback);
    }

    function _create(string memory ticker, address baseToken)
        internal
        pure
        returns (StonkzRouter.CreateParams memory)
    {
        return StonkzRouter.CreateParams("Coin", ticker, "ipfs://x", SUPPLY, baseToken, 250, false);
    }

    function _none() internal pure returns (bytes[] memory u) {
        u = new bytes[](0);
    }

    function _pythUpdate() internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encode(bytes32(uint256(1)), int64(1e8), uint64(0), int32(-8), uint256(1_800_000_000));
    }

    function _attestation() internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encode(STOCK_ATTESTATION_MAGIC, address(0xBA5E), uint64(1e6), uint64(1), bytes(""));
    }

    /// Word `i` of an event's data (every field here is static).
    function _word(bytes memory data, uint256 i) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(data, 32), mul(i, 32)))
        }
    }

    function _expectRejected(CurveMath.Params memory p) internal {
        uint256 w = CurveMath.pack(p);
        assertFalse(CurveMath.validParams(w), "validParams must refuse it");
        vm.prank(admin);
        vm.expectRevert(bytes("params"));
        pad.setParams(w);
    }

    /* ---------------------------------------------------- (a) validation */

    function test_SetParamsRejectsNonAdmin() public {
        vm.prank(trader);
        vm.expectRevert(bytes("not admin"));
        pad.setParams(CurveMath.DEFAULT_PARAMS);
        vm.prank(trader);
        vm.expectRevert(bytes("not admin"));
        pad.setTrustedRouter(trader);
        assertEq(pad.paramsWord(), CurveMath.DEFAULT_PARAMS);
    }

    function test_SetParamsRejectsEachInvalidWord() public {
        CurveMath.Params memory p;

        // The three treasury legs may not exceed the whole fee.
        p = _defaults();
        (p.feeProtocolBps, p.feeOpsBps, p.feeBurnBps) = (5_000, 3_000, 2_001);
        _expectRejected(p);

        p = _defaults();
        (p.minFeeBps, p.maxFeeBps) = (600, 500);
        _expectRejected(p);

        // `maxFeeBps` is the "set" sentinel: never zero.
        p = _defaults();
        (p.minFeeBps, p.maxFeeBps) = (0, 0);
        _expectRejected(p);

        p = _defaults();
        (p.maxFeeBps, p.cbStartFeeBps) = (6_000, 5_000);
        _expectRejected(p);

        p = _defaults();
        p.cbStartFeeBps = 10_001;
        _expectRejected(p);

        p = _defaults();
        p.cbWindowSecs = 0;
        _expectRejected(p);

        p = _defaults();
        p.gradMcapUsd1e6 = 0;
        _expectRejected(p);

        p = _defaults();
        p.maxSupply = 0;
        _expectRejected(p);

        p = _defaults();
        p.maxSupply = uint64(CurveMath.MAX_SUPPLY + 1);
        _expectRejected(p);

        // Boundaries are inclusive.
        p = _defaults();
        (p.feeProtocolBps, p.feeOpsBps, p.feeBurnBps) = (5_000, 3_000, 2_000);
        (p.minFeeBps, p.maxFeeBps, p.cbStartFeeBps) = (10_000, 10_000, 10_000);
        p.cbWindowSecs = 1;
        p.gradMcapUsd1e6 = 1;
        p.maxSupply = uint64(CurveMath.MAX_SUPPLY);
        assertTrue(CurveMath.validParams(CurveMath.pack(p)));
        _set(p);
        assertEq(pad.paramsWord(), CurveMath.pack(p));
    }

    /* --------------------------------------------------- (b) fee split */

    /// A changed split moves the vaults, the per-coin ledgers and the event
    /// legs on the next buy and the next sell, exactly per `splitFee(fee, w)`,
    /// for a coin that already existed — the split is a fill-time decision.
    function test_ANewSplitLandsInTheVaultsAndEventsOnTheNextFill() public {
        address token = _launch("SPLIT", 250, false);
        _buy(token, FILL / 4); // one fill under the defaults first

        CurveMath.Params memory p = _defaults();
        (p.feeProtocolBps, p.feeOpsBps, p.feeBurnBps) = (2_000, 500, 500);
        uint256 w = _set(p);

        // --- buy
        (CurveMath.BuyFill memory q, CurveMath.FeeShares memory quoted,) = lens.quoteBuy(pad, token, FILL);
        CurveMath.FeeShares memory want = CurveMath.splitFee(q.fee, w);
        assertEq(keccak256(abi.encode(quoted)), keccak256(abi.encode(want)), "the lens quotes the new split");
        assertTrue(want.protocol != CurveMath.splitFee(q.fee).protocol, "the split really changed");
        assertEq(CurveMath.feeOf(want), q.fee, "feeOf == fee");

        Snap memory s0 = _snap(token);
        vm.recordLogs();
        _buy(token, FILL);
        _assertFillSplit(token, s0, q.fee, want, vm.getRecordedLogs());

        // --- sell
        uint256 held = StonkzToken(token).balanceOf(trader);
        (CurveMath.SellFill memory sq,,) = lens.quoteSell(pad, token, held / 2);
        want = CurveMath.splitFee(sq.fee, w);
        assertEq(CurveMath.feeOf(want), sq.fee, "feeOf == fee (sell)");
        s0 = _snap(token);
        vm.startPrank(trader);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        vm.recordLogs();
        pad.sell(token, held / 2, 0);
        vm.stopPrank();
        _assertFillSplit(token, s0, sq.fee, want, vm.getRecordedLogs());
    }

    struct Snap {
        uint256 protocol;
        uint256 ops;
        uint256 burn;
        StonkzLaunchpad.Coin coin;
    }

    function _snap(address token) internal view returns (Snap memory s) {
        s.protocol = pad.protocolRevenue(address(base));
        s.ops = pad.stonkzOps(address(base));
        s.burn = pad.stonkzBurn(address(base));
        s.coin = pad.coinInfo(token);
    }

    function _buy(address token, uint256 amount) internal returns (uint256) {
        vm.prank(trader);
        return pad.buy(token, amount, 0);
    }

    function _assertFillSplit(
        address token,
        Snap memory s0,
        uint256 fee,
        CurveMath.FeeShares memory want,
        Vm.Log[] memory logs
    ) internal view {
        // Vaults.
        assertEq(pad.protocolRevenue(address(base)) - s0.protocol, want.protocol, "protocol vault");
        assertEq(pad.stonkzOps(address(base)) - s0.ops, want.stonkzOps, "ops vault");
        assertEq(pad.stonkzBurn(address(base)) - s0.burn, want.burn, "burn vault");
        // Per-coin ledgers.
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.protocolAccrued - s0.coin.protocolAccrued, want.protocol, "protocolAccrued");
        assertEq(c.opsAccrued - s0.coin.opsAccrued, want.stonkzOps, "opsAccrued");
        assertEq(c.burnAccrued - s0.coin.burnAccrued, want.burn, "burnAccrued");
        assertEq(c.creatorBucketAccrued - s0.coin.creatorBucketAccrued, want.creatorBucket, "bucketAccrued");
        // Events.
        bool sawTrade;
        bool sawFee;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(pad)) continue;
            if (logs[i].topics[0] == TRADE) {
                sawTrade = true;
                assertEq(_word(logs[i].data, 5), fee, "Trade.feeTotal");
                assertEq(_word(logs[i].data, 6), want.protocol, "Trade.feeProtocol");
                assertEq(_word(logs[i].data, 7), want.stonkzOps, "Trade.feeOps");
                assertEq(_word(logs[i].data, 8), want.burn, "Trade.feeBurn");
                assertEq(_word(logs[i].data, 9), want.creatorBucket, "Trade.feeCreatorBucket");
            } else if (logs[i].topics[0] == FEE_ACCRUED) {
                sawFee = true;
                assertEq(_word(logs[i].data, 0), fee, "FeeAccrued.feeTotal");
                assertEq(_word(logs[i].data, 1), want.protocol, "FeeAccrued.protocol");
                assertEq(_word(logs[i].data, 2), want.stonkzOps, "FeeAccrued.ops");
                assertEq(_word(logs[i].data, 3), want.burn, "FeeAccrued.burn");
                assertEq(_word(logs[i].data, 4), want.creatorBucket, "FeeAccrued.creatorBucket");
                assertEq(
                    _word(logs[i].data, 1) + _word(logs[i].data, 2) + _word(logs[i].data, 3)
                        + _word(logs[i].data, 4),
                    fee,
                    "the four legs reconstruct the fee"
                );
            }
        }
        assertTrue(sawTrade && sawFee, "both events emitted");
    }

    /* ------------------------------------------------------ (c) cashback */

    function test_EffFeeHonoursANewWindowAndStartFee() public {
        CurveMath.Params memory p = _defaults();
        p.cbStartFeeBps = 3_000;
        p.cbWindowSecs = 600;
        _set(p);

        address token = _launch("CB", 100, true);
        (,, uint16 bps0) = lens.quoteBuy(pad, token, ONE);
        assertEq(bps0, 3_000, "opens at the new start fee");
        vm.warp(block.timestamp + 300);
        (,, uint16 bpsMid) = lens.quoteBuy(pad, token, ONE);
        assertEq(bpsMid, 100 + (2_900 * 300) / 600, "halfway through the new window");
        vm.warp(block.timestamp + 300);
        (,, uint16 bpsEnd) = lens.quoteBuy(pad, token, ONE);
        assertEq(bpsEnd, 100, "settles at the creator fee after the new window");

        // The fill itself charges what the quote says.
        vm.warp(block.timestamp - 450); // 150 s in: 100 + 2900 * 450 / 600
        (CurveMath.BuyFill memory q,, uint16 bpsFill) = lens.quoteBuy(pad, token, FILL / 4);
        assertEq(bpsFill, 100 + (2_900 * 450) / 600);
        assertEq(q.fee, ((FILL / 4) * bpsFill) / 10_000);
        vm.recordLogs();
        _buy(token, FILL / 4);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(pad) && logs[i].topics[0] == TRADE) {
                assertEq(_word(logs[i].data, 3), bpsFill, "Trade.effFeeBps");
                assertEq(_word(logs[i].data, 5), q.fee, "Trade.feeTotal");
            }
        }
    }

    /// A coin launched under a higher ceiling than the new word's keeps
    /// decaying toward its own fee and never below it: `start < base` clamps.
    function test_ACoinAboveTheNewCeilingDecaysTowardItsOwnFeeNeverBelow() public {
        address token = _launch("OLDMAX", 500, true); // the default ceiling
        (,, uint16 at0) = lens.quoteBuy(pad, token, ONE);
        assertEq(at0, 5_000);

        CurveMath.Params memory p = _defaults();
        (p.minFeeBps, p.maxFeeBps, p.cbStartFeeBps) = (100, 300, 300);
        _set(p);

        // The new start (300) sits under this coin's base (500): no decay, no dip.
        (,, uint16 now0) = lens.quoteBuy(pad, token, ONE);
        assertEq(now0, 500, "clamped to its own fee");
        vm.warp(block.timestamp + 150);
        (,, uint16 mid) = lens.quoteBuy(pad, token, ONE);
        assertEq(mid, 500);
        vm.warp(block.timestamp + 10_000);
        (,, uint16 late) = lens.quoteBuy(pad, token, ONE);
        assertEq(late, 500);
        // And it still trades at that fee.
        (CurveMath.BuyFill memory q,,) = lens.quoteBuy(pad, token, FILL / 8);
        assertEq(q.fee, ((FILL / 8) * 500) / 10_000);
        assertGt(_buy(token, FILL / 8), 0);

        // A start between the new ceiling and the old fee behaves the same way.
        (p.maxFeeBps, p.cbStartFeeBps) = (300, 400);
        _set(p);
        (,, uint16 still) = lens.quoteBuy(pad, token, ONE);
        assertEq(still, 500, "start 400 < base 500: still clamped");
    }

    /* ------------------------------------------------ (d) createToken */

    function test_NewFeeBoundsAndSupplyCapGateCreateToken() public {
        // Under the defaults: 100..500 bps, up to 1e12 whole tokens.
        vm.prank(creator);
        pad.createToken("Coin", "WIDE", "u", 1_000_000_000_000, address(base), 100, false);

        CurveMath.Params memory p = _defaults();
        (p.minFeeBps, p.maxFeeBps) = (200, 300);
        p.maxSupply = 1_000_000_000;
        _set(p);

        vm.startPrank(creator);
        vm.expectRevert(bytes("fee"));
        pad.createToken("Coin", "LOW", "u", SUPPLY, address(base), 199, false);
        vm.expectRevert(bytes("fee"));
        pad.createToken("Coin", "HIGH", "u", SUPPLY, address(base), 301, false);
        vm.expectRevert(bytes("supply"));
        pad.createToken("Coin", "BIG", "u", 1_000_000_001, address(base), 250, false);
        pad.createToken("Coin", "MIN", "u", SUPPLY, address(base), 200, false);
        pad.createToken("Coin", "MAX", "u", 1_000_000_000, address(base), 300, false);
        vm.stopPrank();

        // The same gates through the router (`createTokenFor`).
        vm.prank(creator);
        vm.expectRevert(bytes("fee"));
        router.createWithPriceUpdate(
            StonkzRouter.CreateParams("Coin", "RLOW", "u", SUPPLY, address(base), 100, false),
            _none(),
            block.timestamp + 60
        );
    }

    /* ------------------------------------------------- (e) graduation */

    function test_NewGradMcapReshapesNewCurvesAndMovesTheOracleTrigger() public {
        address old = _launch("OLD", 250, false);
        StonkzLaunchpad.Coin memory oc = pad.coinInfo(old);
        assertEq(oc.gradMcapBase, CurveMath.gradMcapBaseAtoms(1_000_000, BASE_DECIMALS), "$69K in USDG atoms");

        CurveMath.Params memory p = _defaults();
        p.gradMcapUsd1e6 = 138_000_000_000; // $138,000
        _set(p);

        // A new coin is shaped around the new threshold; the old one is untouched.
        address fresh = _launch("NEW", 250, false);
        StonkzLaunchpad.Coin memory nc = pad.coinInfo(fresh);
        CurveMath.CurveParams memory want =
            CurveMath.deriveCurve(SUPPLY * 1e18, 1_000_000, BASE_DECIMALS, 138_000_000_000);
        assertEq(nc.gradMcapBase, want.gradMcapBase);
        assertEq(nc.gradMcapBase, 2 * oc.gradMcapBase, "twice the base to graduate");
        assertEq(nc.virtualBase, want.virtualBase);
        assertEq(nc.virtualBase, CurveMath.ceilDiv(nc.gradMcapBase, 15));
        assertEq(nc.k, want.k);
        assertEq(nc.virtualToken, oc.virtualToken, "the token side of the shape is not a parameter");
        assertEq(nc.tokensForSale, oc.tokensForSale);
        assertEq(pad.coinInfo(old).gradMcapBase, oc.gradMcapBase, "existing curve unchanged");
        assertEq(pad.coinInfo(old).virtualBase, oc.virtualBase);

        // The oracle trigger of the OLD coin now needs $138K, not $69K.
        _buy(old, FILL);
        (uint256 mcap,) = lens.marketCap(pad, old);
        uint256 price69k = (CurveMath.GRAD_MCAP_USD_1E6 * 10 ** BASE_DECIMALS) / mcap + 1;
        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), price69k, 0);
        uint256 usd = CurveMath.mcapUsd1e6(mcap, price69k, BASE_DECIMALS);
        assertGe(usd, CurveMath.GRAD_MCAP_USD_1E6);
        assertLt(usd, 138_000_000_000);
        vm.expectRevert(bytes("not graduable"));
        pad.graduate(old);

        // Back to the defaults: the same price now clears the bar.
        vm.prank(admin);
        pad.setParams(CurveMath.DEFAULT_PARAMS);
        pad.graduate(old);
        assertEq(pad.coinInfo(old).graduationReason, 1, "graduated on price");
    }

    /* ------------------------------------------------ (f) event + views */

    function test_ParamsSetIsEmittedAndTheLensDecodesTheWord() public {
        CurveMath.Params memory p = _defaults();
        p.cbWindowSecs = 900;
        uint256 w = CurveMath.pack(p);
        vm.expectEmit(address(pad));
        emit ParamsSet(w);
        vm.prank(admin);
        pad.setParams(w);
        assertEq(pad.paramsWord(), w);
        CurveMath.Params memory got = lens.params(pad);
        assertEq(got.cbWindowSecs, 900);
        assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(p)));
    }

    /* ------------------------------------------------- (g) pack/unpack */

    function testFuzz_PackUnpackRoundTrips(uint256 w) public pure {
        assertEq(CurveMath.pack(CurveMath.unpack(w)), w);
    }

    function testFuzz_PackOfFieldsUnpacksToTheSameFields(CurveMath.Params memory p) public pure {
        CurveMath.Params memory q = CurveMath.unpack(CurveMath.pack(p));
        assertEq(keccak256(abi.encode(q)), keccak256(abi.encode(p)));
    }

    function test_DefaultParamsAreTheConstants() public pure {
        CurveMath.Params memory p = CurveMath.unpack(CurveMath.DEFAULT_PARAMS);
        assertEq(p.feeProtocolBps, CurveMath.FEE_PROTOCOL_BPS);
        assertEq(p.feeOpsBps, CurveMath.FEE_OPS_BPS);
        assertEq(p.feeBurnBps, CurveMath.FEE_BURN_BPS);
        assertEq(p.minFeeBps, CurveMath.MIN_FEE_BPS);
        assertEq(p.maxFeeBps, CurveMath.MAX_FEE_BPS);
        assertEq(p.cbStartFeeBps, CurveMath.CB_START_FEE_BPS);
        assertEq(p.cbWindowSecs, CurveMath.CB_WINDOW_SECS);
        assertEq(p.gradMcapUsd1e6, CurveMath.GRAD_MCAP_USD_1E6);
        assertEq(p.maxSupply, CurveMath.MAX_SUPPLY);
        assertTrue(CurveMath.validParams(CurveMath.DEFAULT_PARAMS));
        // The accessors agree with the struct.
        uint256 w = CurveMath.DEFAULT_PARAMS;
        assertEq(CurveMath.pFeeProtocolBps(w), 1_500);
        assertEq(CurveMath.pFeeOpsBps(w), 1_000);
        assertEq(CurveMath.pFeeBurnBps(w), 600);
        assertEq(CurveMath.pMinFeeBps(w), 100);
        assertEq(CurveMath.pMaxFeeBps(w), 500);
        assertEq(CurveMath.pCbStartFeeBps(w), 5_000);
        assertEq(CurveMath.pCbWindowSecs(w), 300);
        assertEq(CurveMath.pGradMcapUsd1e6(w), 69_000_000_000);
        assertEq(CurveMath.pMaxSupply(w), 1e12);
        // The default-forwarding overloads are the explicit-word ones at `DEFAULT_PARAMS`.
        assertEq(
            keccak256(abi.encode(CurveMath.splitFee(12_345))),
            keccak256(abi.encode(CurveMath.splitFee(12_345, w)))
        );
        assertEq(
            CurveMath.effFeeBps(250, true, 1_000, 1_150), CurveMath.effFeeBps(250, true, 1_000, 1_150, w)
        );
    }

    /* ------------------------------------------- (h) router setConfig */

    function test_SetConfigIsGatedByTheLaunchpadAdmin() public {
        MockPyth pyth = new MockPyth(PYTH_FEE);
        RecordingSink sink = new RecordingSink();
        vm.prank(trader);
        vm.expectRevert(StonkzRouter.NotAdmin.selector);
        router.setConfig(1 ether, IPyth(address(pyth)), IStockAttestationSink(address(sink)));

        vm.expectEmit(address(router));
        emit ConfigSet(1 ether, address(pyth), address(sink));
        vm.prank(admin);
        router.setConfig(1 ether, IPyth(address(pyth)), IStockAttestationSink(address(sink)));
        assertEq(router.maxBuyNative(), 1 ether);
        assertEq(address(router.pyth()), address(pyth));
        assertEq(address(router.attestationSink()), address(sink));

        // The gate follows the launchpad's admin, not a key of the router's own.
        address next = address(0xBEEF2);
        vm.prank(admin);
        pad.proposeAdmin(next);
        vm.prank(next);
        pad.acceptAdmin();
        vm.prank(admin);
        vm.expectRevert(StonkzRouter.NotAdmin.selector);
        router.setConfig(0, IPyth(address(0)), IStockAttestationSink(address(0)));
        vm.prank(next);
        router.setConfig(0, IPyth(address(0)), IStockAttestationSink(address(0)));
        assertEq(router.maxBuyNative(), 0);
    }

    function test_ANewCapAppliesToTheNextBuyWithEth() public {
        vm.prank(creator);
        address token = pad.createToken("Coin", "WETH1", "u", SUPPLY, address(weth), 250, false);
        vm.prank(trader);
        router.buyWithEth{value: 1 ether}(token, 0, block.timestamp + 60);

        vm.prank(admin);
        router.setConfig(0.5 ether, IPyth(address(0)), IStockAttestationSink(address(0)));
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StonkzRouter.BuyAboveCap.selector, 1 ether, 0.5 ether));
        router.buyWithEth{value: 1 ether}(token, 0, block.timestamp + 60);
        vm.prank(trader);
        assertGt(router.buyWithEth{value: 0.5 ether}(token, 0, block.timestamp + 60), 0);

        // Lifting it again lifts it.
        vm.prank(admin);
        router.setConfig(0, IPyth(address(0)), IStockAttestationSink(address(0)));
        vm.prank(trader);
        assertGt(router.buyWithEth{value: 1 ether}(token, 0, block.timestamp + 60), 0);
    }

    function test_ANewPythAppliesToTheNextCreateWithPriceUpdate() public {
        // Built without Pyth: a non-empty update has nowhere to go.
        vm.prank(creator);
        vm.expectRevert(StonkzRouter.NoPyth.selector);
        router.createWithPriceUpdate{value: PYTH_FEE}(
            _create("P0", address(base)), _pythUpdate(), block.timestamp + 60
        );

        MockPyth pyth1 = new MockPyth(PYTH_FEE);
        vm.prank(admin);
        router.setConfig(0, IPyth(address(pyth1)), IStockAttestationSink(address(0)));
        vm.prank(creator);
        router.createWithPriceUpdate{value: PYTH_FEE}(
            _create("P1", address(base)), _pythUpdate(), block.timestamp + 60
        );
        assertEq(pyth1.updates(), 1, "posted to the new Pyth");

        MockPyth pyth2 = new MockPyth(PYTH_FEE);
        vm.prank(admin);
        router.setConfig(0, IPyth(address(pyth2)), IStockAttestationSink(address(0)));
        vm.prank(creator);
        router.createWithPriceUpdate{value: PYTH_FEE}(
            _create("P2", address(base)), _pythUpdate(), block.timestamp + 60
        );
        assertEq(pyth1.updates(), 1, "the old one sees nothing more");
        assertEq(pyth2.updates(), 1, "the swap applies to the next launch");
    }

    function test_ANewAttestationSinkRoutesStkaEntries() public {
        // No sink: STKA entries are dropped, never sent to Pyth (none here), no fee.
        vm.prank(creator);
        router.createWithPriceUpdate(_create("S0", address(base)), _attestation(), block.timestamp + 60);

        RecordingSink sink1 = new RecordingSink();
        vm.prank(admin);
        router.setConfig(0, IPyth(address(0)), IStockAttestationSink(address(sink1)));
        vm.prank(creator);
        router.createWithPriceUpdate(_create("S1", address(base)), _attestation(), block.timestamp + 60);
        assertEq(sink1.count(), 1, "routed to the new sink");
        assertEq(keccak256(sink1.last()), keccak256(_attestation()[0]));

        RecordingSink sink2 = new RecordingSink();
        vm.prank(admin);
        router.setConfig(0, IPyth(address(0)), IStockAttestationSink(address(sink2)));
        vm.prank(creator);
        router.createWithPriceUpdate(_create("S2", address(base)), _attestation(), block.timestamp + 60);
        assertEq(sink1.count(), 1, "the old sink sees nothing more");
        assertEq(sink2.count(), 1, "the swap applies to the next launch");
    }

    /* --------------------------------------------- (i) setTrustedRouter */

    function test_SetTrustedRouterSwapsWhoMayCreateTokenFor() public {
        StonkzRouter next = _router(0, IPyth(address(0)), IStockAttestationSink(address(0)));
        assertEq(pad.trustedRouter(), address(router), "the constructor default");

        vm.prank(creator);
        vm.expectRevert(bytes("not router"));
        next.createWithPriceUpdate(_create("R0", address(base)), _none(), block.timestamp + 60);

        vm.expectEmit(address(pad));
        emit TrustedRouterSet(address(next));
        vm.prank(admin);
        pad.setTrustedRouter(address(next));
        assertEq(pad.trustedRouter(), address(next));

        vm.prank(creator);
        address token =
            next.createWithPriceUpdate(_create("R1", address(base)), _none(), block.timestamp + 60);
        assertEq(pad.coinInfo(token).creator, creator, "the user, not the router, is the creator");
        vm.prank(creator);
        vm.expectRevert(bytes("not router"));
        router.createWithPriceUpdate(_create("R2", address(base)), _none(), block.timestamp + 60);
        // The old router's trade paths keep working.
        vm.prank(creator);
        address wethCoin = pad.createToken("Coin", "WETH2", "u", SUPPLY, address(weth), 250, false);
        vm.prank(trader);
        assertGt(router.buyWithEth{value: 0.1 ether}(wethCoin, 0, block.timestamp + 60), 0);

        // Zero restores the constructor default.
        vm.prank(admin);
        pad.setTrustedRouter(address(0));
        assertEq(pad.trustedRouter(), address(router));
        vm.prank(creator);
        router.createWithPriceUpdate(_create("R3", address(base)), _none(), block.timestamp + 60);
        vm.prank(creator);
        vm.expectRevert(bytes("not router"));
        next.createWithPriceUpdate(_create("R4", address(base)), _none(), block.timestamp + 60);
    }
}

/// @notice The operator scripts against a proxy set up the way RH 46630's is
/// today: the pre-parameter implementation (`LegacyStonkzLaunchpad`) trusting
/// a router, an EOA admin, a live coin. (`MainnetGuard.t.sol` owns the
/// mainnet "print, never call" path.)
contract ParamsScriptsTest is Test {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 constant ADMIN_KEY = 0xAD814; // test-only key
    address admin;
    address creator = address(0xC4EA7);
    StonkzLaunchpad pad; // the proxy, typed as the new ABI where that is what is being read
    LegacyStonkzLaunchpad legacy;
    StonkzRouter current;
    MockERC20 base;
    MockPyth pyth;
    RecordingSink sink;
    address token;

    function setUp() public {
        vm.chainId(46630);
        vm.warp(1_800_000_000);
        admin = vm.addr(ADMIN_KEY);
        base = new MockERC20("Global Dollar", "USDG", 6);
        PushPriceSource oracle = DeployPad.pushOracle(admin, admin, 90_000);
        vm.prank(admin);
        oracle.pushPrice(address(base), 1_000_000, 0);

        // The proxy as deployed before this upgrade: legacy implementation,
        // trusting a router that carries a Pyth and a sink.
        pyth = new MockPyth(1e9);
        sink = new RecordingSink();
        LegacyStonkzLaunchpad bare = new LegacyStonkzLaunchpad(address(0));
        address proxy = address(
            new ERC1967Proxy(
                address(bare),
                abi.encodeCall(
                    LegacyStonkzLaunchpad.initialize, (admin, address(0xC01D1), admin, oracle, admin)
                )
            )
        );
        legacy = LegacyStonkzLaunchpad(proxy);
        pad = StonkzLaunchpad(proxy);
        MockWETH weth = new MockWETH();
        current = new StonkzRouter(
            IUniversalRouter(address(new MockUniversalRouter(weth, base, 3_000e6))),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(new MockSwapRouter02(weth, base, 3_000e6))),
            0.25 ether,
            IPyth(address(pyth)),
            IStockAttestationSink(address(sink))
        );
        LegacyStonkzLaunchpad trusting = new LegacyStonkzLaunchpad(address(current));
        vm.prank(admin);
        legacy.upgradeToAndCall(address(trusting), "");
        assertEq(legacy.trustedRouter(), address(current));

        vm.prank(creator);
        token = legacy.createToken("Coin", "LIVE", "u", 1_000_000_000, address(base), 250, false);
        base.mint(creator, 1_000e6);
        vm.startPrank(creator);
        base.approve(proxy, type(uint256).max);
        legacy.buy(token, 100e6, 0);
        vm.stopPrank();
    }

    function _snapshot() internal view returns (bytes32[19] memory before) {
        for (uint256 i = 0; i < 19; i++) {
            before[i] = vm.load(address(pad), bytes32(i));
        }
    }

    /// The plain upgrade: no word, no router. Defaults in force, the router
    /// carried over by the constructor, nothing in slots 17/18, the lens
    /// quoting the live coin.
    function test_UpgradeParamsUpgradesInPlaceWithDefaultsAndNoMigration() public {
        bytes32[19] memory before = _snapshot();
        bytes32 oldCoin = keccak256(abi.encode(legacy.coinInfo(token)));
        UpgradeParams s = new UpgradeParams();
        UpgradeParams.Params memory p = s.defaults(address(pad));
        assertEq(p.cap, 0.25 ether, "defaults read the current router's cap");
        assertEq(p.pyth, address(pyth), "...its Pyth");
        assertEq(p.attestationSink, address(sink), "...and its sink");
        p.smokeToken = token;
        UpgradeParams.Result memory r = s.execute(p, ADMIN_KEY);

        assertTrue(r.upgraded);
        assertEq(
            address(uint160(uint256(vm.load(address(pad), IMPL_SLOT)))), r.impl, "implementation swapped"
        );
        assertEq(r.router, address(current), "no new router");
        assertEq(r.previousRouter, address(current));
        assertEq(pad.trustedRouter(), address(current), "constructor default carries the router");
        assertEq(pad.paramsWord(), CurveMath.DEFAULT_PARAMS);
        for (uint256 i = 0; i < 19; i++) {
            assertEq(vm.load(address(pad), bytes32(i)), before[i], "a storage slot moved");
        }
        assertEq(keccak256(abi.encode(pad.coinInfo(token))), oldCoin, "coin intact");
        (CurveMath.BuyFill memory q,,) = StonkzLens(r.lens).quoteBuy(pad, token, 10e6);
        assertGt(q.tokensOut, 0, "the lens quotes the live coin");
        vm.prank(creator);
        assertEq(pad.buy(token, 10e6, q.tokensOut), q.tokensOut, "and the quote is the fill");
    }

    /// With `PARAMS_WORD` and `DEPLOY_ROUTER=1`: the word lands in slot 17,
    /// a new router (same Pyth and sink as the old one) in slot 18, and the
    /// old router loses `createTokenFor` while keeping its trade paths.
    function test_UpgradeParamsSetsTheWordAndSwapsTheRouter() public {
        bytes32[19] memory before = _snapshot();
        UpgradeParams s = new UpgradeParams();
        UpgradeParams.Params memory p = s.defaults(address(pad));
        CurveMath.Params memory want = CurveMath.unpack(CurveMath.DEFAULT_PARAMS);
        (want.feeProtocolBps, want.feeOpsBps, want.feeBurnBps) = (2_000, 500, 500);
        p.paramsWord = CurveMath.pack(want);
        p.deployRouter = true;
        UpgradeParams.Result memory r = s.execute(p, ADMIN_KEY);

        assertTrue(r.upgraded);
        assertTrue(r.router != address(current) && r.router.code.length > 0, "a new router");
        assertEq(pad.trustedRouter(), r.router, "the proxy trusts the new router (slot 18)");
        assertEq(address(uint160(uint256(vm.load(address(pad), bytes32(uint256(18)))))), r.router);
        assertEq(StonkzLaunchpad(r.impl).trustedRouter(), address(current), "impl default is the OLD router");
        assertEq(pad.paramsWord(), p.paramsWord);
        assertEq(uint256(vm.load(address(pad), bytes32(uint256(17)))), p.paramsWord);
        for (uint256 i = 0; i < 17; i++) {
            assertEq(vm.load(address(pad), bytes32(i)), before[i], "a pre-existing slot moved");
        }
        StonkzRouter nr = StonkzRouter(payable(r.router));
        assertEq(address(nr.pyth()), address(pyth), "same Pyth as the old router");
        assertEq(address(nr.attestationSink()), address(sink), "same sink as the old router");
        assertEq(nr.maxBuyNative(), 0.25 ether, "same cap as the old router");
        assertEq(address(nr.weth()), RobinhoodChainTestnet.WETH9, "chain wiring from RouterWiring");
        assertEq(address(nr.universalRouter()), RobinhoodChainTestnet.UNIVERSAL_ROUTER);

        StonkzRouter.CreateParams memory c =
            StonkzRouter.CreateParams("Coin", "NEXT", "u", 1_000_000_000, address(base), 250, false);
        vm.prank(creator);
        vm.expectRevert(bytes("not router"));
        current.createWithPriceUpdate(c, new bytes[](0), block.timestamp + 60);
        vm.prank(creator);
        address next = nr.createWithPriceUpdate(c, new bytes[](0), block.timestamp + 60);
        assertEq(pad.coinInfo(next).creator, creator);
        // The new router is governable; the old one never was.
        vm.prank(admin);
        nr.setConfig(1 ether, IPyth(address(pyth)), IStockAttestationSink(address(sink)));
        assertEq(nr.maxBuyNative(), 1 ether);
    }

    function test_UpgradeParamsByANonAdminOnlyDeploys() public {
        bytes32 implBefore = vm.load(address(pad), IMPL_SLOT);
        UpgradeParams s = new UpgradeParams();
        UpgradeParams.Params memory p = s.defaults(address(pad));
        p.deployRouter = true;
        p.paramsWord = CurveMath.DEFAULT_PARAMS;
        UpgradeParams.Result memory r = s.execute(p, 0xBAD);
        assertFalse(r.upgraded);
        assertTrue(r.impl.code.length > 0 && r.lens.code.length > 0 && r.router.code.length > 0);
        assertEq(vm.load(address(pad), IMPL_SLOT), implBefore, "proxy untouched");
        assertEq(legacy.trustedRouter(), address(current));
    }

    function test_UpgradeParamsRefusesAnInvalidWord() public {
        UpgradeParams s = new UpgradeParams();
        UpgradeParams.Params memory p = s.defaults(address(pad));
        CurveMath.Params memory bad = CurveMath.unpack(CurveMath.DEFAULT_PARAMS);
        bad.cbWindowSecs = 0;
        p.paramsWord = CurveMath.pack(bad);
        vm.expectRevert(bytes("UpgradeParams: PARAMS_WORD invalid"));
        s.execute(p, ADMIN_KEY);
    }

    /// `SetParams.fromEnv` keeps every field the operator did not name. (Assumes
    /// no `FEE_*`/`MIN_FEE_BPS`/... is exported in the shell running the tests.)
    function test_SetParamsFromEnvDefaultsToTheLiveFields() public {
        CurveMath.Params memory live = CurveMath.unpack(CurveMath.DEFAULT_PARAMS);
        live.cbWindowSecs = 900;
        CurveMath.Params memory got = new SetParams().fromEnv(live);
        assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(live)));
    }

    /// `SetRouterConfig` tells a pre-`setConfig` router apart from a new one
    /// with an unprivileged probe.
    function test_SetRouterConfigDetectsSetConfig() public {
        SetRouterConfig s = new SetRouterConfig();
        assertTrue(s.hasSetConfig(address(current)), "this bytecode has setConfig");
        // The proxy has no such selector at all: the probe reverts with no data.
        assertFalse(s.hasSetConfig(address(pad)), "no setConfig here");
    }
}
