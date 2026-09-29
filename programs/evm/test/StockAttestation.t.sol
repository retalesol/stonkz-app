// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {StockPriceSource} from "../src/oracle/StockPriceSource.sol";
import {StockPriceSourceV2} from "../src/oracle/StockPriceSourceV2.sol";
import {StockBases} from "../src/config/StockBases.sol";
import {RobinhoodChainTestnet} from "../src/config/RobinhoodChainTestnet.sol";
import {MockUniversalRouter, MockSwapRouter02} from "./mocks/MockUniversalRouter.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {DeployPad} from "../script/DeployPad.sol";
import {DeployStockPriceSource} from "../script/DeployStockPriceSource.s.sol";
import {UpgradeAttestedStockLaunch} from "../script/UpgradeAttestedStockLaunch.s.sol";
import {StockFixture} from "./StockPriceSource.t.sol";

/// @notice Shared: the production wiring with `StockPriceSourceV2` behind
/// `PythPriceSource`, a launchpad whose pauser can stop attestations, and an
/// attester key that signs like the API's `/launch/prepare`.
abstract contract AttestationFixture is StockFixture {
    uint256 constant ATTESTER_KEY = 0xA77E57; // test-only key
    uint256 constant SUNDAY_3AM_ET = 1_800_172_800;
    uint256 constant FRIDAY_CLOSE = 1_800_046_800;
    address pauser = address(0x9A05E);
    address attesterAddr;
    StockPriceSourceV2 v2;
    StonkzLaunchpad pad;

    function _setUpV2() internal {
        _setUpSources();
        attesterAddr = vm.addr(ATTESTER_KEY);
        pad = DeployPad.launchpad(admin, admin, admin, IPriceSource(address(pps)), admin);
        v2 = new StockPriceSourceV2(
            admin, IPyth(address(pyth)), IPriceSource(address(pps)), IPriceSource(address(push)), address(pad)
        );
        vm.startPrank(admin);
        pad.setPauser(pauser);
        v2.setStableQuote(address(usdg), true);
        v2.setConfig(address(tsla), _p2(address(pool), address(weth)));
        v2.setAttester(attesterAddr);
        pps.setFallbackSource(IPriceSource(address(v2)));
        vm.stopPrank();
    }

    function _p2(address pool_, address quote) internal pure returns (StockPriceSourceV2.Params memory) {
        return StockPriceSourceV2.Params({
            pool: pool_,
            quoteToken: quote,
            twapSecs: 1800,
            minLiquidity: MIN_LIQ,
            pythFeedId: TSLA_USD,
            pythMaxAge: 120,
            maxDeviationBps: 300,
            minPrice1e6: 1e6,
            maxPrice1e6: 10_000e6,
            anchorMaxAge: 0,
            offHoursMaxMoveBps: 0,
            offHoursTwapSecs: 0,
            attestMaxAge: 0 // default 300 s
        });
    }

    /// Exactly what the API produces: EIP-191 personal_sign over the digest.
    function _att(uint256 key, uint256 chainId, address source, address base, uint64 price, uint64 t)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encode("STONKZ_PRICE_V1", chainId, source, base, price, t));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encode(bytes4("STKA"), base, price, t, abi.encodePacked(r, s, v));
    }

    function _att(uint64 price, uint64 t) internal view returns (bytes memory) {
        return _att(ATTESTER_KEY, block.chainid, address(v2), address(tsla), price, t);
    }

    /// Empty the pool (no TWAP leg) from now on.
    function _drainPool() internal {
        pool.set(pool.tick(), 0);
    }
}

