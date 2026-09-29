// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StonkzLaunchpad} from "../../src/StonkzLaunchpad.sol";
import {StonkzToken} from "../../src/StonkzToken.sol";
import {UniswapV2Migrator, IUniswapV2Factory, IUniswapV2Pair} from "../../src/UniswapV2Migrator.sol";
import {PythPriceSource} from "../../src/oracle/PythPriceSource.sol";
import {IPyth} from "../../src/oracle/IPyth.sol";

interface IWETHLike {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Graduation end to end against the **live** launchpad proxy, migrator
/// and V2 factory on a fork — the exhaustion trigger (no oracle involved), then
/// the authority-gated migration, then "is every LP token at 0x…dEaD".
///
/// Skipped unless `GRADUATION_FORK_RPC` and `GRADUATION_FORK_LAUNCHPAD` are set:
///
///   GRADUATION_FORK_RPC=https://rpc.testnet.chain.robinhood.com \
///   GRADUATION_FORK_LAUNCHPAD=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 \
///   GRADUATION_FORK_WETH=0x7943e237c7F95DA44E0301572D358911207852Fa \
///   forge test --match-path test/fork/GraduationFork.t.sol -vv
///
///   GRADUATION_FORK_RPC=https://sepolia.base.org \
///   GRADUATION_FORK_LAUNCHPAD=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 \
///   GRADUATION_FORK_WETH=0x4200000000000000000000000000000000000006 \
///   forge test --match-path test/fork/GraduationFork.t.sol -vv
contract GraduationForkTest is Test {
    StonkzLaunchpad pad;
    IWETHLike weth;
    address creator = address(0xC4EA7);
    address trader = address(0x74AD3);
    address keeper = address(0x6EE9E7);

    function setUp() public {
        string memory rpc = vm.envOr("GRADUATION_FORK_RPC", string(""));
        address proxy = vm.envOr("GRADUATION_FORK_LAUNCHPAD", address(0));
        address w = vm.envOr("GRADUATION_FORK_WETH", address(0));
        if (bytes(rpc).length == 0 || proxy == address(0) || w == address(0)) return;
        vm.createSelectFork(rpc);
        pad = StonkzLaunchpad(proxy);
        weth = IWETHLike(w);
    }

    modifier onFork() {
        if (address(pad) == address(0)) {
            emit log("GRADUATION_FORK_* not set; skipping");
            return;
        }
        _;
    }

    function test_LiveWiringIsComplete() public onFork {
        assertTrue(address(pad.migrator()) != address(0), "migrator set");
        assertTrue(pad.migrationAuthority() != address(0), "migration authority set");
        UniswapV2Migrator m = UniswapV2Migrator(address(pad.migrator()));
        assertEq(m.launchpad(), address(pad), "migrator trusts this proxy");
        assertTrue(address(m.factory()).code.length > 0, "factory deployed");
        assertTrue(address(pad.priceSource()) != address(0), "price source set");
        assertFalse(pad.oracleGraduationPaused(), "oracle graduation live");
        emit log_named_address("migrator", address(m));
        emit log_named_address("factory", address(m.factory()));
        emit log_named_address("priceSource", address(pad.priceSource()));
    }

    /// Launch, buy the curve out, graduate from a random wallet, migrate as
    /// the live migration authority, and check the pool on the live factory.
    function test_ExhaustAndGraduateAndMigrateOnTheLiveContracts() public onFork {
        vm.deal(trader, 100_000 ether);
        vm.startPrank(trader);
        weth.deposit{value: 50_000 ether}();
        weth.approve(address(pad), type(uint256).max);
        vm.stopPrank();

        // The live Pyth ETH/USD is a pull feed and is stale on a fork between
        // Hermes updates (both chains answered "stale oracle" here). A launch
        // needs a fresh read, so stand in for the update the router would post:
        // mock Pyth Core's `getPriceUnsafe` for the duration of the test. The
        // graduation trigger under test is exhaustion, which never reads it.
        address pyth = address(PythPriceSource(address(pad.priceSource())).pyth());
        vm.mockCall(
            pyth,
            abi.encodeWithSelector(IPyth.getPriceUnsafe.selector),
            abi.encode(IPyth.Price(3_000e8, 1e8, -8, block.timestamp))
        );

        vm.prank(creator);
        try pad.createToken("Fork Grad", "FGRAD", "ipfs://fork", 1_000_000_000, address(weth), 250, false)
        returns (address token) {
            for (uint256 i = 0; i < 80 && pad.coinInfo(token).realToken > 0; i++) {
                vm.prank(trader);
                pad.buy(token, 10 ether, 0);
            }
            assertEq(pad.coinInfo(token).realToken, 0, "curve exhausted");
            uint256 raise = pad.coinInfo(token).realBase;
            uint256 escrow = pad.coinInfo(token).lpReserve;

            // Oracle state is irrelevant to the exhaustion trigger.
            vm.warp(block.timestamp + 7 days);
            vm.prank(keeper);
            pad.graduate(token);
            assertTrue(pad.coinInfo(token).graduated);
            assertEq(pad.coinInfo(token).graduationReason, 0);

            vm.prank(keeper);
            vm.expectRevert(bytes("not migration authority"));
            pad.migrateLiquidity(token);

            vm.prank(pad.migrationAuthority());
            pad.migrateLiquidity(token);

            UniswapV2Migrator m = UniswapV2Migrator(address(pad.migrator()));
            address pool = m.factory().getPair(token, address(weth));
            assertTrue(pool != address(0), "pair exists on the live factory");
            IUniswapV2Pair pair = IUniswapV2Pair(pool);
            assertEq(pair.balanceOf(m.BURN_ADDRESS()), pair.totalSupply(), "every LP token is dead");
            assertEq(weth.balanceOf(pool), raise, "the raise is in the pool");
            assertEq(StonkzToken(token).balanceOf(pool), escrow, "the escrow is in the pool");
            assertEq(pad.coinInfo(token).realBase, 0);
            assertEq(pad.coinInfo(token).lpReserve, 0);
            emit log_named_address("pool", pool);
            emit log_named_uint("deadLp", pair.balanceOf(m.BURN_ADDRESS()));
        } catch Error(string memory reason) {
            emit log_named_string("createToken reverted on the fork", reason);
            assertTrue(false, "launch must succeed with a fresh Pyth read");
        }
    }
}
