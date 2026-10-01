// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {CurveMath} from "../src/CurveMath.sol";
import {StonkzLaunchpad} from "../src/StonkzLaunchpad.sol";
import {StonkzRouter, IUniversalRouter, IWETH9, ISwapRouter02} from "../src/StonkzRouter.sol";
import {FeeLocker, ILaunchpadMigrator} from "../src/FeeLocker.sol";
import {UniswapV3Migrator} from "../src/UniswapV3Migrator.sol";
import {ReferralVault} from "../src/ReferralVault.sol";
import {IUniswapV3Factory} from "../src/oracle/uniswap/IUniswapV3.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {IStockAttestationSink} from "../src/oracle/IStockAttestationSink.sol";
import {PushPriceSource} from "../src/oracle/PushPriceSource.sol";
import {PythPriceSource} from "../src/oracle/PythPriceSource.sol";
import {ChainlinkPriceSource, AggregatorV3Interface} from "../src/oracle/ChainlinkPriceSource.sol";
import {StockPriceSourceV2} from "../src/oracle/StockPriceSourceV2.sol";
import {Base} from "../src/config/Base.sol";
import {RobinhoodChain} from "../src/config/RobinhoodChain.sol";
import {DeployPad} from "./DeployPad.sol";
import {GovernanceLib} from "./GovernanceLib.sol";
import {MainnetGuard} from "./MainnetGuard.sol";
import {RouterWiring} from "./RouterWiring.sol";