contract StockPriceSourceV2Test is AttestationFixture {
    event PriceAttested(address indexed base, uint64 price1e6, uint64 publishTime);

    function setUp() public {
        _setUpV2();
    }

    /* ---------------------------------------------------------- signatures */

    function test_AValidAttestationIsStored() public {
        uint64 t = uint64(block.timestamp);
        assertEq(
            v2.attestationDigest(address(tsla), 251e6, t),
            keccak256(
                abi.encode("STONKZ_PRICE_V1", block.chainid, address(v2), address(tsla), uint64(251e6), t)
            )
        );
        vm.expectEmit(true, false, false, true, address(v2));
        emit PriceAttested(address(tsla), 251e6, t);
        assertTrue(v2.postAttestation(_att(251e6, t)));
        (uint64 p, uint64 at, uint32 epoch) = v2.latest(address(tsla));
        assertEq(p, 251e6);
        assertEq(at, t);
        assertEq(epoch, v2.attesterEpoch());
    }

    function test_AWrongSignerIsIgnored() public {
        bytes memory a =
            _att(0xBAD, block.chainid, address(v2), address(tsla), 251e6, uint64(block.timestamp));
        assertFalse(v2.postAttestation(a));
        (uint64 p,,) = v2.latest(address(tsla));
        assertEq(p, 0);
    }

    function test_AWrongChainIdIsIgnored() public {
        bytes memory a = _att(ATTESTER_KEY, 1, address(v2), address(tsla), 251e6, uint64(block.timestamp));
        assertFalse(v2.postAttestation(a));
    }

    function test_AWrongSourceAddressIsIgnored() public {
        bytes memory a =
            _att(ATTESTER_KEY, block.chainid, address(0x5A5A), address(tsla), 251e6, uint64(block.timestamp));
        assertFalse(v2.postAttestation(a));
    }

    function test_ReplaysAndOlderAttestationsAreIgnored() public {
        uint64 t = uint64(block.timestamp);
        assertTrue(v2.postAttestation(_att(251e6, t)));
        assertFalse(v2.postAttestation(_att(251e6, t)), "exact replay");
        assertFalse(v2.postAttestation(_att(240e6, t - 1)), "older");
        assertTrue(v2.postAttestation(_att(252e6, t + 1)), "newer");
        (uint64 p,,) = v2.latest(address(tsla));
        assertEq(p, 252e6);
    }

    function test_FutureSkewIsBoundedToFiveSeconds() public {
        assertFalse(v2.postAttestation(_att(251e6, uint64(block.timestamp + 6))));
        assertTrue(v2.postAttestation(_att(251e6, uint64(block.timestamp + 5))));
    }

    /// Nothing about a bad attestation reverts.
    function test_MalformedUnconfiguredAndZeroAreNoOps() public {
        assertFalse(v2.postAttestation(hex"53544b41"), "truncated");
        assertFalse(v2.postAttestation(hex""), "empty");
        bytes memory a =
            _att(ATTESTER_KEY, block.chainid, address(v2), address(0xDEAD), 1e6, uint64(block.timestamp));
        assertFalse(v2.postAttestation(a), "unconfigured base");
        assertFalse(v2.postAttestation(_att(0, uint64(block.timestamp))), "zero price");
        bytes memory wrongMagic = _att(251e6, uint64(block.timestamp));
        wrongMagic[0] = 0x50;
        assertFalse(v2.postAttestation(wrongMagic), "magic");
        // A malleable (high-s) signature is refused by OZ ECDSA.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ATTESTER_KEY,
            MessageHashUtils.toEthSignedMessageHash(
                v2.attestationDigest(address(tsla), 251e6, uint64(block.timestamp))
            )
        );
        bytes32 highS =
            bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        bytes memory flipped = abi.encode(
            bytes4("STKA"),
            address(tsla),
            uint64(251e6),
            uint64(block.timestamp),
            abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27))
        );
        assertFalse(v2.postAttestation(flipped), "high-s");
    }

    /* ------------------------------------------------------------ the leg */

    /// With the pool empty and no Pyth: the attestation prices alone while it
    /// is at most `attestMaxAge` (300 s) old.
    function test_AStaleAttestationIsIgnored() public {
        _drainPool();
        _postEth(T0);
        v2.postAttestation(_att(251e6, uint64(T0 - 301)));
        (uint256 p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "301 s old: stale");
        v2.postAttestation(_att(252e6, uint64(T0 - 300)));
        uint256 at;
        uint256 maxAge;
        (p, at, maxAge) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 252e6, "300 s old: fresh");
        assertEq(at, T0 - 300);
        assertEq(maxAge, 300);
    }

    /// Attested vs TWAP: within `maxDeviationBps` the attestation prices; beyond it, nothing does.
    function test_AttestedAgainstTheTwap() public {
        _postEth(T0);
        v2.postAttestation(_att(255e6, uint64(T0 - 1)));
        (uint256 p, uint256 at,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 255e6, "2% off the TWAP: the attestation");
        assertEq(at, T0 - 1);
        v2.postAttestation(_att(280e6, uint64(T0)));
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "12% off the TWAP: no price");
    }

    /// Attested vs the last close (no TWAP): 15% off hours.
    function test_AttestedAgainstTheAnchor() public {
        _drainPool();
        _postEth(T0);
        _post(TSLA_USD, 250e8, T0 - 1 days);
        v2.postAttestation(_att(280e6, uint64(T0 - 1)));
        (uint256 p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 280e6, "+12% from the close");
        v2.postAttestation(_att(300e6, uint64(T0)));
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "+20% from the close: no price");
    }

    /// Market hours: fresh Pyth leads; an attestation that disagrees with it kills the price.
    function test_AttestedAgainstFreshPyth() public {
        _postEth(T0);
        _post(TSLA_USD, 250e8, T0);
        v2.postAttestation(_att(252e6, uint64(T0)));
        (uint256 p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 250e6, "agreeing: Pyth");
        v2.postAttestation(_att(270e6, uint64(T0 + 1)));
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "8% apart: no price");
    }

    /// Out-of-band attestations are no leg at all (the TWAP answers instead).
    function test_AnOutOfBandAttestationIsNoLeg() public {
        StockPriceSourceV2.Params memory c = _p2(address(pool), address(weth));
        c.maxPrice1e6 = 260e6;
        vm.prank(admin);
        v2.setConfig(address(tsla), c);
        _postEth(T0);
        v2.postAttestation(_att(261e6, uint64(T0)));
        assertEq(v2.legs(address(tsla)).attestedPrice1e6, 0);
        (uint256 p,,) = v2.priceUsd1e6(address(tsla));
        _assertNear(p, 250e6, 2, "TWAP");
    }

    /// A base with no pool at all: attested (and Pyth) only.
    function test_ABaseWithNoPool() public {
        MockERC20 amzn = _token(address(0x3000), "Amazon", "AMZN", 18);
        StockPriceSourceV2.Params memory c = _p2(address(0), address(0));
        c.minLiquidity = 0;
        c.pythFeedId = bytes32(0);
        vm.prank(admin);
        v2.setConfig(address(amzn), c);
        v2.postAttestation(_att(ATTESTER_KEY, block.chainid, address(v2), address(amzn), 220e6, uint64(T0)));
        (uint256 p,,) = v2.priceUsd1e6(address(amzn));
        assertEq(p, 220e6);
    }

    /* -------------------------------------------------------- kill switches */

    function test_ThePauserCanStopAttestations() public {
        _drainPool();
        v2.postAttestation(_att(251e6, uint64(T0)));
        (uint256 p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 251e6);

        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("not pauser"));
        v2.pauseAttestations();

        vm.prank(pauser);
        v2.pauseAttestations();
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "paused: the stored price no longer counts");
        assertFalse(v2.postAttestation(_att(252e6, uint64(T0 + 1))), "and nothing new is stored");

        vm.prank(pauser);
        vm.expectRevert(bytes("not admin"));
        v2.setAttestationsPaused(false);
        vm.prank(admin);
        v2.setAttestationsPaused(false);
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 251e6, "resumed by the admin");
    }

    function test_ZeroingOrRotatingTheAttester() public {
        _drainPool();
        v2.postAttestation(_att(251e6, uint64(T0)));
        vm.prank(admin);
        v2.setAttester(address(0));
        (uint256 p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "zeroed: off");
        assertFalse(v2.postAttestation(_att(252e6, uint64(T0 + 1))));

        address next = vm.addr(0xB0B);
        vm.prank(admin);
        v2.setAttester(next);
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 0, "the old key's price does not come back");
        assertFalse(v2.postAttestation(_att(252e6, uint64(T0 + 2))), "old key refused");
        assertTrue(
            v2.postAttestation(
                _att(0xB0B, block.chainid, address(v2), address(tsla), 253e6, uint64(T0 - 10))
            ),
            "new key accepted, even older than the old key's last"
        );
        (p,,) = v2.priceUsd1e6(address(tsla));
        assertEq(p, 253e6);
    }

    /// The byte-for-byte vector the API's TypeScript must reproduce, computed
    /// independently with `cast` (see the report / governance doc).
    function test_TypeScriptVector() public {
        vm.chainId(46630);
        address source = 0x1111111111111111111111111111111111111111;
        address base = StockBases.RH_TESTNET_TSLA;
        deployCodeTo("Mocks.sol:MockERC20", abi.encode("Tesla", "TSLA", uint8(18)), base);
        deployCodeTo(
            "StockPriceSourceV2.sol:StockPriceSourceV2",
            abi.encode(admin, address(pyth), address(pps), address(push), address(pad)),
            source
        );
        StockPriceSourceV2 s = StockPriceSourceV2(source);
        StockPriceSourceV2.Params memory c = _p2(address(0), address(0));
        c.minLiquidity = 0;
        vm.startPrank(admin);
        s.setConfig(base, c);
        s.setAttester(0x501D9b198010BC786D8b0DAc53ac700c8ACdc02d); // vm.addr(0xa77e57)
        vm.stopPrank();
        assertEq(vm.addr(0xa77e57), 0x501D9b198010BC786D8b0DAc53ac700c8ACdc02d);

        assertEq(
            s.attestationDigest(base, 251_230_000, 1_800_172_800),
            0x6f0df46fbead27ad246430c1e267fff6d04a9749f7c44c9ffe0afe40cb759695,
            "digest"
        );
        assertEq(
            MessageHashUtils.toEthSignedMessageHash(
                bytes32(0x6f0df46fbead27ad246430c1e267fff6d04a9749f7c44c9ffe0afe40cb759695)
            ),
            0xe24721bba5a620d7448d8ce81350a4e2374a153aaf0c32114c868a60bbc59f12,
            "EIP-191 hash"
        );
        vm.warp(1_800_172_800);
        bytes memory att =
            hex"53544b4100000000000000000000000000000000000000000000000000000000000000000000000000000000c9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e000000000000000000000000000000000000000000000000000000000ef97730000000000000000000000000000000000000000000000000000000006b4c750000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000004181a47902ff37aeb2818b40e0959b26189071d8e4d1222f182961b8f149e7885d1e99d2017d3022927502e686af78e42fbcc4a99e069b39537e98ebad5887aa011c00000000000000000000000000000000000000000000000000000000000000";
        assertEq(att.length, 288);
        assertTrue(s.postAttestation(att), "the cast-signed vector verifies on chain");
        (uint64 p,,) = s.latest(base);
        assertEq(p, 251_230_000);
    }
}

