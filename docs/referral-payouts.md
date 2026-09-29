# Referral commissions: how they are earned, seen and paid

> Companion to `docs/fee-split-rollout.md` (the 69 / 15 / 10 / 6 schedule)
> and `scripts/reconcile-fees.ts`. Migration `0022_referral_payouts`.

## The money

Every curve fill pays the creator-set fee, split **on chain** into the creator
bucket (69%), the protocol vault (15%), the `$STONKZ` buyback vault (10%) and
the RWA crate fund (6%). The programs know nothing about referrals.

A referred trader's fill also earns their referrer chain a commission:
**15% / 10% / 5%** of the fee to T1 / T2 / T3 (`packages/shared/src/referrals.ts`).
That is paid **out of the platform's 15% leg** and never out of the creator
bucket: `referralFeePayouts` scales the three tiers down so they never exceed
the protocol leg (T1 alone takes the whole leg; T1+T2 scale by 0.6; all three
by 0.5). The 5% SP kickback is a separate, SP-only credit to the direct
referrer.

Settlement is API-side. On each `FeeAccrued` the indexer
(`apps/indexer/src/ingest.ts` `reconcileFeeAccrued`) credits every ancestor's
`referral_fee_balances` / `referral_fee_tier_balances` and credits the DB
protocol treasury with the leg **net of those commissions**. The on-chain
protocol vault still receives the full leg, so at any time

    on-chain protocol vault − DB `treasuries.protocol` = unpaid commissions (+ withdrawals)

and paying a commission out is a protocol-vault withdrawal.

## Attaching a referrer

`POST /referrals/attach { code }` binds the signed-in wallet to the code's
owner once (no self-referral, no cycles, immutable). The web applies a code
from the Rewards panel, and remembers a `?ref=CODE` on any shared URL and
applies it on the first signed-in visit (`apps/web/src/views/rewards.ts`).
Only fills **after** the bind earn.

## Seeing earnings

`GET /referrals` returns, per wallet: `pendingNative`, `lifetimeNative`,
`tiers[]` (pending / lifetime / fills for T1, T2, T3), `requestedNative`
(native payouts awaiting settlement), `paidNative` and the recent `payouts`.
The Rewards panel renders the tier table and the payout history.

## Claiming

`POST /referrals/claim { payout }` drains the pending balance atomically (the
balance and tier rows are locked and zeroed together; a credit landing
concurrently stays pending) and writes a `referral_payouts` row:

| `payout` | What happens                                                                                                                                                        | Row status           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `stonkz` | Pending native × `REFERRAL_STONKZ_PER_NATIVE` (10,000) credited to the wallet's `$STONKZ` reward balance at once. The original behaviour, still the default.        | `paid`               |
| `native` | A payout **request** for the native amount. Nothing moves yet: the money is in the on-chain protocol vault and only the protocol withdraw authority can release it. | `requested` → `paid` |

### Why native is a batch, not a button

`StonkzLaunchpad.withdrawTreasury(0, base, amount, to)` and the Anchor
`withdraw_treasury(Protocol, amount)` require the **protocol withdraw
authority** — a multisig / cold key by design (`SPEC.md` §4,
`ASSUMPTIONS.md` §1.4). The API holds no such key, so a user-signed claim
cannot pull from the vault. The two safe shapes are an API-signed voucher
redeemed against a dedicated referral vault (needs a program upgrade on all
three chains: a new vault per base, a voucher verifier, replay protection)
or an operator-run payout batch. The batch is the smallest correct version
and ships now; the voucher path is deferred (see below).

### Operator batch

```
DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts list [--net BASE]
```

prints every `requested` row grouped by net with the exact call the
authority signs — on EVM the `withdrawTreasury(0, WETH, amountWei, wallet)`
calldata (`cast send <launchpad> <data>` from the authority), on Solana the
`withdraw_treasury(Protocol, amountLamports)` accounts (destination = the
wallet's wSOL ATA). Commissions are booked in the chain's native unit, so the
batch draws on the **wrapped-native** protocol vault; fills against other
bases (USDC, stock tokens) fund those vaults instead, and the operator tops
the native vault up from them if it runs short (`reconcile-fees.ts` prints
each vault's balance).

After the transaction confirms:

```
DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts paid --tx <hash> --ids 12,13
```

marks the rows `paid` with the hash (the referrer's panel shows PAID OUT).
A wrong request is cancelled with `void --id 12 --note "…"`, which returns
the amount to the wallet's pending balance, per tier.

The DB protocol treasury is **not** debited by a payout: it was already
credited net of the commission. `TreasuryWithdrawn` events are not indexed,
so `treasuries.protocol` is a lifetime-net figure; the on-chain vault is the
balance of record.

## Deferred

- **Self-serve native claim.** Needs a program change on all three chains: a
  referral vault per base fed by the fill (a fifth leg carved from the
  protocol leg), an API-signed claim voucher (EIP-712 / ed25519) redeemed by
  the referrer, per-wallet nonces, and a cap so the vault can never owe more
  than it holds. Storage-layout append-only on the EVM proxies; a new PDA on
  Solana.
- **Solana payout destination.** The batch prints the accounts; creating the
  referrer's wSOL ATA when missing is the operator's step.
- **Unwrapped payout.** Referrers on the EVM nets receive WETH, not ETH.