/// @title The mainnet deployment — Robinhood Chain 4663 and Base 8453 — of
/// the exact stack the testnets run, governed from the moment it lands.
///
/// One dry-runnable broadcast. Every pin is resolved from `block.chainid`
/// (`RouterWiring` over `RobinhoodChain.sol` / `Base.sol`); nothing
/// chain-specific comes from the environment. In order:
///
///   1. `PushPriceSource` (UUPS proxy) — fallback only, never the live source;
///      `STONKZ_ORACLE_AUTHORITY` may push to it (default: nobody).
///   2. `ChainlinkPriceSource` — ETH/USD for WETH (and USDG/USD on RH), at the
///      chain's heartbeat-scale bound; `PythPriceSource`'s fallback.
///   3. `PythPriceSource` — ETH/USD → WETH at `PYTH_MAX_AGE` (120 s) within
///      `ETH_MIN_PRICE_1E6..ETH_MAX_PRICE_1E6`, the chain's USD stables fixed at
///      $1.00, fallback = Chainlink. **The launchpad's live source.**
///   4. `StonkzLaunchpad` implementation + ERC1967 proxy, initialised with the
///      protocol / ops withdraw authorities, the Pyth source and the migration
///      authority (`maxOracleStaleness` = 90 000 s).
///   5. `StockPriceSourceV2(quote = Pyth source, fallback = push, launchpad)`
///      — **no stock bases configured** (v1 scope); `STOCK_PRICE_ATTESTER`
///      optional. It is the router's attestation sink and sits outside the
///      pricing chain until the timelock opts a base in (`docs/deployment.md`
///      §2.3).
///   6. `StonkzRouter(UR, proxy, WETH, SwapRouter02, MAX_BUY_NATIVE, Pyth,
///      StockPriceSourceV2)` and the launchpad implementation that trusts it
///      (`upgradeToAndCall` while the deployer is still admin). The cap, Pyth
///      and sink are starting values: the timelock changes them later with
///      `StonkzRouter.setConfig` (`script/SetRouterConfig.s.sol`), and the
///      launchpad's tunables with `setParams` (`script/SetParams.s.sol`) —
///      the deployment leaves `paramsWord() == CurveMath.DEFAULT_PARAMS`
///      (slot 17 zero). See `docs/parameters.md`.
///   7. `FeeLocker` + `UniswapV3Migrator` on the chain's V3 factory at the 1%
///      tier; installed by the handover's `setMigrator`.
///   8. `GovernanceLib.handover` (atomic): `TimelockController(PROPOSERS,
///      EXECUTORS, MIN_DELAY)`; `setWithdrawAuthorities`, `setMigrator`,
///      `setPauser(PAUSER)`; the timelock accepts admin of the launchpad and
///      all four price sources in one batch; the deployer renounces every
///      timelock role. **No EOA holds any power when the broadcast lands.**
///   9. `ReferralVault(admin = timelock, REFERRAL_SIGNER, WETH, proxy,
///      REFERRAL_MAX_PER_DAY)` — governed from birth.
///
/// Required env (the script refuses without each): the governance set from
/// `MainnetGuard` (`PROPOSERS`, `MIN_DELAY` >= 86400, `PAUSER`,
/// `NEW_OPS_WITHDRAW_AUTHORITY`, `NEW_MIGRATION_AUTHORITY`; `EXECUTORS`
/// optional), `STONKZ_PROTOCOL_WITHDRAW_AUTHORITY` (must differ from ops),
/// `REFERRAL_SIGNER` (non-zero), `REFERRAL_MAX_PER_DAY` (wei; non-zero,
/// not uncapped). Optional: `STONKZ_ORACLE_AUTHORITY` (0), `STOCK_PRICE_ATTESTER`
/// (0 = attested leg off), `MAX_BUY_NATIVE` (0 = **uncapped**, printed as a
/// warning; changeable later via `setConfig`), `PYTH_MAX_AGE` (120), `ETH_MIN_PRICE_1E6` (100e6),
/// `ETH_MAX_PRICE_1E6` (100 000e6), `EXPECT_CHAIN_ID`, `PRIVATE_KEY` (else
/// sign with `--ledger` / `--account` + `--sender`).
///
/// ```
/// export PROPOSERS=0x<Safe> MIN_DELAY=86400 PAUSER=0x<hot pauser>
/// export NEW_OPS_WITHDRAW_AUTHORITY=0x... NEW_MIGRATION_AUTHORITY=0x...
/// export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
/// export REFERRAL_SIGNER=0x<API signer> REFERRAL_MAX_PER_DAY=1000000000000000000
/// EXPECT_CHAIN_ID=4663 forge script script/DeployMainnet.s.sol:DeployMainnet \
///   --rpc-url $RH_RPC_URL --ledger --sender 0x<deployer> -vvv          # dry run
/// # ... then the same with --broadcast --verify
/// ```
/// Arc (5042) is deferred: this script refuses it (`DeployArc` fails closed
/// on its own placeholders).
contract DeployMainnet is Script {
    /// Launchpad-wide clamp; the per-feed Pyth bound (120 s) is the effective
    /// one for WETH, and heartbeat + grace for the Chainlink fallback.
    uint64 public constant MAX_ORACLE_STALENESS = 90_000;
    uint64 public constant DEFAULT_PYTH_MAX_AGE = 120;
    uint64 public constant DEFAULT_ETH_MIN_USD_1E6 = 100e6;
    uint64 public constant DEFAULT_ETH_MAX_USD_1E6 = 100_000e6;
    /// A dollar stablecoin outside this band is a broken feed or a broken peg.
    uint128 public constant STABLE_MIN_USD_1E6 = 0.9e6;
    uint128 public constant STABLE_MAX_USD_1E6 = 1.1e6;

    struct Params {
        address protocolAuthority;
        /// `PushPriceSource.oracleAuthority`; zero = nobody can push.
        address oracleAuthority;
        address referralSigner;
        uint256 referralMaxPerDay;
        /// `StockPriceSourceV2.attester`; zero leaves the attested leg off.
        address attester;
        /// Router per-buy cap in native wei; 0 = uncapped.
        uint256 maxBuyNative;
        uint64 pythMaxAge;
        uint64 ethMin1e6;
        uint64 ethMax1e6;
        MainnetGuard.Governance gov;
    }

    struct Result {
        address pushPriceSource;
        address chainlinkPriceSource;
        address pythPriceSource;
        address stockPriceSourceV2;
        address launchpad;
        address launchpadImpl;
        address router;
        address feeLocker;
        address v3Migrator;
        address referralVault;
        address timelock;
        address v3Factory;
        uint24 poolFee;
    }

    function run() external returns (Result memory) {
        // First: a mainnet run without the governance env stops here, naming
        // the missing variable.
        MainnetGuard.Governance memory g = MainnetGuard.requireOnMainnet();
        _requireSupportedChain();
        uint256 expect = vm.envOr("EXPECT_CHAIN_ID", uint256(0));
        if (expect != 0) require(block.chainid == expect, "DeployMainnet: unexpected chain id");
        Params memory p = paramsFromEnv(g);
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.rememberKey(pk) : msg.sender;
        return execute(p, deployer);
    }

    /// @notice The constants, with the governance set; env-free so tests can
    /// fill the rest in.
    function defaults(MainnetGuard.Governance memory g) public pure returns (Params memory p) {
        p.pythMaxAge = DEFAULT_PYTH_MAX_AGE;
        p.ethMin1e6 = DEFAULT_ETH_MIN_USD_1E6;
        p.ethMax1e6 = DEFAULT_ETH_MAX_USD_1E6;
        p.gov = g;
    }

    function paramsFromEnv(MainnetGuard.Governance memory g) public view returns (Params memory p) {
        p = defaults(g);
        p.protocolAuthority = vm.envAddress("STONKZ_PROTOCOL_WITHDRAW_AUTHORITY");
        p.oracleAuthority = vm.envOr("STONKZ_ORACLE_AUTHORITY", address(0));
        p.referralSigner = vm.envAddress("REFERRAL_SIGNER");
        p.referralMaxPerDay = vm.envUint("REFERRAL_MAX_PER_DAY");
        p.attester = vm.envOr("STOCK_PRICE_ATTESTER", address(0));
        p.maxBuyNative = vm.envOr("MAX_BUY_NATIVE", uint256(0));
        p.pythMaxAge = uint64(vm.envOr("PYTH_MAX_AGE", uint256(p.pythMaxAge)));
        p.ethMin1e6 = uint64(vm.envOr("ETH_MIN_PRICE_1E6", uint256(p.ethMin1e6)));
        p.ethMax1e6 = uint64(vm.envOr("ETH_MAX_PRICE_1E6", uint256(p.ethMax1e6)));
    }

    /// @notice The whole deployment, signed by `deployer` (admin of everything
    /// for the length of the broadcast, nothing afterwards). Public so the
    /// test suite drives the exact code path the broadcast takes.
    function execute(Params memory p, address deployer) public returns (Result memory r) {
        _requireSupportedChain();
        MainnetGuard.validate(p.gov);
        require(
            deployer != DEFAULT_SENDER && deployer != address(0),
            "DeployMainnet: pass the signer (--ledger/--account + --sender, or PRIVATE_KEY)"
        );
        require(
            p.protocolAuthority != address(0), "DeployMainnet: STONKZ_PROTOCOL_WITHDRAW_AUTHORITY is zero"
        );
        require(
            p.protocolAuthority != p.gov.opsAuthority,
            "DeployMainnet: protocol and ops withdraw authorities must differ"
        );
        require(p.referralSigner != address(0), "DeployMainnet: REFERRAL_SIGNER is required (non-zero)");
        require(
            p.referralMaxPerDay != 0, "DeployMainnet: REFERRAL_MAX_PER_DAY is zero (WETH would stay disabled)"
        );
        require(
            p.referralMaxPerDay != type(uint256).max,
            "DeployMainnet: an uncapped referral vault is not allowed"
        );
        require(p.pythMaxAge > 0, "DeployMainnet: PYTH_MAX_AGE");
        require(p.ethMin1e6 > 0 && p.ethMax1e6 >= p.ethMin1e6, "DeployMainnet: ETH price band");

        Wiring memory w = _wiring();
        _preflight(w, p);

        vm.startBroadcast(deployer);

        // 1-3. Price sources; the deployer is their admin until the handover.
        PushPriceSource push = DeployPad.pushOracle(deployer, p.oracleAuthority, MAX_ORACLE_STALENESS);
        ChainlinkPriceSource chainlink = new ChainlinkPriceSource(deployer);
        chainlink.setFeed(
            w.weth,
            AggregatorV3Interface(w.chainlinkEthUsd),
            MAX_ORACLE_STALENESS,
            uint128(p.ethMin1e6),
            uint128(p.ethMax1e6)
        );
        if (w.chainlinkStableUsd != address(0)) {
            chainlink.setFeed(
                w.chainlinkStable,
                AggregatorV3Interface(w.chainlinkStableUsd),
                MAX_ORACLE_STALENESS,
                STABLE_MIN_USD_1E6,
                STABLE_MAX_USD_1E6
            );
        }
        PythPriceSource pyth = new PythPriceSource(deployer, IPyth(w.pyth));
        pyth.setFeed(w.weth, RouterWiring.PYTH_ETH_USD, p.pythMaxAge, p.ethMin1e6, p.ethMax1e6);
        for (uint256 i = 0; i < w.stables.length; i++) {
            pyth.setFixedPrice(w.stables[i], 1e6, p.pythMaxAge);
        }
        pyth.setFallbackSource(IPriceSource(address(chainlink)));

        // 4. The launchpad, priced by Pyth from its first block.
        StonkzLaunchpad pad = DeployPad.launchpad(
            deployer,
            p.protocolAuthority,
            p.gov.opsAuthority,
            IPriceSource(address(pyth)),
            p.gov.migrationAuthority
        );
        if (pad.maxOracleStaleness() != MAX_ORACLE_STALENESS) {
            pad.setMaxOracleStaleness(MAX_ORACLE_STALENESS);
        }

        // 5. Stock pricing: deployed, governed, empty.
        StockPriceSourceV2 stock = new StockPriceSourceV2(
            deployer, IPyth(w.pyth), IPriceSource(address(pyth)), IPriceSource(address(push)), address(pad)
        );
        for (uint256 i = 0; i < w.stables.length; i++) {
            stock.setStableQuote(w.stables[i], true);
        }
        if (p.attester != address(0)) stock.setAttester(p.attester);

        // 6. Router and the implementation that trusts it.
        StonkzRouter router = new StonkzRouter(
            IUniversalRouter(w.ur),
            pad,
            IWETH9(w.weth),
            ISwapRouter02(w.sr02),
            p.maxBuyNative,
            IPyth(w.pyth),
            IStockAttestationSink(address(stock))
        );
        StonkzLaunchpad impl = new StonkzLaunchpad(address(router));
        pad.upgradeToAndCall(address(impl), "");

        // 7. Graduation: full-range V3 position in the locker, 1% tier.
        FeeLocker locker = new FeeLocker(ILaunchpadMigrator(address(pad)));
        UniswapV3Migrator migrator =
            new UniswapV3Migrator(IUniswapV3Factory(w.v3Factory), address(pad), locker, w.poolFee);

        // 8. Every admin power to the timelock, the pauser beside it, the
        //    migrator installed on the way; the deployer ends with nothing.
        GovernanceLib.Config memory c;
        c.launchpad = address(pad);
        c.priceSources = new address[](4);
        c.priceSources[0] = address(pyth);
        c.priceSources[1] = address(chainlink);
        c.priceSources[2] = address(stock);
        c.priceSources[3] = address(push);
        c.proposers = p.gov.proposers;
        c.executors = p.gov.executors;
        c.minDelay = p.gov.minDelay;
        c.protocolAuthority = p.protocolAuthority;
        c.opsAuthority = p.gov.opsAuthority;
        c.migrationAuthority = p.gov.migrationAuthority;
        c.migrator = address(migrator);
        c.pauser = p.gov.pauser;
        c.atomic = true;
        GovernanceLib.preflight(c, deployer);
        TimelockController timelock = GovernanceLib.handover(c, deployer);

        // 9. The referral vault, admin = the timelock from its first block.
        ReferralVault vault =
            new ReferralVault(address(timelock), p.referralSigner, w.weth, address(pad), p.referralMaxPerDay);

        vm.stopBroadcast();

        r = Result({
            pushPriceSource: address(push),
            chainlinkPriceSource: address(chainlink),
            pythPriceSource: address(pyth),
            stockPriceSourceV2: address(stock),
            launchpad: address(pad),
            launchpadImpl: address(impl),
            router: address(router),
            feeLocker: address(locker),
            v3Migrator: address(migrator),
            referralVault: address(vault),
            timelock: address(timelock),
            v3Factory: w.v3Factory,
            poolFee: w.poolFee
        });
        GovernanceLib.verify(c, deployer, timelock);
        _verify(r, p, w, deployer);
        _report(r, p, w, c);
    }

    /* ------------------------------------------------------------ wiring */

    struct Wiring {
        address ur;
        address weth;
        address sr02;
        address pyth;
        address v3Factory;
        uint24 poolFee;
        address chainlinkEthUsd;
        address chainlinkStableUsd;
        address chainlinkStable;
        address[] stables;
    }

    function _wiring() internal view returns (Wiring memory w) {
        (w.ur, w.weth, w.sr02, w.pyth) = RouterWiring.forChain();
        (w.v3Factory, w.poolFee) = RouterWiring.v3();
        (w.chainlinkEthUsd, w.chainlinkStableUsd, w.chainlinkStable) = RouterWiring.chainlink();
        w.stables = RouterWiring.stables();
    }

    function _requireSupportedChain() internal view {
        require(
            block.chainid == RobinhoodChain.MAINNET_CHAIN_ID || block.chainid == Base.CHAIN_ID,
            "DeployMainnet: only RH 4663 and Base 8453 (Arc 5042 is deferred; testnets use DeployTestnet/DeployBaseSepolia)"
        );
    }

    /// @dev Third-party code this deployment hard-depends on must exist on
    /// the chain we are pointed at, and the V3 factory must have the tier the
    /// migrator is built for. A typo or wrong-fork RPC fails here, not on a
    /// user's first trade.
    function _preflight(Wiring memory w, Params memory p) internal view {
        _requireCode(w.ur, "UniversalRouter");
        _requireCode(w.weth, "WETH9");
        _requireCode(w.sr02, "SwapRouter02");
        _requireCode(w.pyth, "Pyth");
        _requireCode(w.v3Factory, "UniswapV3Factory");
        _requireCode(w.chainlinkEthUsd, "Chainlink ETH/USD");
        if (w.chainlinkStableUsd != address(0)) _requireCode(w.chainlinkStableUsd, "Chainlink stable/USD");
        for (uint256 i = 0; i < w.stables.length; i++) {
            _requireCode(w.stables[i], "stablecoin base");
        }
        require(w.poolFee != 0, "DeployMainnet: no graduation pool fee pinned");
        require(
            IUniswapV3Factory(w.v3Factory).feeAmountTickSpacing(w.poolFee) == 200,
            "DeployMainnet: the 1% tier (tick spacing 200) is not enabled on the V3 factory"
        );
        console2.log("chain                ", block.chainid);
        console2.log(
            "deploying the testnet-proven stack: Pyth + Chainlink fallback, V3 FeeLocker, StockV2 (empty),"
        );
        console2.log("ReferralVault, atomic timelock handover.");
        // Informational: is the on-chain ETH/USD print usable right now? A
        // launch carries its own Hermes update, so a stale print here is not
        // a blocker — but "never updated" means Hermes must be wired first.
        try IPyth(w.pyth).getPriceUnsafe(RouterWiring.PYTH_ETH_USD) returns (IPyth.Price memory q) {
            console2.log(
                string.concat(
                    "Pyth ETH/USD on chain: price ",
                    vm.toString(int256(q.price)),
                    " expo ",
                    vm.toString(int256(q.expo)),
                    " publishTime ",
                    vm.toString(q.publishTime)
                )
            );
            if (q.publishTime + p.pythMaxAge < block.timestamp) {
                console2.log(
                    "  (older than PYTH_MAX_AGE: every launch must carry a Hermes update, as the app does)"
                );
            }
        } catch {
            console2.log("Pyth ETH/USD on chain: no print yet (every launch must carry a Hermes update)");
        }
        if (p.maxBuyNative == 0) {
            console2.log("");
            console2.log("!!! WARNING: MAX_BUY_NATIVE=0 - the router has NO per-buy cap on mainnet. !!!");
            console2.log("!!! Set MAX_BUY_NATIVE (wei) for a capped soft launch, or set it later through !!!");
            console2.log(
                "!!! the timelock with StonkzRouter.setConfig (script/SetRouterConfig.s.sol).    !!!"
            );
            console2.log("");
        } else {
            console2.log("router per-buy cap (wei)", p.maxBuyNative);
        }
    }

    function _requireCode(address a, string memory what) internal view {
        if (a.code.length == 0) {
            console2.log("DeployMainnet: no code at pinned address for", what, a);
            revert("DeployMainnet: pinned dependency has no code on this chain");
        }
    }

    /* ------------------------------------------------------------ verify */

    function _verify(Result memory r, Params memory p, Wiring memory w, address deployer) internal view {
        StonkzLaunchpad pad = StonkzLaunchpad(r.launchpad);
        TimelockController tl = TimelockController(payable(r.timelock));
        require(pad.admin() == r.timelock && pad.pendingAdmin() == address(0), "launchpad admin");
        require(pad.trustedRouter() == r.router, "router not trusted");
        require(address(pad.priceSource()) == r.pythPriceSource, "price source");
        require(pad.maxOracleStaleness() == MAX_ORACLE_STALENESS, "staleness");
        require(address(pad.migrator()) == r.v3Migrator, "migrator");
        require(pad.migrationAuthority() == p.gov.migrationAuthority, "migration authority");
        require(pad.protocolWithdrawAuthority() == p.protocolAuthority, "protocol authority");
        require(pad.opsWithdrawAuthority() == p.gov.opsAuthority, "ops authority");
        require(pad.pauser() == p.gov.pauser, "pauser");
        // Nothing set: the defaults apply, and slots 17/18 were never written.
        require(pad.paramsWord() == CurveMath.DEFAULT_PARAMS, "paramsWord is not the defaults");
        require(uint256(vm.load(r.launchpad, bytes32(uint256(17)))) == 0, "slot 17 (_params) written");
        require(uint256(vm.load(r.launchpad, bytes32(uint256(18)))) == 0, "slot 18 (_router) written");
        require(PythPriceSource(r.pythPriceSource).admin() == r.timelock, "pyth source admin");
        require(ChainlinkPriceSource(r.chainlinkPriceSource).admin() == r.timelock, "chainlink source admin");
        require(StockPriceSourceV2(r.stockPriceSourceV2).admin() == r.timelock, "stock source admin");
        require(PushPriceSource(r.pushPriceSource).admin() == r.timelock, "push source admin");
        require(
            address(PythPriceSource(r.pythPriceSource).fallbackSource()) == r.chainlinkPriceSource,
            "pyth fallback"
        );
        StockPriceSourceV2 stock = StockPriceSourceV2(r.stockPriceSourceV2);
        require(address(stock.quotePriceSource()) == r.pythPriceSource, "stock quote source");
        require(address(stock.fallbackSource()) == r.pushPriceSource, "stock fallback");
        require(stock.attester() == p.attester, "attester");
        require(stock.launchpad() == r.launchpad, "stock launchpad");
        require(PushPriceSource(r.pushPriceSource).oracleAuthority() == p.oracleAuthority, "oracle authority");
        StonkzRouter router = StonkzRouter(payable(r.router));
        require(address(router.launchpad()) == r.launchpad, "router launchpad");
        require(address(router.weth()) == w.weth && address(router.pyth()) == w.pyth, "router wiring");
        require(address(router.swapRouter02()) == w.sr02, "router sr02");
        require(address(router.attestationSink()) == r.stockPriceSourceV2, "router sink");
        require(router.maxBuyNative() == p.maxBuyNative, "router cap");
        require(address(FeeLocker(r.feeLocker).launchpad()) == r.launchpad, "locker launchpad");
        UniswapV3Migrator m = UniswapV3Migrator(r.v3Migrator);
        require(m.launchpad() == r.launchpad && address(m.locker()) == r.feeLocker, "migrator wiring");
        require(address(m.factory()) == w.v3Factory && m.fee() == w.poolFee, "migrator factory/fee");
        ReferralVault v = ReferralVault(payable(r.referralVault));
        require(v.admin() == r.timelock && v.signer() == p.referralSigner, "vault admin/signer");
        require(v.weth() == w.weth && v.launchpad() == r.launchpad, "vault wiring");
        require(v.maxPerDay(w.weth) == p.referralMaxPerDay, "vault cap");
        require(v.launchpadPauser() == p.gov.pauser, "vault pauser");
        require(tl.getMinDelay() == p.gov.minDelay, "timelock delay");
        require(
            !tl.hasRole(tl.PROPOSER_ROLE(), deployer) && !tl.hasRole(tl.EXECUTOR_ROLE(), deployer)
                && !tl.hasRole(tl.CANCELLER_ROLE(), deployer)
                && !tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), deployer),
            "deployer still holds a timelock role"
        );
    }

    /* ------------------------------------------------------------ report */

    function _net() internal view returns (string memory) {
        return block.chainid == Base.CHAIN_ID ? "BASE" : "RH";
    }

    function _report(Result memory r, Params memory p, Wiring memory w, GovernanceLib.Config memory c)
        internal
        view
    {
        string memory net = _net();
        console2.log("");
        console2.log("=== Deployed (chain %s), governed ===", block.chainid);
        console2.log("TimelockController   :", r.timelock);
        console2.log("StonkzLaunchpad      :", r.launchpad);
        console2.log("  implementation     :", r.launchpadImpl);
        console2.log("StonkzRouter         :", r.router);
        console2.log("PythPriceSource      :", r.pythPriceSource);
        console2.log("ChainlinkPriceSource :", r.chainlinkPriceSource);
        console2.log("StockPriceSourceV2   :", r.stockPriceSourceV2);
        console2.log("PushPriceSource      :", r.pushPriceSource);
        console2.log("FeeLocker            :", r.feeLocker);
        console2.log("UniswapV3Migrator    :", r.v3Migrator);
        console2.log("ReferralVault        :", r.referralVault);
        GovernanceLib.report(c, TimelockController(payable(r.timelock)));

        console2.log("");
        console2.log("=== deployments/%s.json (fill rpc/explorer/deployedAt/block) ===", block.chainid);
        console2.log("{");
        console2.log('  "chainId": %s,', block.chainid);
        console2.log(
            '  "network": "%s",', block.chainid == Base.CHAIN_ID ? "base-mainnet" : "robinhood-mainnet"
        );
        console2.log('  "admin": "%s",', r.timelock);
        console2.log('  "contracts": {');
        _kv("TimelockController", r.timelock);
        _kv("StonkzLaunchpad", r.launchpad);
        _kv("StonkzRouter", r.router);
        _kv("PythPriceSource", r.pythPriceSource);
        _kv("ChainlinkPriceSource", r.chainlinkPriceSource);
        _kv("StockPriceSourceV2", r.stockPriceSourceV2);
        _kv("PushPriceSource", r.pushPriceSource);
        _kv("FeeLocker", r.feeLocker);
        _kv("UniswapV3Migrator", r.v3Migrator);
        _kv("ReferralVault", r.referralVault);
        _kv("ReferralSigner", p.referralSigner);
        _kv("Pauser", p.gov.pauser);
        console2.log('    "Pyth": "%s"', w.pyth);
        console2.log("  },");
        console2.log('  "tokens": {');
        _kv("WETH9", w.weth);
        for (uint256 i = 0; i < w.stables.length; i++) {
            _kv(block.chainid == Base.CHAIN_ID ? "USDC" : "USDG", w.stables[i]);
        }
        _kv("UniversalRouter", w.ur);
        _kv("SwapRouter02", w.sr02);
        _kv("V3Factory", w.v3Factory);
        console2.log('    "GraduationPoolFee": %s', uint256(w.poolFee));
        console2.log("  },");
        console2.log(
            '  "implementation": { "StonkzLaunchpad": "%s", "trustedRouter": "%s" }',
            r.launchpadImpl,
            r.router
        );
        console2.log("}");

        console2.log("");
        console2.log("=== apps/api + indexer env ===");
        console2.log("%s_CHAIN_ID=%s", net, block.chainid);
        console2.log("%s_LAUNCHPAD_ADDRESS=%s", net, r.launchpad);
        console2.log("%s_ROUTER_ADDRESS=%s", net, r.router);
        console2.log("REFERRAL_VAULT_ADDRESS_%s=%s", net, r.referralVault);
        console2.log("REFERRAL_ASSET_%s=%s:18:WETH", net, w.weth);
        console2.log("%s_V3_FACTORY_ADDRESS=%s", net, w.v3Factory);
        console2.log(
            "%s_V3_FEE_TIER_OVERRIDES=   # pin by hand per aggregator-hop base (docs/deployment.md 3.1)", net
        );
        console2.log(
            "%s_V3_QUOTER_ADDRESS=       # a V3ExactInputQuoter-ABI quoter, or leave unset (no pool hop)", net
        );
        console2.log("INDEXER_%s_START_BLOCK=<this deployment's block>", net);
        console2.log(
            "# stock bases are not in v1 scope: leave STOCK_PRICE_SOURCE_%s / STOCK_PRICE_ATTESTER_KEY unset",
            net
        );

        console2.log("");
        console2.log("=== Safe / verify checklist (do each against the chain, not this log) ===");
        console2.log("1. forge verify-contract every address above (--verify, or by hand); the proxy's");
        console2.log("   implementation slot must equal the implementation above.");
        console2.log("2. On the Safe: confirm it is PROPOSER + CANCELLER (and EXECUTOR) of the timelock,");
        console2.log("   getMinDelay() == MIN_DELAY, and the deployer holds no timelock role.");
        console2.log("3. launchpad.admin() == timelock, pauser() == PAUSER, migrator() == UniswapV3Migrator,");
        console2.log(
            "   priceSource() == PythPriceSource, maxOracleStaleness() == 90000, trustedRouter() == router,"
        );
        console2.log(
            "   paramsWord() == CurveMath.DEFAULT_PARAMS (docs/parameters.md); router.maxBuyNative()."
        );
        console2.log("4. Every price source + ReferralVault: admin() == timelock, pendingAdmin() == 0.");
        console2.log(
            "5. Fund the vault from the protocol authority: withdrawTreasury(0, WETH, amount, vault)."
        );
        console2.log(
            "6. API: PYTH_HERMES_URL/API_KEY set (launches carry an update); REFERRAL_SIGNER_KEY_EVM"
        );
        console2.log(
            "   is the key behind REFERRAL_SIGNER; write deployments/%s.json; node scripts/emit-chains.mjs.",
            block.chainid
        );
        console2.log(
            "7. Rehearsal from the pauser key: pause(true,...), then the Safe schedules setPause(false,...)."
        );
        console2.log("8. Record this deployment in docs/deployment.md and docs/real-vs-simulated.md.");
    }

    function _kv(string memory k, address v) internal pure {
        console2.log('    "%s": "%s",', k, v);
    }
}
