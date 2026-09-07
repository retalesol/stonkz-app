// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CurveMath} from "./CurveMath.sol";
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
/// @notice Same interface, same 20/10/70 split, same $69K graduation and the
/// same vault layout in spirit as `programs/solana`. The differences that are
/// real rather than incidental are catalogued in `ASSUMPTIONS.md`.
///
/// Solana's per-coin PDA vaults become balances tracked in this contract's
/// storage; the money is in one place but the ledgers are as separate as the
/// PDAs were, and no function lets one ledger draw on another.
contract StonkzLaunchpad {
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
        // the 70% bucket, held here, split by ledger between creator and pool
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

    mapping(address => Coin) public coins;
    mapping(address => mapping(address => Position)) public positions;
    mapping(bytes32 => address) public tokenByTicker;

    /// Treasury balances per base token. Not claimable by any user path.
    mapping(address => uint256) public protocolRevenue;
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
    uint64 public maxOracleStaleness = 90_000;
    uint256 public tokenCount;

    uint256 private _lock = 1;

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
        uint256 creatorBucket
    );
    event TreasuryCredit(address indexed baseToken, uint256 protocolDelta, uint256 opsDelta);
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
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 base, uint256 tokens);
    event Staked(address indexed token, address indexed owner, uint256 amount, uint16 lockDays, uint256 weight, uint64 lockUntil);
    event Unstaked(address indexed token, address indexed owner, uint256 amount);
    event StakeClaimed(address indexed token, address indexed owner, uint256 base, uint256 tokens);

    /* ------------------------------------------------------------ modifiers */

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    constructor(
        address _admin,
        address _protocolWithdrawAuthority,
        address _opsWithdrawAuthority,
        IPriceSource _priceSource,
        address _migrationAuthority
    ) {
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
    }

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

    /// @notice Neither treasury has a user-facing claim path. `claimCreatorFees`
    /// and `claimStake` read entirely different ledgers and cannot reach these.
    function withdrawTreasury(uint8 which, address baseToken, uint256 amount, address to)
        external
        nonReentrant
    {
        require(amount > 0, "amount");
        require(to != address(0), "to zero");
        if (which == 0) {
            require(msg.sender == protocolWithdrawAuthority, "not authority");
            require(!protocolWithdrawalsPaused, "withdrawals paused");
            require(protocolRevenue[baseToken] >= amount, "balance");
            protocolRevenue[baseToken] -= amount;
        } else {
            require(which == 1, "which");
            require(msg.sender == opsWithdrawAuthority, "not authority");
            require(!opsWithdrawalsPaused, "withdrawals paused");
            require(stonkzOps[baseToken] >= amount, "balance");
            stonkzOps[baseToken] -= amount;
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
    ) external nonReentrant returns (address token) {
        require(!launchPaused, "launch paused");
        require(_validTicker(ticker), "ticker");
        require(feeBps >= CurveMath.MIN_FEE_BPS && feeBps <= CurveMath.MAX_FEE_BPS, "fee");
        bytes32 key = keccak256(bytes(ticker));
        require(tokenByTicker[key] == address(0), "ticker taken");

        uint8 baseDecimals = IERC20(baseToken).decimals();
        uint256 price = _freshPrice(baseToken);
        uint256 supplyAtoms = supply * 1e18;
        CurveMath.CurveParams memory p = CurveMath.deriveCurve(supplyAtoms, price, baseDecimals);

        token = address(new StonkzToken(name, ticker, uri, supplyAtoms));
        tokenByTicker[key] = token;
        tokenCount += 1;

        Coin storage c = coins[token];
        c.token = token;
        c.baseToken = baseToken;
        c.creator = msg.sender;
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
            token, baseToken, msg.sender, ticker, supplyAtoms, feeBps, cashback, c.cbStart,
            p.virtualBase, p.virtualToken, p.tokensForSale, p.lpReserve, p.gradMcapBase, price
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
        Coin storage c = coins[token];
        _tradeGuard(c);
        require(amountBase > 0, "amount");

        uint16 bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        bool inCashback = bps > c.feeBps;

        CurveMath.BuyFill memory f = CurveMath.buyQuote(_state(c), bps, amountBase);
        require(f.tokensOut >= minOut, "slippage");

        CurveMath.FeeShares memory s = CurveMath.splitFee(f.fee);
        // The identity the fee model rests on, asserted on every fill.
        require(s.protocol + s.stonkzOps + s.creatorBucket == f.fee, "split");

        // Pull the whole gross once; routing happens in storage from here.
        _pull(c.baseToken, msg.sender, f.grossBase);

        protocolRevenue[c.baseToken] += s.protocol;
        stonkzOps[c.baseToken] += s.stonkzOps;

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
            // at zero fee. Protocol and ops stay in the base token.
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
        c.creatorBucketAccrued += s.creatorBucket;
        if (c.realToken == 0) c.complete = true;

        require(StonkzToken(token).transfer(msg.sender, f.tokensOut), "transfer");

        _emitFill(c, msg.sender, true, f.grossBase, f.tokensOut, bps, inCashback, s, toCreator, toStakers, cashbackTokens);
        return f.tokensOut;
    }

    /* ---------------------------------------------------------------- sell */

    function sell(address token, uint256 amountToken, uint256 minOut)
        external
        nonReentrant
        returns (uint256 baseOut)
    {
        Coin storage c = coins[token];
        _tradeGuard(c);
        require(amountToken > 0, "amount");

        uint16 bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        bool inCashback = bps > c.feeBps;

        CurveMath.SellFill memory f = CurveMath.sellQuote(_state(c), bps, amountToken);
        require(f.netBase >= minOut, "slippage");

        CurveMath.FeeShares memory s = CurveMath.splitFee(f.fee);
        require(s.protocol + s.stonkzOps + s.creatorBucket == f.fee, "split");

        require(StonkzToken(token).transferFrom(msg.sender, address(this), amountToken), "transferFrom");

        c.virtualBase -= f.grossBase;
        c.virtualToken += amountToken;
        c.realBase -= f.grossBase;
        c.realToken += amountToken;

        protocolRevenue[c.baseToken] += s.protocol;
        stonkzOps[c.baseToken] += s.stonkzOps;
        // A sell inside the cashback window pays the elevated fee, but its
        // bucket accrues in base: converting it would be buy pressure the
        // seller never asked for. See SPEC.md §3.
        c.bucketBase += s.creatorBucket;

        uint256 circ = CurveMath.circulating(c.tokensForSale, c.realToken);
        if (circ == 0) circ = 1;
        (uint256 toCreator, uint256 toStakers) = _accrueBucketBase(c, s.creatorBucket, circ);

        c.protocolAccrued += s.protocol;
        c.opsAccrued += s.stonkzOps;
        c.creatorBucketAccrued += s.creatorBucket;

        _send(c.baseToken, msg.sender, f.netBase);

        _emitFill(c, msg.sender, false, f.grossBase, amountToken, bps, inCashback, s, toCreator, toStakers, 0);
        return f.netBase;
    }

    /* ---------------------------------------------------------- creator fees */

    /// @notice Drains the creator ledger only. There is no path from here to
    /// `protocolRevenue`, `stonkzOps`, or the staker pool's share of the bucket.
    function claimCreatorFees(address token) external nonReentrant {
        Coin storage c = coins[token];
        require(msg.sender == c.creator, "not creator");
        uint256 base = c.creatorClaimableBase;
        uint256 tokens = c.creatorClaimableToken;
        require(base > 0 || tokens > 0, "nothing");
        c.creatorClaimableBase = 0;
        c.creatorClaimableToken = 0;
        c.bucketBase -= base;
        c.bucketToken -= tokens;
        if (base > 0) _send(c.baseToken, msg.sender, base);
        if (tokens > 0) require(StonkzToken(token).transfer(msg.sender, tokens), "transfer");
        emit CreatorFeesClaimed(token, msg.sender, base, tokens);
    }

    /* -------------------------------------------------------------- staking */

    function stake(address token, uint256 amount, uint16 lockDays) external nonReentrant {
        require(amount > 0, "amount");
        Coin storage c = coins[token];
        require(c.token != address(0), "unknown token");
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

        require(StonkzToken(token).transferFrom(msg.sender, address(this), amount), "transferFrom");
        p.amount = oldAmount + amount;
        // Topping up restarts the clock rather than letting an old position
        // carry a nearly-expired lock for new tokens.
        p.lockUntil = uint64(block.timestamp + uint256(lockDays) * 1 days);

        _reweigh(c, p, oldAmount, oldWeight);
        emit Staked(token, msg.sender, p.amount, lockDays, p.weight, p.lockUntil);
    }

    function unstake(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "amount");
        Coin storage c = coins[token];
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

        require(StonkzToken(token).transfer(msg.sender, amount), "transfer");
        emit Unstaked(token, msg.sender, amount);
    }

    function claimStake(address token) external nonReentrant {
        Coin storage c = coins[token];
        Position storage p = positions[token][msg.sender];
        _settle(c, p);
        uint256 base = p.unclaimedBase;
        uint256 tokens = p.unclaimedToken;
        require(base > 0 || tokens > 0, "nothing");
        p.unclaimedBase = 0;
        p.unclaimedToken = 0;
        c.bucketBase -= base;
        c.bucketToken -= tokens;
        if (base > 0) _send(c.baseToken, msg.sender, base);
        if (tokens > 0) require(StonkzToken(token).transfer(msg.sender, tokens), "transfer");
        emit StakeClaimed(token, msg.sender, base, tokens);
    }

    /* ------------------------------------------------------------ graduation */

    /// @notice Permissionless. Either trigger will do, so no operator can hold
    /// a token hostage on the curve, and a dead oracle can only remove the
    /// early trigger — never block an exhausted curve from graduating.
    function graduate(address token) external nonReentrant {
        Coin storage c = coins[token];
        require(c.token != address(0), "unknown token");
        require(!c.graduated, "graduated");

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
        Coin storage c = coins[token];
        require(c.graduated, "not graduated");

        uint256 base = c.realBase;
        uint256 tokens = c.lpReserve;
        require(base > 0 || tokens > 0, "nothing");
        // Zeroed before the external call so the release cannot be repeated.
        c.realBase = 0;
        c.lpReserve = 0;

        if (base > 0) _send(c.baseToken, address(migrator), base);
        if (tokens > 0) require(StonkzToken(token).transfer(address(migrator), tokens), "transfer");

        (address pool, uint256 burned) = migrator.migrate(token, c.baseToken, tokens, base);
        emit LiquidityMigrated(token, pool, burned);
    }

    /* ---------------------------------------------------------------- views */

    function quoteBuy(address token, uint256 amountBase)
        external
        view
        returns (CurveMath.BuyFill memory fill, CurveMath.FeeShares memory shares, uint16 bps)
    {
        Coin storage c = coins[token];
        bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        fill = CurveMath.buyQuote(_state(c), bps, amountBase);
        shares = CurveMath.splitFee(fill.fee);
    }

    function quoteSell(address token, uint256 amountToken)
        external
        view
        returns (CurveMath.SellFill memory fill, CurveMath.FeeShares memory shares, uint16 bps)
    {
        Coin storage c = coins[token];
        bps = CurveMath.effFeeBps(c.feeBps, c.cashback, c.cbStart, block.timestamp);
        fill = CurveMath.sellQuote(_state(c), bps, amountToken);
        shares = CurveMath.splitFee(fill.fee);
    }

    /// @notice The whole coin record in one read.
    /// @dev The generated `coins` getter returns a 25-field positional tuple,
    /// which is unusable from both the indexer and the test suite. This returns
    /// the struct.
    function coinInfo(address token) external view returns (Coin memory) {
        return coins[token];
    }

    function positionInfo(address token, address owner) external view returns (Position memory) {
        return positions[token][owner];
    }

    function marketCap(address token) external view returns (uint256 base, uint256 usd1e6) {
        Coin storage c = coins[token];
        base = CurveMath.mcapBase(_state(c), c.supply);
        usd1e6 = CurveMath.mcapUsd1e6(base, c.creationPrice1e6, c.baseDecimals);
    }

    function pendingStakeRewards(address token, address owner)
        external
        view
        returns (uint256 base, uint256 tokens)
    {
        Coin storage c = coins[token];
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
        require(c.token != address(0), "unknown token");
        require(!tradingPaused, "trading paused");
        require(!c.graduated, "graduated");
        // `graduate` is permissionless, so this is seconds, not a lockup.
        require(!c.complete, "curve complete");
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

    function _reweigh(Coin storage c, Position storage p, uint256 oldAmount, uint256 oldWeight)
        internal
    {
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

    function _pull(address erc20, address from, uint256 amount) internal {
        require(IERC20(erc20).transferFrom(from, address(this), amount), "transferFrom");
    }

    function _send(address erc20, address to, uint256 amount) internal {
        require(IERC20(erc20).transfer(to, amount), "transfer");
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
        uint256 fee = s.protocol + s.stonkzOps + s.creatorBucket;
        emit Trade(
            c.token, trader, isBuy, baseAmount, tokenAmount, bps, inCashback,
            fee, s.protocol, s.stonkzOps, s.creatorBucket, toStakers, toCreator, cashbackTokens,
            c.virtualBase, c.virtualToken, c.realBase, c.realToken
        );
        emit FeeAccrued(c.token, c.baseToken, fee, s.protocol, s.stonkzOps, s.creatorBucket);
        emit TreasuryCredit(c.baseToken, s.protocol, s.stonkzOps);
    }
}
