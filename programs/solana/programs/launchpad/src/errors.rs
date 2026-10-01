use anchor_lang::prelude::*;

#[error_code]
pub enum LaunchpadError {
    #[msg("Arithmetic overflowed or a quote could not be produced")]
    MathOverflow,
    #[msg("Trading is paused")]
    TradingPaused,
    #[msg("Launching is paused")]
    LaunchPaused,
    #[msg("Withdrawals from this treasury are paused")]
    WithdrawalsPaused,
    #[msg("Curve fee is outside the configured min/max bounds (default 100-500 bps)")]
    FeeOutOfRange,
    #[msg("Supply must be one of 1M, 500M, 1B, 1T")]
    UnsupportedSupply,
    #[msg("Ticker must be 1-10 chars of A-Z or 0-9")]
    InvalidTicker,
    #[msg("Name or URI is too long")]
    MetadataTooLong,
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Oracle confidence band is too wide to price a graduation")]
    OracleUnreliable,
    #[msg("Oracle price must be positive")]
    OracleInvalid,
    #[msg("The curve allocation is exhausted; this token is awaiting graduation")]
    CurveComplete,
    #[msg("Token has already graduated; trade it on the DEX pool")]
    AlreadyGraduated,
    #[msg("Token has not met a graduation trigger")]
    NotGraduable,
    #[msg("Output below the caller's minimum")]
    SlippageExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Lock term must be one of 0, 1, 7, 30, 90, 180 or 365 days")]
    InvalidLockTerm,
    #[msg("Stake is still locked")]
    StillLocked,
    #[msg("A position with a different lock term is already open; unstake first")]
    LockTermMismatch,
    #[msg("Insufficient staked balance")]
    InsufficientStake,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Only the token creator may do this")]
    NotCreator,
    #[msg("Signer is not the configured authority")]
    Unauthorized,
    #[msg("Treasury vault does not match the curve's base mint")]
    BaseMintMismatch,
    #[msg("Cashback requires a zero dev buy at launch")]
    CashbackRequiresNoDevBuy,
    #[msg("This coin's liquidity has already been migrated and locked")]
    AlreadyMigrated,
    #[msg("The DEX pool address for this migration is already in use")]
    PoolAlreadyExists,
    #[msg("Meteora DLMM pool has not been created yet; call migrate_create_pool first")]
    PoolNotCreated,
    #[msg("Meteora DLMM minted / locked no position liquidity for this deposit")]
    NoLiquidityMinted,
    /// Appended, never inserted: error codes are positional.
    #[msg("Launched mints must use the classic SPL Token program")]
    UnsupportedTokenProgram,
    #[msg("Price update is not a Pyth PriceUpdateV2 account")]
    PythAccountInvalid,
    #[msg("Pyth price update is only partially verified")]
    PythNotFullyVerified,
    #[msg("Pyth price update is for a different feed than the one pinned for this base mint")]
    PythFeedMismatch,
    #[msg("No Pyth feed is pinned for this base mint")]
    PythFeedNotPinned,
    #[msg("Position is not this coin's locked Meteora DLMM position (wrong pool, owner or fee owner)")]
    PositionMismatch,
    #[msg("This coin's liquidity has not been migrated yet")]
    NotMigrated,
    /// Referral payouts (appended, positional).
    #[msg("Referral claims are paused")]
    ReferralClaimsPaused,
    #[msg("No referral signer is configured")]
    ReferralSignerUnset,
    #[msg("Referral voucher has expired")]
    ReferralVoucherExpired,
    #[msg("No Ed25519 verification of this referral voucher by the configured signer precedes this instruction")]
    ReferralSignatureInvalid,
    #[msg("Referral voucher does not exceed what this recipient has already claimed")]
    ReferralNothingToClaim,
    #[msg("Referral claim would exceed today's cap")]
    ReferralDailyCapExceeded,
    /// Runtime parameters (appended, positional).
    #[msg("Params account is not the params PDA")]
    ParamsAccountMismatch,
    #[msg("fee_protocol_bps + fee_ops_bps + fee_burn_bps must not exceed 10000")]
    ParamsFeeSplitTooLarge,
    #[msg("min_fee_bps must not exceed max_fee_bps")]
    ParamsFeeBoundsInvalid,
    #[msg("cb_start_fee_bps must be between max_fee_bps and 10000")]
    ParamsCashbackStartInvalid,
    #[msg("cb_window_secs must be greater than zero")]
    ParamsCashbackWindowInvalid,
    #[msg("grad_mcap_usd_1e6 must be greater than zero")]
    ParamsGradMcapInvalid,
}
