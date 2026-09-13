// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeErc20} from "../src/SafeErc20.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../src/StonkzToken.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {MockERC20, MockFalseReturnERC20, MockNoReturnERC20} from "./mocks/Mocks.sol";
import {DeployPad} from "../script/DeployPad.sol";

/// @notice `SafeErc20` is an internal library, so its reverts happen in the
/// caller's own frame — `vm.expectRevert` only observes reverts from an
/// external call. This harness gives the failure cases a real call boundary to
/// revert across, which is also how the production contracts reach the library
/// (through their own external entry points).
contract SafeErc20Harness {
    function transfer(address token, address to, uint256 amount) external {
        SafeErc20.safeTransfer(token, to, amount);
    }

    function transferFrom(address token, address from, address to, uint256 amount) external {
        SafeErc20.safeTransferFrom(token, from, to, amount);
    }

    function approve(address token, address spender, uint256 amount) external {
        SafeErc20.safeApprove(token, spender, amount);
    }
}

/// @notice Security finding M4: the launchpad, router, and migrator called
/// foreign ERC-20s through a typed interface declaring a `bool` return. A token
/// that returns no data at all — the mainnet-USDT shape — makes that decode
/// revert, so such a token could be configured as a base asset and then have
/// every single trade against it fail.
///
/// These tests prove three things: the old shape really did break, the new
/// wrappers fix it end to end through a real launch/buy/sell, and the fix did
/// not widen "success" far enough to swallow a `false` return.
contract SafeErc20Test is Test {
    StonkzLaunchpad pad;
    PushPriceSource oracle;
    SafeErc20Harness harness;

    address admin = address(0xA11CE);
    address protocolCold = address(0xC01D1);
    address opsCold = address(0xC01D2);
    address oracleAuth = address(0x0AC1E);
    address migAuth = address(0x11165);
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);

    uint8 constant BASE_DECIMALS = 6;
    uint256 constant ONE = 10 ** BASE_DECIMALS;
    uint256 constant SUPPLY = 1_000_000_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = DeployPad.pushOracle(admin, oracleAuth, 90_000);
        pad = DeployPad.launchpad(admin, protocolCold, opsCold, oracle, migAuth);
        harness = new SafeErc20Harness();
    }

    /* ------------------------------------------------- the underlying hazard */

    /// The reason this hardening exists, pinned so nobody "simplifies" the
    /// wrappers back to a typed call: decoding a `bool` from a no-return token
    /// reverts, even though the transfer itself succeeded.
    function test_TypedBoolCallRevertsAgainstANoReturnToken() public {
        MockNoReturnERC20 t = new MockNoReturnERC20("Tether", "USDT", 6);
        t.mint(address(this), 10 * ONE);

        // Same call the old code made: `IERC20(t).transfer(...)` returning bool.
        (bool ok, bytes memory data) =
            address(t).call(abi.encodeWithSignature("transfer(address,uint256)", trader, ONE));
        assertTrue(ok, "the transfer itself succeeds");
        assertEq(data.length, 0, "but returns no data to decode a bool from");

        // And the balance did move, which is what makes the old behaviour a
        // usability failure rather than a safety one.
        assertEq(t.balanceOf(trader), ONE, "transfer took effect");
    }

    /* ------------------------------------------------------------- wrappers */

    function test_SafeTransferAcceptsANoReturnToken() public {
        MockNoReturnERC20 t = new MockNoReturnERC20("Tether", "USDT", 6);
        t.mint(address(this), 10 * ONE);

        SafeErc20.safeTransfer(address(t), trader, 4 * ONE);
        assertEq(t.balanceOf(trader), 4 * ONE);
    }

    function test_SafeTransferFromAndApproveAcceptANoReturnToken() public {
        MockNoReturnERC20 t = new MockNoReturnERC20("Tether", "USDT", 6);
        t.mint(trader, 10 * ONE);

        vm.prank(trader);
        t.approve(address(this), type(uint256).max);

        SafeErc20.safeTransferFrom(address(t), trader, address(this), 3 * ONE);
        assertEq(t.balanceOf(address(this)), 3 * ONE);

        SafeErc20.safeApprove(address(t), trader, 7 * ONE);
        assertEq(t.allowance(address(this), trader), 7 * ONE);
    }

    function test_SafeTransferStillAcceptsAStandardToken() public {
        MockERC20 t = new MockERC20("Global Dollar", "USDG", 6);
        t.mint(address(this), 10 * ONE);

        SafeErc20.safeTransfer(address(t), trader, 4 * ONE);
        assertEq(t.balanceOf(trader), 4 * ONE);
    }

    /// The hardening must not turn a reported failure into a silent success.
    function test_SafeTransferRejectsAFalseReturn() public {
        MockFalseReturnERC20 t = new MockFalseReturnERC20();
        t.mint(address(harness), 10 ether);

        vm.expectRevert(
            abi.encodeWithSelector(SafeErc20.TransferFailed.selector, address(t), trader, uint256(1 ether))
        );
        harness.transfer(address(t), trader, 1 ether);
    }

    function test_SafeTransferFromRejectsAFalseReturn() public {
        MockFalseReturnERC20 t = new MockFalseReturnERC20();

        vm.expectRevert(
            abi.encodeWithSelector(
                SafeErc20.TransferFromFailed.selector, address(t), trader, address(this), uint256(1 ether)
            )
        );
        harness.transferFrom(address(t), trader, address(this), 1 ether);
    }

    function test_SafeApproveRejectsAFalseReturn() public {
        MockFalseReturnERC20 t = new MockFalseReturnERC20();

        vm.expectRevert(
            abi.encodeWithSelector(SafeErc20.ApproveFailed.selector, address(t), trader, uint256(1 ether))
        );
        harness.approve(address(t), trader, 1 ether);
    }

    /// A reverting token must still revert the trade, not be swallowed.
    function test_SafeTransferPropagatesAHardRevert() public {
        MockNoReturnERC20 t = new MockNoReturnERC20("Tether", "USDT", 6);
        // No balance minted, so the mock's own `require(balance)` reverts.
        vm.expectRevert(
            abi.encodeWithSelector(SafeErc20.TransferFailed.selector, address(t), trader, uint256(1 ether))
        );
        harness.transfer(address(t), trader, 1 ether);
    }

    /* ------------------------------------------------ end to end through the pad */

    /// The point of the fix: a no-return token works as a real base asset,
    /// through launch, buy, and sell. Before the fix, `buy` reverted on the
    /// `transferFrom` decode.
    function test_ANoReturnTokenWorksAsABaseAssetEndToEnd() public {
        MockNoReturnERC20 base = new MockNoReturnERC20("Tether", "USDT", BASE_DECIMALS);

        vm.prank(oracleAuth);
        oracle.pushPrice(address(base), 1_000_000, 0);

        base.mint(trader, 5_000_000 * ONE);
        vm.prank(trader);
        base.approve(address(pad), type(uint256).max);

        vm.prank(creator);
        address token = pad.createToken("Coin", "MOON", "ipfs://x", SUPPLY, address(base), 250, false);

        uint256 baseBefore = base.balanceOf(trader);

        vm.prank(trader);
        uint256 tokensOut = pad.buy(token, 400 * ONE, 0);
        assertGt(tokensOut, 0, "buy delivered tokens");
        assertEq(base.balanceOf(trader), baseBefore - 400 * ONE, "base actually left the trader");
        assertEq(StonkzToken(token).balanceOf(trader), tokensOut, "tokens actually arrived");

        vm.startPrank(trader);
        StonkzToken(token).approve(address(pad), type(uint256).max);
        uint256 baseOut = pad.sell(token, tokensOut, 0);
        vm.stopPrank();

        assertGt(baseOut, 0, "sell returned base");
        assertEq(StonkzToken(token).balanceOf(trader), 0, "tokens went back to the curve");
    }
}
