// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {CurveMath} from "./CurveMath.sol";
import {SafeErc20} from "./SafeErc20.sol";
import {StonkzToken} from "./StonkzToken.sol";
import {IPriceSource} from "./oracle/IPriceSource.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice Creates the graduation pool and disposes of the LP. Swapped per
/// deployment so the DEX choice is config, not code. See `ASSUMPTIONS.md`.
interface IGraduationMigrator {
    function migrate(address token, address baseToken, uint256 tokenAmount, uint256 baseAmount)
        external
        returns (address pool, uint256 liquidityBurned);
}

/// @title Stonkz bonding-curve launchpad, EVM mirror.
/// @notice Same interface, same 15/10/6/69 split, same $69K graduation and the
/// same vault layout in spirit as `programs/solana`. The differences that are
/// real rather than incidental are catalogued in `ASSUMPTIONS.md`.
///
/// Solana's per-coin PDA vaults become balances tracked in this contract's
/// storage; the money is in one place but the ledgers are as separate as the
/// PDAs were, and no function lets one ledger draw on another.
///
/// Deployed behind a UUPS proxy through public beta so logic can change without
/// migrating curve balances. `_authorizeUpgrade` is admin-gated.
contract StonkzLaunchpad is Initializable, UUPSUpgradeable {
    using CurveMath for CurveMath.State;

    /* ------------------------------------------------------------- storage */

    struct Coin {
        address token;
        address baseToken;
        address creator;
        uint8 baseDecimals;
        uint16 feeBps;
        bool cashback;
        bool complete;
        bool graduated;
        uint8 graduationReason; // 0 = curve complete, 1 = oracle price
        uint64 cbStart;
        uint64 graduatedAt;
        uint256 supply;
        uint256 virtualBase;
        uint256 virtualToken;
        uint256 realBase;
        uint256 realToken;
        uint256 k;
        uint256 tokensForSale;
        uint256 lpReserve;
        uint256 gradMcapBase;
        uint256 creationPrice1e6;
        // fee ledger
        uint256 protocolAccrued;
        uint256 opsAccrued;
        uint256 creatorBucketAccrued;
        uint256 creatorClaimableBase;
        uint256 creatorClaimableToken;
        // the 69% bucket, held here, split by ledger between creator and pool
        uint256 bucketBase;
        uint256 bucketToken;
        // stake pool
        uint256 eligibleStaked;
        uint256 flexStaked;
        uint256 totalWeight;
        uint256 accBasePerWeight;
        uint256 accTokenPerWeight;
        uint256 poolDustBase;
        uint256 poolDustToken;
        uint256 stakerAccruedBase;
        uint256 stakerAccruedToken;
        /// Appended last (UUPS storage): the burn leg (RWA crate fund) accrued by this coin.
        uint256 burnAccrued;
    }

    struct Position {
        uint256 amount;
        uint256 weight;
        uint256 baseDebt;
        uint256 tokenDebt;
        uint256 unclaimedBase;
        uint256 unclaimedToken;
        uint64 lockUntil;
        uint16 lockDays;
    }

    /// @dev Was `public coins`; the getter is now written out below (`coins`)
    /// because the auto-generated 38-output getter cost ~850 B of runtime and
    /// the contract sits at the EIP-170 ceiling. Same slot (0), same selector,
    /// same return bytes.
    mapping(address => Coin) internal _coins;
    /// @dev Was `public`; the generated 8-output getter is gone for the same
    /// reason as `coins` (size), `positionInfo` is the read path. Same slot (1).
    mapping(address => mapping(address => Position)) internal positions;
    mapping(bytes32 => address) public tokenByTicker;

    /// Treasury balances per base token. Not claimable by any user path.
    mapping(address => uint256) public protocolRevenue;
    /// $STONKZ buyback vault (historical `ops` name): half of what it buys goes
    /// into crates, half is burned.
    mapping(address => uint256) public stonkzOps;

    address public admin;
    address public pendingAdmin;
    /// Multisig / cold. Never a server key.
    address public protocolWithdrawAuthority;
    /// Multisig / cold, distinct from the protocol one.
    address public opsWithdrawAuthority;
    address public migrationAuthority;
    IGraduationMigrator public migrator;
    IPriceSource public priceSource;

    bool public tradingPaused;
    bool public launchPaused;
    bool public protocolWithdrawalsPaused;
    /// Stops ops money leaving. Trading and accrual are unaffected — step 141.
    bool public opsWithdrawalsPaused;
    /// Stops the oracle-triggered graduation only. An exhausted curve still
    /// graduates: that trigger reads no oracle, so pausing it would strand a
    /// finished coin for no reason.
    bool public oracleGraduationPaused;

    /// @notice Ceiling on how stale a price may be, in seconds.
    ///
    /// **86400 + 3600, not one hour.** The ETH/USD feed on Robinhood Chain has
    /// a 24-hour heartbeat, so it only writes a round when the price moves past
    /// the deviation threshold or a day elapses. A conventional one-hour guard
    /// would read a perfectly healthy feed as stale almost all the time and
    /// make oracle-triggered graduation unreachable. `docs/robinhood-chain.md`
    /// §4.4 names this as the single most likely way to ship a graduation
    /// function that can never fire.
    ///
    /// The price is consequently fuzzy at the margin, and that is accepted
    /// rather than papered over: the $69K threshold is a trigger, not a
    /// settlement price. Nothing is priced off the oracle — fills are priced
    /// off the curve.
    uint64 public maxOracleStaleness;
    uint256 public tokenCount;

    /// RWA crate fund, per base token (the former burn vault; historical name).
    /// Buys real-world assets for crates. Not claimable by any user path.
    /// Storage slot 14: every earlier slot is already live behind the RH and
    /// Base proxies, so new state goes at the END of the layout (after
    /// `_lock`, below), never next to its siblings.
    mapping(address => uint256) public stonkzBurn;

    /// Reentrancy guard, slot 15. Nothing may ever be declared above it: a
    /// variable inserted there shifts it to an empty slot and every
    /// `nonReentrant` entry point reverts. `test_StorageLayoutIsAppendOnly`
    /// pins it. New state goes *below*, one slot at a time.
    uint256 private _lock;

    /// @notice Emergency pauser, slot 16 (appended after `_lock`). May only
    /// *set* pause flags, through `pause` — never clear them, withdraw,
    /// upgrade or change configuration. Unpausing stays with `admin` (the
    /// timelock after the governance handover), so a leaked pauser key can
    /// at worst halt the launchpad until governance unpauses it. Zero: none.
    address public pauser;

    /* -------------------------------------------------------------- events */

    event TokenCreated(
        address indexed token,
        address indexed baseToken,
        address indexed creator,
        string ticker,
        uint256 supply,
        uint16 feeBps,
        bool cashback,
        uint64 cbStart,
        uint256 virtualBase,
        uint256 virtualToken,
        uint256 tokensForSale,
        uint256 lpReserve,
        uint256 gradMcapBase,
        uint256 basePrice1e6
    );

    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 baseAmount,
        uint256 tokenAmount,
        uint16 effFeeBps,
        bool inCashback,
        uint256 feeTotal,
        uint256 feeProtocol,
        uint256 feeOps,
        uint256 feeBurn,
        uint256 feeCreatorBucket,
        uint256 feeStakers,
        uint256 feeCreator,
        uint256 cashbackTokens,
        uint256 virtualBase,
        uint256 virtualToken,
        uint256 realBase,
        uint256 realToken
    );

    event FeeAccrued(
        address indexed token,
        address indexed baseToken,
        uint256 feeTotal,
        uint256 protocol,
        uint256 ops,
        uint256 burn,
        uint256 creatorBucket
    );
    event TreasuryCredit(
        address indexed baseToken, uint256 protocolDelta, uint256 opsDelta, uint256 burnDelta
    );
    event TreasuryWithdrawn(address indexed baseToken, uint8 which, uint256 amount, address to);
    event Graduated(
        address indexed token,
        uint8 reason,
        uint256 baseMigrated,
        uint256 tokensMigrated,
        uint256 tokensBurned,
        uint256 mcapBase,
        uint256 mcapUsd1e6
    );
    event LiquidityMigrated(address indexed token, address pool, uint256 liquidityBurned);
    /// @notice Post-graduation pool fees routed in through `accrueExternalFees`.
    /// Emitted after the `FeeAccrued` + `TreasuryCredit` pair for the base
    /// side, carrying what those cannot: the token side and the staker peel
    /// of each (the indexer reads the peel off `Trade` for a curve fill; a
    /// pool claim has no `Trade`).
    event PoolFeesAccrued(
        address indexed token,
        uint256 baseAmount,
        uint256 tokenAmount,
        uint256 stakersBase,
        uint256 stakersToken
    );
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 base, uint256 tokens);
    event Staked(
        address indexed token,
        address indexed owner,
        uint256 amount,
        uint16 lockDays,
        uint256 weight,
        uint64 lockUntil
    );
    event Unstaked(address indexed token, address indexed owner, uint256 amount);
    event StakeClaimed(address indexed token, address indexed owner, uint256 base, uint256 tokens);
    event PauserSet(address pauser);

    /* ------------------------------------------------------------ modifiers */

    // The checks live in functions rather than inline in the modifiers so
    // they are emitted once, not per entry point: the contract sits at the
    // EIP-170 ceiling. Behaviour and revert strings are unchanged.
    modifier nonReentrant() {
        _enter();
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        _onlyAdmin();
        _;
    }

    function _enter() private {
        require(_lock == 1, "reentrant");
        _lock = 2;
    }

    function _onlyAdmin() private view {
        require(msg.sender == admin, "not admin");
    }

    /// @notice The one router allowed to call `createTokenFor`, i.e. to launch a
    /// coin on a user's behalf and dev-buy it in the same transaction.
    /// @dev An `immutable`, so it lives in the implementation's bytecode and
    /// takes **no storage slot** (the proxy layout is append-only and pinned by
    /// `test_StorageLayoutIsAppendOnly`). Changing it means deploying a new
    /// implementation and `upgradeToAndCall` — the same admin gate as any
    /// other logic change. `address(0)` disables `createTokenFor` entirely.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable trustedRouter;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _trustedRouter) {
        trustedRouter = _trustedRouter;
        _disableInitializers();
    }

    function initialize(
        address _admin,
        address _protocolWithdrawAuthority,
        address _opsWithdrawAuthority,
        IPriceSource _priceSource,
        address _migrationAuthority
    ) external initializer {
        require(
            _admin != address(0) && _protocolWithdrawAuthority != address(0)
                && _opsWithdrawAuthority != address(0),
            "zero authority"
        );
        admin = _admin;
        protocolWithdrawAuthority = _protocolWithdrawAuthority;
        opsWithdrawAuthority = _opsWithdrawAuthority;
        priceSource = _priceSource;
        migrationAuthority = _migrationAuthority;
        maxOracleStaleness = 90_000;
        _lock = 1;
    }

    function _authorizeUpgrade(address) internal override onlyAdmin {}

    /* ---------------------------------------------------------------- admin */

    function setPause(
        bool trading,
        bool launch,
        bool protocolWithdrawals,
        bool opsWithdrawals,
        bool oracleGraduation
    ) external onlyAdmin {
        tradingPaused = trading;
        launchPaused = launch;
        protocolWithdrawalsPaused = protocolWithdrawals;
        opsWithdrawalsPaused = opsWithdrawals;
        oracleGraduationPaused = oracleGraduation;
    }

    function setPauser(address p) external onlyAdmin {
        pauser = p;
        emit PauserSet(p);
    }

    /// @notice Emergency stop for the pauser (or admin): each `true` sets that
    /// flag; `false` leaves it as it is. Nothing here can unpause — that is
    /// `setPause`, admin only.
    function pause(
        bool trading,
        bool launch,
        bool protocolWithdrawals,
        bool opsWithdrawals,
        bool oracleGraduation
    ) external {
        require(msg.sender == pauser || msg.sender == admin, "not pauser");
        if (trading) tradingPaused = true;
        if (launch) launchPaused = true;
        if (protocolWithdrawals) protocolWithdrawalsPaused = true;
        if (opsWithdrawals) opsWithdrawalsPaused = true;
        if (oracleGraduation) oracleGraduationPaused = true;
    }

    function setMigrator(IGraduationMigrator m, address authority) external onlyAdmin {
        migrator = m;
        migrationAuthority = authority;
    }

    function setWithdrawAuthorities(address protocol, address ops) external onlyAdmin {
        require(protocol != address(0) && ops != address(0), "zero authority");
        protocolWithdrawAuthority = protocol;
        opsWithdrawAuthority = ops;
    }

    function proposeAdmin(address a) external onlyAdmin {
        pendingAdmin = a;
    }

    function acceptAdmin() external {
        require(pendingAdmin != address(0) && msg.sender == pendingAdmin, "not pending");
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    /* --------------------------------------------------------------- oracle */

    function setPriceSource(IPriceSource s) external onlyAdmin {
        require(address(s) != address(0), "zero source");
        priceSource = s;
    }

    /// @notice Clamp on whatever the source says its own tolerance is, so a
    /// misconfigured feed cannot widen the window without limit.
    function setMaxOracleStaleness(uint64 s) external onlyAdmin {
        require(s > 0, "staleness");
        maxOracleStaleness = s;
    }

    /// @return ok Whether there is a usable price right now.
    /// @return price1e6 The price, or zero.
    /// @dev Never reverts. Every caller needs a different answer to "the oracle
    /// is down" and only the caller knows which: `createToken` refuses,
    /// `graduate` defers, and `buy`/`sell` never ask. See
    /// `docs/robinhood-chain.md` §4.4 — a design where a stale Chainlink round
    /// reverts trades turns an oracle hiccup into a launchpad outage.
    function _tryPrice(address baseToken) internal view returns (bool ok, uint256 price1e6) {
        if (address(priceSource) == address(0)) return (false, 0);
        (uint256 p, uint256 publishedAt, uint256 sourceMaxAge) = priceSource.priceUsd1e6(baseToken);
        if (p == 0 || publishedAt == 0) return (false, 0);
        // The tighter of the feed's own tolerance and ours.
        uint256 bound = sourceMaxAge < maxOracleStaleness ? sourceMaxAge : maxOracleStaleness;
        if (block.timestamp < publishedAt) return (false, 0);
        if (block.timestamp - publishedAt > bound) return (false, 0);
        return (true, p);
    }

    /// @dev For the one call site that genuinely must have an answer.
    function _freshPrice(address baseToken) internal view returns (uint256) {
        (bool ok, uint256 p) = _tryPrice(baseToken);
        require(ok, "stale oracle");
        return p;
    }

    /* ------------------------------------------------------------ treasuries */

    function _checkFill(uint256 out, uint256 minOut, CurveMath.FeeShares memory s, uint256 fee) private pure {
        require(out >= minOut, "slippage");
        require(CurveMath.feeOf(s) == fee, "split");
    }

    function _notGraduated(Coin storage c) private view {
        require(!c.graduated, "graduated");
    }

    function _positive(uint256 amount) private pure {
        require(amount > 0, "amount");
    }

    function _known(Coin storage c) private view {
        require(c.token != address(0), "unknown token");
    }

    function _something(uint256 base, uint256 tokens) private pure {
        require(base > 0 || tokens > 0, "nothing");
    }

    function _gateWithdraw(address authority, bool paused, uint256 balance, uint256 amount) private view {
        require(msg.sender == authority, "not authority");
        require(!paused, "withdrawals paused");
        require(balance >= amount, "balance");
    }

    /// @dev One revert site for every token hand-out; the string is part of the API surface.
    function _payTokens(address token, address to, uint256 amount) private {
        require(StonkzToken(token).transfer(to, amount), "transfer");
    }

    function _pullTokens(address token, uint256 amount) private {
        require(StonkzToken(token).transferFrom(msg.sender, address(this), amount), "transferFrom");
    }

    /// @notice Neither treasury has a user-facing claim path. `claimCreatorFees`
    /// and `claimStake` read entirely different ledgers and cannot reach these.
    function withdrawTreasury(uint8 which, address baseToken, uint256 amount, address to)
        external
        nonReentrant
    {
        _positive(amount);
        require(to != address(0), "to zero");
        if (which == 0) {
            _gateWithdraw(
                protocolWithdrawAuthority, protocolWithdrawalsPaused, protocolRevenue[baseToken], amount
            );
            protocolRevenue[baseToken] -= amount;
        } else if (which == 1) {
            _gateWithdraw(opsWithdrawAuthority, opsWithdrawalsPaused, stonkzOps[baseToken], amount);
            stonkzOps[baseToken] -= amount;
        } else {
            // The RWA crate fund (historical `burn` vault) is swept by the same
            // ops authority, which buys real-world assets for crates with it.
            require(which == 2, "which");
            _gateWithdraw(opsWithdrawAuthority, opsWithdrawalsPaused, stonkzBurn[baseToken], amount);
            stonkzBurn[baseToken] -= amount;
        }
        _send(baseToken, to, amount);
        emit TreasuryWithdrawn(baseToken, which, amount, to);
    }

    /* ------------------------------------------------------------- creation */

    function createToken(
        string calldata name,
        string calldata ticker,
        string calldata uri,
        uint256 supply,
        address baseToken,
        uint16 feeBps,
        bool cashback
    ) external nonReentrant returns (address) {
        return _create(msg.sender, name, ticker, uri, supply, baseToken, feeBps, cashback);
    }

    /// @notice `createToken` on behalf of `creator`, callable only by
    /// `trustedRouter`. Lets the router create a coin and dev-buy it in one
    /// transaction, so there is no block in which the coin exists and the
    /// creator has not bought — the window snipers otherwise use.
    /// @dev `creator` is recorded, and emitted in `TokenCreated`, exactly as if
    /// they had called `createToken` themselves: creator fees and
    /// `claimCreatorFees` belong to them, never to the router.
    function createTokenFor(
        address creator,
        string calldata name,
        string calldata ticker,
        string calldata uri,
        uint256 supply,
        address baseToken,
        uint16 feeBps,
        bool cashback
    ) external nonReentrant returns (address) {
        require(msg.sender == trustedRouter, "not router");
        return _create(creator, name, ticker, uri, supply, baseToken, feeBps, cashback);
    }

    function _create(
        address creator,
        string calldata name,
        string calldata ticker,
        string calldata uri,
        uint256 supply,
        address baseToken,
        uint16 feeBps,
        bool cashback
    ) private returns (address token) {
        require(!launchPaused, "launch paused");
        require(_validTicker(ticker), "ticker");
        require(feeBps >= CurveMath.MIN_FEE_BPS && feeBps <= CurveMath.MAX_FEE_BPS, "fee");
        // Ceiling of the product's supply set (1e6/5e8/1e9/1e12). Unbounded,
        // a direct caller could launch a coin whose `mcapBase` overflows
        // mid-curve, so `graduate` always reverts and buyers' base is frozen
        // once the curve completes. See test/LaunchSupply.t.sol.
        require(supply <= CurveMath.MAX_SUPPLY, "supply");
        // Latest-by-ticker pointer only — duplicate tickers are allowed; the
        // app enforces a short cooldown, not a permanent bind.

        uint8 baseDecimals = IERC20(baseToken).decimals();
        uint256 price = _freshPrice(baseToken);
        uint256 supplyAtoms = supply * 1e18;
        CurveMath.CurveParams memory p = CurveMath.deriveCurve(supplyAtoms, price, baseDecimals);

        token = address(new StonkzToken(name, ticker, uri, supplyAtoms));
        tokenByTicker[keccak256(bytes(ticker))] = token;
        tokenCount += 1;

        Coin storage c = _coins[token];
        c.token = token;
        c.baseToken = baseToken;
        c.creator = creator;
        c.baseDecimals = baseDecimals;
        c.feeBps = feeBps;
        c.cashback = cashback;
        // Stamped by the contract. No function can move it, so no client can
        // extend the cashback window.
        c.cbStart = cashback ? uint64(block.timestamp) : 0;
        c.supply = supplyAtoms;
        c.virtualBase = p.virtualBase;
        c.virtualToken = p.virtualToken;
        c.realToken = p.tokensForSale;
        c.k = p.k;
        c.tokensForSale = p.tokensForSale;
        c.lpReserve = p.lpReserve;
        c.gradMcapBase = p.gradMcapBase;
        c.creationPrice1e6 = price;

        emit TokenCreated(
            token,
            baseToken,
            creator,
            ticker,
            supplyAtoms,
            feeBps,
            cashback,
            c.cbStart,
            p.virtualBase,
            p.virtualToken,
            p.tokensForSale,
            p.lpReserve,
            p.gradMcapBase,
            price
        );
    }

    /* ----------------------------------------------------------------- buy */

    /// @param minOut Enforced on this hop alone. A router composing a Uniswap
    /// leg in front of this carries its own bound on that leg.
    function buy(address token, uint256 amountBase, uint256 minOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        Coin storage c = _coins[token];
        _tradeGuard(c);
        _positive(amountBase);

        uint16 bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        bool inCashback = bps > c.feeBps;

        CurveMath.BuyFill memory f = CurveMath.buyQuote(_state(c), bps, amountBase);
        CurveMath.FeeShares memory s = CurveMath.splitFee(f.fee);
        // Slippage, then the identity the fee model rests on, asserted on every fill.
        _checkFill(f.tokensOut, minOut, s, f.fee);

        // Pull the whole gross once; routing happens in storage from here.
        _pull(c.baseToken, msg.sender, f.grossBase);

        protocolRevenue[c.baseToken] += s.protocol;
        stonkzOps[c.baseToken] += s.stonkzOps;
        stonkzBurn[c.baseToken] += s.burn;

        c.virtualBase += f.netBase;
        c.virtualToken -= f.tokensOut;
        c.realBase += f.netBase;
        c.realToken -= f.tokensOut;

        uint256 circ = CurveMath.circulating(c.tokensForSale, c.realToken);
        if (circ == 0) circ = 1;

        uint256 cashbackTokens;
        uint256 toCreator;
        uint256 toStakers;

        if (inCashback && s.creatorBucket > 0) {
            // Convert the bucket, and only the bucket, through this same curve
            // at zero fee. Protocol, ops and burn stay in the base token.
            uint256 out = CurveMath.zeroFeeBuy(_state(c), s.creatorBucket);
            if (out > 0) {
                cashbackTokens = out;
                c.virtualBase += s.creatorBucket;
                c.virtualToken -= out;
                c.realBase += s.creatorBucket;
                c.realToken -= out;
                c.bucketToken += out;
                (toCreator, toStakers) = _accrueBucketToken(c, out, circ);
            } else {
                c.bucketBase += s.creatorBucket;
                (toCreator, toStakers) = _accrueBucketBase(c, s.creatorBucket, circ);
            }
        } else {
            c.bucketBase += s.creatorBucket;
            (toCreator, toStakers) = _accrueBucketBase(c, s.creatorBucket, circ);
        }

        c.protocolAccrued += s.protocol;
        c.opsAccrued += s.stonkzOps;
        c.burnAccrued += s.burn;
        c.creatorBucketAccrued += s.creatorBucket;
        if (c.realToken == 0) c.complete = true;

        _payTokens(token, msg.sender, f.tokensOut);

        _emitFill(
            c,
            msg.sender,
            true,
            f.grossBase,
            f.tokensOut,
            bps,
            inCashback,
            s,
            toCreator,
            toStakers,
            cashbackTokens
        );
        return f.tokensOut;
    }

    /* ---------------------------------------------------------------- sell */

    function sell(address token, uint256 amountToken, uint256 minOut)
        external
        nonReentrant
        returns (uint256 baseOut)
    {
        Coin storage c = _coins[token];
        _tradeGuard(c);
        _positive(amountToken);

        uint16 bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        bool inCashback = bps > c.feeBps;

        CurveMath.SellFill memory f = CurveMath.sellQuote(_state(c), bps, amountToken);
        CurveMath.FeeShares memory s = CurveMath.splitFee(f.fee);
        _checkFill(f.netBase, minOut, s, f.fee);

        _pullTokens(token, amountToken);

        c.virtualBase -= f.grossBase;
        c.virtualToken += amountToken;
        c.realBase -= f.grossBase;
        c.realToken += amountToken;

        _creditFees(c, s);
        // A sell inside the cashback window pays the elevated fee, but its
        // bucket accrues in base: converting it would be buy pressure the
        // seller never asked for. See SPEC.md §3.
        c.bucketBase += s.creatorBucket;

        uint256 circ = CurveMath.circulating(c.tokensForSale, c.realToken);
        if (circ == 0) circ = 1;
        (uint256 toCreator, uint256 toStakers) = _accrueBucketBase(c, s.creatorBucket, circ);

        _send(c.baseToken, msg.sender, f.netBase);

        _emitFill(c, msg.sender, false, f.grossBase, amountToken, bps, inCashback, s, toCreator, toStakers, 0);
        return f.netBase;
    }

    /* ---------------------------------------------------------- creator fees */

    /// @notice Drains the creator ledger only. There is no path from here to
    /// `protocolRevenue`, `stonkzOps`, or the staker pool's share of the bucket.
    function claimCreatorFees(address token) external nonReentrant {
        Coin storage c = _coins[token];
        require(msg.sender == c.creator, "not creator");
        uint256 base = c.creatorClaimableBase;
        uint256 tokens = c.creatorClaimableToken;
        _something(base, tokens);
        c.creatorClaimableBase = 0;
        c.creatorClaimableToken = 0;
        c.bucketBase -= base;
        c.bucketToken -= tokens;
        if (base > 0) _send(c.baseToken, msg.sender, base);
        if (tokens > 0) _payTokens(token, msg.sender, tokens);
        emit CreatorFeesClaimed(token, msg.sender, base, tokens);
    }

    /* -------------------------------------------------------------- staking */

    function stake(address token, uint256 amount, uint16 lockDays) external nonReentrant {
        _positive(amount);
        Coin storage c = _coins[token];
        _known(c);
        Position storage p = positions[token][msg.sender];

        // Validate the argument before comparing it against stored state, so a
        // nonsense term reads as "lock term" rather than as a mismatch with
        // whatever the caller happens to hold.
        CurveMath.lockWeightBps(lockDays);

        if (p.amount == 0 && p.weight == 0 && p.unclaimedBase == 0 && p.unclaimedToken == 0) {
            p.lockDays = lockDays;
        } else {
            require(p.lockDays == lockDays, "lock mismatch");
        }

        _settle(c, p);
        uint256 oldAmount = p.amount;
        uint256 oldWeight = p.weight;

        _pullTokens(token, amount);
        p.amount = oldAmount + amount;
        // Topping up restarts the clock rather than letting an old position
        // carry a nearly-expired lock for new tokens.
        p.lockUntil = uint64(block.timestamp + uint256(lockDays) * 1 days);

        _reweigh(c, p, oldAmount, oldWeight);
        emit Staked(token, msg.sender, p.amount, lockDays, p.weight, p.lockUntil);
    }

    function unstake(address token, uint256 amount) external nonReentrant {
        _positive(amount);
        Coin storage c = _coins[token];
        Position storage p = positions[token][msg.sender];
        require(p.amount >= amount, "insufficient");
        // FLEX has a zero-day term so this passes immediately; every other term
        // is held to the second.
        require(block.timestamp >= p.lockUntil, "still locked");

        _settle(c, p);
        uint256 oldAmount = p.amount;
        uint256 oldWeight = p.weight;
        p.amount = oldAmount - amount;
        _reweigh(c, p, oldAmount, oldWeight);

        _payTokens(token, msg.sender, amount);
        emit Unstaked(token, msg.sender, amount);
    }

    function claimStake(address token) external nonReentrant {
        Coin storage c = _coins[token];
        Position storage p = positions[token][msg.sender];
        _settle(c, p);
        uint256 base = p.unclaimedBase;
        uint256 tokens = p.unclaimedToken;
        _something(base, tokens);
        p.unclaimedBase = 0;
        p.unclaimedToken = 0;
        c.bucketBase -= base;
        c.bucketToken -= tokens;
        if (base > 0) _send(c.baseToken, msg.sender, base);
        if (tokens > 0) _payTokens(token, msg.sender, tokens);
        emit StakeClaimed(token, msg.sender, base, tokens);
    }

    /* ------------------------------------------------------------ graduation */

    /// @notice Permissionless. Either trigger will do, so no operator can hold
    /// a token hostage on the curve, and a dead oracle can only remove the
    /// early trigger — never block an exhausted curve from graduating.
    function graduate(address token) external nonReentrant {
        Coin storage c = _coins[token];
        _known(c);
        _notGraduated(c);

        uint256 mcap = CurveMath.mcapBase(_state(c), c.supply);
        uint256 usd;
        uint8 reason;

        if (c.realToken == 0 || c.complete) {
            // Exhaustion consults no oracle, so a dead feed can never strand a
            // finished curve. The USD figure is reported at the creation price
            // purely for the event; the trigger is the empty reserve.
            reason = 0;
            usd = CurveMath.mcapUsd1e6(mcap, c.creationPrice1e6, c.baseDecimals);
        } else {
            reason = 1;
            require(!oracleGraduationPaused, "oracle graduation paused");
            // Oracle mcap uses virtual reserves — without a raise, migrateLiquidity
            // would always revert (baseAmount == 0). Refuse until realBase > 0.
            require(c.realBase > 0, "no base raised");
            uint256 price = _freshPrice(c.baseToken);
            usd = CurveMath.mcapUsd1e6(mcap, price, c.baseDecimals);
            require(usd >= CurveMath.GRAD_MCAP_USD_1E6, "not graduable");
        }

        // Unsold allocation is burned, not folded into the pool: adding it would
        // push the pool's opening price below the curve's closing price, which
        // the parameter choice in SPEC.md §1 exists to prevent.
        uint256 toBurn = c.realToken;
        if (toBurn > 0) {
            c.realToken = 0;
            StonkzToken(token).burn(toBurn);
        }
        c.complete = true;
        c.graduated = true;
        c.graduationReason = reason;
        c.graduatedAt = uint64(block.timestamp);

        emit Graduated(token, reason, c.realBase, c.lpReserve, toBurn, mcap, usd);
    }

    /// @notice Move the graduated reserves into the pool and dispose of the LP.
    /// @dev The configured migrator does the DEX-specific work. On Robinhood
    /// Chain that is `UniswapV2Migrator`, which burns fungible LP tokens to a
    /// dead address — see `ASSUMPTIONS.md` for why v2 rather than v3/v4.
    function migrateLiquidity(address token) external nonReentrant {
        require(msg.sender == migrationAuthority, "not migration authority");
        require(address(migrator) != address(0), "no migrator");
        Coin storage c = _coins[token];
        require(c.graduated, "not graduated");

        uint256 base = c.realBase;
        uint256 tokens = c.lpReserve;
        _something(base, tokens);
        // Zeroed before the external call so the release cannot be repeated.
        c.realBase = 0;
        c.lpReserve = 0;

        if (base > 0) _send(c.baseToken, address(migrator), base);
        if (tokens > 0) _payTokens(token, address(migrator), tokens);

        (address pool, uint256 burned) = migrator.migrate(token, c.baseToken, tokens, base);
        emit LiquidityMigrated(token, pool, burned);
    }

    /// @notice Route fees earned by a graduated coin's locked pool position
    /// into the same ledgers a curve fill feeds: the base side is split
    /// 15/10/6/69 exactly as `buy`/`sell` split a fee, the token side goes to
    /// the 69% bucket (the caller has already disposed of the treasury legs
    /// of it — see `FeeLocker`), and both bucket sides peel to stakers by
    /// the same rule. Pulls both amounts from the caller.
    /// @dev Callable by the configured `migrator` only — the `UniswapV3Migrator`
    /// forwards for its `FeeLocker`. Nothing here can leave the contract, so
    /// the gate protects the accounting, not the funds.
    function accrueExternalFees(address token, uint256 baseAmount, uint256 tokenAmount)
        external
        nonReentrant
    {
        require(msg.sender == address(migrator), "not migrator");
        Coin storage c = _coins[token];
        _known(c);
        _something(baseAmount, tokenAmount);
        if (baseAmount > 0) _pull(c.baseToken, msg.sender, baseAmount);
        if (tokenAmount > 0) _pullTokens(token, tokenAmount);

        CurveMath.FeeShares memory s = CurveMath.splitFee(baseAmount);
        _creditFees(c, s);
        c.bucketBase += s.creatorBucket;
        c.bucketToken += tokenAmount;

        uint256 circ = CurveMath.circulating(c.tokensForSale, c.realToken);
        if (circ == 0) circ = 1;
        (, uint256 stakersBase) = _accrueBucketBase(c, s.creatorBucket, circ);
        (, uint256 stakersToken) = _accrueBucketToken(c, tokenAmount, circ);

        _emitFee(c, s);
        emit PoolFeesAccrued(token, baseAmount, tokenAmount, stakersBase, stakersToken);
    }

    /* ---------------------------------------------------------------- views */

    function quoteBuy(address token, uint256 amountBase)
        external
        view
        returns (CurveMath.BuyFill memory fill, CurveMath.FeeShares memory shares, uint16 bps)
    {
        Coin storage c = _coins[token];
        bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        fill = CurveMath.buyQuote(_state(c), bps, amountBase);
        shares = CurveMath.splitFee(fill.fee);
    }

    function quoteSell(address token, uint256 amountToken)
        external
        view
        returns (CurveMath.SellFill memory fill, CurveMath.FeeShares memory shares, uint16 bps)
    {
        Coin storage c = _coins[token];
        bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        fill = CurveMath.sellQuote(_state(c), bps, amountToken);
        shares = CurveMath.splitFee(fill.fee);
    }

    /// @notice The whole coin record in one read.
    /// @dev The generated `coins` getter returns a 25-field positional tuple,
    /// which is unusable from both the indexer and the test suite. This returns
    /// the struct.
    function coinInfo(address token) external view returns (Coin memory) {
        return _coins[token];
    }

    /// @notice The former auto-generated getter, byte-for-byte: `Coin` holds
    /// only value types, so returning the struct ABI-encodes as the same flat
    /// 38-word tuple under the same `coins(address)` selector. Existing
    /// callers (the API's `curve-sync`) decode it unchanged; pinned by
    /// `test_CoinsGetterMatchesCoinInfoBytes`.
    function coins(address token) external view returns (Coin memory) {
        return _coins[token];
    }

    function positionInfo(address token, address owner) external view returns (Position memory) {
        return positions[token][owner];
    }

    function marketCap(address token) external view returns (uint256 base, uint256 usd1e6) {
        Coin storage c = _coins[token];
        base = CurveMath.mcapBase(_state(c), c.supply);
        usd1e6 = CurveMath.mcapUsd1e6(base, c.creationPrice1e6, c.baseDecimals);
    }

    function pendingStakeRewards(address token, address owner)
        external
        view
        returns (uint256 base, uint256 tokens)
    {
        Coin storage c = _coins[token];
        Position storage p = positions[token][owner];
        base = p.unclaimedBase;
        tokens = p.unclaimedToken;
        if (p.weight > 0) {
            base += CurveMath.pendingReward(p.weight, c.accBasePerWeight, p.baseDebt);
            tokens += CurveMath.pendingReward(p.weight, c.accTokenPerWeight, p.tokenDebt);
        }
    }

    /* -------------------------------------------------------------- internal */

    function _state(Coin storage c) internal view returns (CurveMath.State memory) {
        return CurveMath.State(c.virtualBase, c.virtualToken, c.realBase, c.realToken, c.k);
    }

    function _tradeGuard(Coin storage c) internal view {
        _known(c);
        require(!tradingPaused, "trading paused");
        _notGraduated(c);
        // `graduate` is permissionless, so this is seconds, not a lockup.
        require(!c.complete, "curve complete");
    }

    /// @dev The treasury legs of a fee, credited to the per-base vaults and to
    /// the coin's own lifetime ledger. Shared by `sell` and
    /// `accrueExternalFees` (the contract sits at the EIP-170 ceiling); `buy`
    /// keeps its inline copy, which via-IR cannot stack otherwise.
    function _creditFees(Coin storage c, CurveMath.FeeShares memory s) internal {
        address b = c.baseToken;
        protocolRevenue[b] += s.protocol;
        stonkzOps[b] += s.stonkzOps;
        stonkzBurn[b] += s.burn;
        c.protocolAccrued += s.protocol;
        c.opsAccrued += s.stonkzOps;
        c.burnAccrued += s.burn;
        c.creatorBucketAccrued += s.creatorBucket;
    }

    function _accrueBucketBase(Coin storage c, uint256 bucket, uint256 circ)
        internal
        returns (uint256 creator, uint256 stakers)
    {
        (creator, stakers) = CurveMath.splitCreatorBucket(bucket, c.eligibleStaked, circ);
        c.creatorClaimableBase += creator;
        if (stakers > 0) {
            (uint256 acc, uint256 dust) =
                CurveMath.advanceAcc(c.accBasePerWeight, stakers + c.poolDustBase, c.totalWeight);
            c.accBasePerWeight = acc;
            c.poolDustBase = dust;
            c.stakerAccruedBase += stakers;
        }
    }

    function _accrueBucketToken(Coin storage c, uint256 tokens, uint256 circ)
        internal
        returns (uint256 creator, uint256 stakers)
    {
        (creator, stakers) = CurveMath.splitCreatorBucket(tokens, c.eligibleStaked, circ);
        c.creatorClaimableToken += creator;
        if (stakers > 0) {
            (uint256 acc, uint256 dust) =
                CurveMath.advanceAcc(c.accTokenPerWeight, stakers + c.poolDustToken, c.totalWeight);
            c.accTokenPerWeight = acc;
            c.poolDustToken = dust;
            c.stakerAccruedToken += stakers;
        }
    }

    /// Roll earnings into `unclaimed` before any change to the position's weight.
    function _settle(Coin storage c, Position storage p) internal {
        if (p.weight > 0) {
            p.unclaimedBase += CurveMath.pendingReward(p.weight, c.accBasePerWeight, p.baseDebt);
            p.unclaimedToken += CurveMath.pendingReward(p.weight, c.accTokenPerWeight, p.tokenDebt);
        }
        p.baseDebt = c.accBasePerWeight;
        p.tokenDebt = c.accTokenPerWeight;
    }

    function _reweigh(Coin storage c, Position storage p, uint256 oldAmount, uint256 oldWeight) internal {
        uint256 newWeight = CurveMath.stakeWeight(p.amount, p.lockDays);
        p.weight = newWeight;
        c.totalWeight = c.totalWeight - oldWeight + newWeight;
        // FLEX is parked, not pooled: excluded from `eligibleStaked` so a
        // zero-weight position cannot inflate poolFrac.
        if (p.lockDays == 0) {
            c.flexStaked = c.flexStaked - oldAmount + p.amount;
        } else {
            c.eligibleStaked = c.eligibleStaked - oldAmount + p.amount;
        }
        p.baseDebt = c.accBasePerWeight;
        p.tokenDebt = c.accTokenPerWeight;
    }

    /// @dev Base assets are foreign tokens, so these go through `SafeErc20`:
    /// a token that returns no data from `transfer`/`transferFrom` is
    /// otherwise unusable as a base asset entirely. See M4 in
    /// `docs/security-review-findings.md`.
    function _pull(address erc20, address from, uint256 amount) internal {
        SafeErc20.safeTransferFrom(erc20, from, address(this), amount);
    }

    function _send(address erc20, address to, uint256 amount) internal {
        SafeErc20.safeTransfer(erc20, to, amount);
    }

    function _validTicker(string calldata t) internal pure returns (bool) {
        bytes calldata b = bytes(t);
        if (b.length == 0 || b.length > 10) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool upper = ch >= 0x41 && ch <= 0x5A;
            bool digit = ch >= 0x30 && ch <= 0x39;
            if (!upper && !digit) return false;
        }
        return true;
    }

    function _emitFill(
        Coin storage c,
        address trader,
        bool isBuy,
        uint256 baseAmount,
        uint256 tokenAmount,
        uint16 bps,
        bool inCashback,
        CurveMath.FeeShares memory s,
        uint256 toCreator,
        uint256 toStakers,
        uint256 cashbackTokens
    ) internal {
        uint256 fee = CurveMath.feeOf(s);
        emit Trade(
            c.token,
            trader,
            isBuy,
            baseAmount,
            tokenAmount,
            bps,
            inCashback,
            fee,
            s.protocol,
            s.stonkzOps,
            s.burn,
            s.creatorBucket,
            toStakers,
            toCreator,
            cashbackTokens,
            c.virtualBase,
            c.virtualToken,
            c.realBase,
            c.realToken
        );
        _emitFee(c, s);
    }

    /// @dev The accounting pair every fee source emits: `FeeAccrued` with the
    /// on-chain split, then the redundant `TreasuryCredit` view of it.
    function _emitFee(Coin storage c, CurveMath.FeeShares memory s) internal {
        emit FeeAccrued(
            c.token, c.baseToken, CurveMath.feeOf(s), s.protocol, s.stonkzOps, s.burn, s.creatorBucket
        );
        emit TreasuryCredit(c.baseToken, s.protocol, s.stonkzOps, s.burn);
    }
}
