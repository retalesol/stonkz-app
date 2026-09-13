# Graduation target: Meteora DAMM + Uniswap v4 (Burn-and-Earn)

**Status:** design locked · implementation NOT swapped into the live path yet.

Today's production-shaped code still graduates to:

| Chain | Current | Target (this doc) |
|-------|---------|-------------------|
| Solana | Raydium CPMM + 100% LP burn | **Meteora DAMM v2** permanent lock (fees still claimable) |
| Robinhood | Uniswap v2 + LP to `0xdead` | **Uniswap v4** locked position / hook that preserves fee claim |

Burning LP (current) **forfeits** venue fee claims. The product ask is Burn-and-Earn:
liquidity is permanently locked, underlying cannot be withdrawn, but trading fees
remain claimable by the creator (and optionally the staker pool).

## Solana — Meteora DAMM v2

- Prefer **DAMM v2** (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) over DLMM:
  DLMM has no LP tokens and cannot permanently lock the same way.
- Graduation CPI should: create pool → seed liquidity from curve reserves →
  permanent-lock the position NFT (fees remain claimable).
- Creator fee claim UI gains a second row: "DAMM fees" next to curve-bucket claim.
- Keep Raydium path behind `GRADUATION_DEX_SOL=raydium` until Meteora CPI is
  parity-tested on devnet.

## Robinhood — Uniswap v4

- Replace `UniswapV2Migrator` with a v4 `PoolManager` + `PositionManager` flow
  that mints a full-range position and locks / hooks it so principal is
  non-withdrawable while fees are collectable.
- Testnet 46630 may lack canonical v4 — gate with `GRADUATION_DEX_RH=v2|v4`.
- Creator claim: `collect` fees from the locked position into the existing
  creator claimable ledger (or a dedicated vault).

## Non-goals for this cut

- Do not break existing Raydium / Uni v2 graduation on staging.
- Do not market Burn-and-Earn until the new path is deployed and smoked.

## Implementation order

1. Feature flags + dual migrator interfaces (done conceptually here).
2. Meteora DAMM v2 CPI scaffold + Foundry/Anchor tests with fixtures.
3. Uni v4 migrator on RH mainnet addresses; testnet fallback stays v2.
4. Indexer events for locked LP + fee collect.
5. Web claim modal rows for venue fees.
6. Flip defaults after funded smoke.