/// @notice The router side: partitioned `priceUpdate`, and whole launches
/// priced by an attestation.
contract AttestedLaunchTest is AttestationFixture {
    StonkzRouter router;
    MockSwapRouter02 sr02;
    MockUniversalRouter ur;
    address user = address(0xC4EA7);

    function setUp() public {
        _setUpV2();
        sr02 = new MockSwapRouter02(weth, tsla, 16e18);
        ur = new MockUniversalRouter(weth, tsla, 16e18);
        router = _router(IStockAttestationSink(address(v2)));
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        vm.prank(admin);
        pad.upgradeToAndCall(address(impl), "");
        vm.deal(user, 100 ether);
    }

    function _router(IStockAttestationSink sink) internal returns (StonkzRouter) {
        return new StonkzRouter(
            IUniversalRouter(address(ur)),
            pad,
            IWETH9(address(weth)),
            ISwapRouter02(address(sr02)),
            0,
            IPyth(address(pyth)),
            sink
        );
    }

    function _coin(string memory ticker) internal view returns (StonkzRouter.CreateParams memory) {
        return
            StonkzRouter.CreateParams(
                "Attested", ticker, "ipfs://a", 1_000_000_000, address(tsla), 250, false
            );
    }

    function _ethUpdate() internal view returns (bytes memory) {
        return pyth.createUpdate(ETH_USD, 4000e8, 0, -8, block.timestamp - 1);
    }

    /// [Pyth, STKA, Pyth]: the attestation goes to the sink, the other two to
    /// Pyth, and the fee is for those two only.
    function test_TheRouterPartitionsAMixedUpdate() public {
        bytes[] memory u = new bytes[](3);
        u[0] = _ethUpdate();
        u[1] = _att(252e6, uint64(block.timestamp));
        u[2] = pyth.createUpdate(TSLA_USD, 252e8, 0, -8, block.timestamp - 1);
        uint256 before = user.balance;
        vm.prank(user);
        router.createWithPriceUpdate{value: 3 * PYTH_FEE}(_coin("MIXED"), u, block.timestamp + 60);
        assertEq(pyth.updates(), 2, "two Pyth entries posted");
        assertEq(user.balance, before - 2 * PYTH_FEE, "fee for the Pyth subset only; the rest refunded");
        (uint64 p,,) = v2.latest(address(tsla));
        assertEq(p, 252e6, "the attestation reached the sink");
    }

    /// Only STKA entries: no Pyth call at all, no fee.
    function test_AnAttestationOnlyUpdateCostsNothing() public {
        _drainPool();
        vm.warp(SUNDAY_3AM_ET);
        bytes[] memory u = new bytes[](1);
        u[0] = _att(251e6, uint64(block.timestamp));
        vm.prank(user);
        address token = router.createWithPriceUpdate(_coin("FREE"), u, block.timestamp + 60);
        assertEq(pyth.updates(), 0);
        assertEq(pad.coinInfo(token).creationPrice1e6, 251e6);
    }

    /// A router built without a sink drops STKA entries (Pyth never sees them).
    function test_AZeroSinkDropsAttestations() public {
        StonkzRouter bare = _router(IStockAttestationSink(address(0)));
        bytes[] memory u = new bytes[](2);
        u[0] = _ethUpdate();
        u[1] = _att(252e6, uint64(block.timestamp));
        StonkzLaunchpad impl = new StonkzLaunchpad(address(bare));
        vm.prank(admin);
        pad.upgradeToAndCall(address(impl), "");
        vm.prank(user);
        address token =
            bare.createWithPriceUpdate{value: 2 * PYTH_FEE}(_coin("DROP"), u, block.timestamp + 60);
        assertEq(pyth.updates(), 1, "only the Pyth entry went to Pyth");
        (uint64 p,,) = v2.latest(address(tsla));
        assertEq(p, 0, "the attestation was dropped");
        _assertNear(pad.coinInfo(token).creationPrice1e6, 250e6, 2, "priced by the TWAP instead");
    }

    /// Sunday 03:00 ET, the pool empty, nothing pushed, no equity print: a
    /// signed quote alone launches the coin.
    function test_AttestedOnlyLaunchOnASundayWithEmptyPools() public {
        _drainPool();
        vm.warp(SUNDAY_3AM_ET);
        (uint256 pushed,,) = push.prices(address(tsla));
        assertEq(pushed, 0);
        bytes[] memory u = new bytes[](2);
        u[0] = _ethUpdate();
        u[1] = _att(247_120_000, uint64(block.timestamp - 20));
        vm.prank(user);
        (address token, uint256 out) =
            router.createAndBuyViaV3{value: 1 ether}(_coin("SUNDAY"), u, 3000, 15e18, 1, block.timestamp + 60);
        StonkzLaunchpad.Coin memory c = pad.coinInfo(token);
        assertEq(c.creationPrice1e6, 247_120_000, "the signed price");
        assertEq(c.creator, user);
        assertGt(out, 0);
        assertEq(StonkzToken(token).balanceOf(user), out);
        assertEq(tsla.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    /// The same Sunday with Friday's close in the update: attested within 15%
    /// of it launches; beyond it, the launch is refused.
    function test_SundayAttestedAgainstFridaysClose() public {
        _drainPool();
        vm.warp(SUNDAY_3AM_ET);
        bytes[] memory u = new bytes[](3);
        u[0] = _ethUpdate();
        u[1] = pyth.createUpdate(TSLA_USD, 250e8, 0, -8, FRIDAY_CLOSE);
        u[2] = _att(262e6, uint64(block.timestamp));
        vm.prank(user);
        address token =
            router.createWithPriceUpdate{value: 2 * PYTH_FEE}(_coin("CLOSE"), u, block.timestamp + 60);
        assertEq(pad.coinInfo(token).creationPrice1e6, 262e6);

        u[2] = _att(300e6, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 1);
        vm.prank(user);
        vm.expectRevert(bytes("stale oracle"));
        router.createWithPriceUpdate{value: 2 * PYTH_FEE}(_coin("PUMP"), u, block.timestamp + 60);
    }

    /// A stale or replayed attestation in the update never reverts the launch
    /// by itself; the launch just has no price from it.
    function test_AStaleAttestationDoesNotRevertTheCall() public {
        bytes[] memory u = new bytes[](2);
        u[0] = _ethUpdate();
        u[1] = _att(251e6, uint64(block.timestamp));
        vm.prank(user);
        router.createWithPriceUpdate{value: PYTH_FEE}(_coin("ONE"), u, block.timestamp + 60);
        // Same bytes again (a duplicate): ignored, launch priced by the TWAP.
        vm.prank(user);
        address token = router.createWithPriceUpdate{value: PYTH_FEE}(_coin("TWO"), u, block.timestamp + 60);
        assertEq(pad.coinInfo(token).creationPrice1e6, 251e6, "the stored (still fresh) attestation");
    }
}

/// @notice `UpgradeAttestedStockLaunch` on a local 46630 look-alike whose
/// PythPriceSource already falls back to a live (V1) `StockPriceSource`.
contract AttestedScriptTest is Test {
    uint256 constant ADMIN_KEY = 0xAD814; // test-only key
    address admin;
    StonkzLaunchpad pad;
    PythPriceSource pps;
    PushPriceSource push;
    StockPriceSource v1;

    function setUp() public {
        vm.chainId(46630);
        vm.warp(1_800_000_000);
        admin = vm.addr(ADMIN_KEY);
        deployCodeTo("MockPyth.sol:MockPyth", abi.encode(uint256(1)), RobinhoodChainTestnet.PYTH);
        deployCodeTo("MockUniversalRouter.sol:MockWETH", "", RobinhoodChainTestnet.WETH9);
        deployCodeTo("Mocks.sol:MockERC20", abi.encode("USDG", "USDG", uint8(6)), RobinhoodChainTestnet.USDG);
        StockBases.Entry[] memory e = StockBases.forChain();
        for (uint256 i = 0; i < e.length; i++) {
            deployCodeTo("Mocks.sol:MockERC20", abi.encode(e[i].symbol, e[i].symbol, uint8(18)), e[i].token);
            deployCodeTo(
                "MockV3Pool.sol:MockV3Pool",
                abi.encode(e[i].token, e[i].quote, int24(0), uint128(0)),
                e[i].pool
            );
        }
        push = DeployPad.pushOracle(admin, admin, 90_000);
        pps = new PythPriceSource(admin, IPyth(RobinhoodChainTestnet.PYTH));
        vm.prank(admin);
        pps.setFallbackSource(IPriceSource(address(push)));
        pad = DeployPad.launchpad(admin, address(0xC01D1), admin, pps, admin);
        // Today's state: a V1 stock source behind PythPriceSource, one base tuned.
        DeployStockPriceSource d = new DeployStockPriceSource();
        v1 = StockPriceSource(d.execute(d.defaults(address(pps)), ADMIN_KEY).source);
        StockPriceSource.Params memory tuned = v1.getConfig(StockBases.RH_TESTNET_TSLA).p;
        tuned.minLiquidity = 5e18;
        vm.prank(admin);
        v1.setConfig(StockBases.RH_TESTNET_TSLA, tuned);
    }

    function test_UpgradeAttestedStockLaunchWiresEverything() public {
        UpgradeAttestedStockLaunch s = new UpgradeAttestedStockLaunch();
        UpgradeAttestedStockLaunch.Params memory p = s.defaults(address(pad));
        assertEq(p.previousStock, address(v1));
        assertEq(p.fallbackSource, address(push), "push stays last");
        p.attester = address(0xA77E57);
        bytes32[18] memory before;
        for (uint256 i = 0; i < 18; i++) {
            before[i] = vm.load(address(pad), bytes32(i));
        }
        UpgradeAttestedStockLaunch.Result memory r = s.execute(p, ADMIN_KEY);

        StockPriceSourceV2 v2 = StockPriceSourceV2(r.source);
        assertEq(r.configured, 5);
        assertTrue(r.upgraded && r.fallbackSet);
        assertEq(v2.attester(), address(0xA77E57));
        assertEq(v2.launchpad(), address(pad));
        assertEq(address(v2.quotePriceSource()), address(pps));
        assertEq(address(v2.fallbackSource()), address(push));
        assertEq(address(pps.fallbackSource()), r.source, "PythPriceSource -> V2");
        assertEq(pad.trustedRouter(), r.router);
        assertEq(address(StonkzRouter(payable(r.router)).attestationSink()), r.source);
        for (uint256 i = 0; i < 18; i++) {
            assertEq(vm.load(address(pad), bytes32(i)), before[i], "layout unchanged");
        }
        StockPriceSourceV2.Config memory c = v2.getConfig(StockBases.RH_TESTNET_TSLA);
        assertEq(c.p.minLiquidity, 5e18, "copied from the live source");
        assertEq(c.p.pool, StockBases.RH_TESTNET_TSLA_WETH);
        assertEq(c.p.pythFeedId, StockBases.PYTH_TSLA);
        assertEq(c.p.attestMaxAge, 300);
        assertEq(c.p.offHoursMaxMoveBps, 1500);
        assertEq(v2.getConfig(StockBases.RH_TESTNET_AMD).p.minLiquidity, 1e17);

        // A re-run copies from V2 and keeps the push oracle last.
        UpgradeAttestedStockLaunch.Params memory again = s.defaults(address(pad));
        assertEq(again.previousStock, r.source);
        assertEq(again.fallbackSource, address(push));
    }

    function test_AttesterIsRequired() public {
        UpgradeAttestedStockLaunch s = new UpgradeAttestedStockLaunch();
        UpgradeAttestedStockLaunch.Params memory p = s.defaults(address(pad));
        vm.expectRevert(bytes("UpgradeAttestedStockLaunch: ATTESTER is required (non-zero)"));
        s.execute(p, ADMIN_KEY);
    }

    function test_ANonAdminOnlyDeploys() public {
        UpgradeAttestedStockLaunch s = new UpgradeAttestedStockLaunch();
        UpgradeAttestedStockLaunch.Params memory p = s.defaults(address(pad));
        p.attester = address(0xA77E57);
        UpgradeAttestedStockLaunch.Result memory r = s.execute(p, 0xBAD);
        assertFalse(r.upgraded || r.fallbackSet);
        assertEq(address(pps.fallbackSource()), address(v1), "untouched");
        assertEq(StockPriceSourceV2(r.source).pendingAdmin(), admin);
    }
}
