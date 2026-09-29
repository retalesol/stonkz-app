# Rewards claims — minimal safe design

> Status: **design only, nothing deployed.** The rewards page shows
> `CLAIMS OPEN SOON` and `GET /rewards` answers `claims.open: false` until
> every item under _Go-live checklist_ is done. Nothing in this document
> changes what a wallet is owed today: `balances.stonkz` and `rwa_rewards`
> stay the ledger of record.

## What exists today (2026-09-29)

| Piece                    | State                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$STONKZ` reward credits | Off-chain integer balance per `(wallet, net)` in `balances.stonkz`, credited by crate `S` rows and referral fee claims, every credit in `balance_ledger` with a `ref_id`.   |
| RWA positions            | Off-chain fractional units per `(net, wallet, asset)` in `rwa_rewards`, credited by crate `R` rows; the `crate_opens` row is the audit trail. Priced in USD from DefiLlama. |
| `$STONKZ` token          | Not live on any net (`docs/phase7-stonkz.md`). The buyback sweep that would fund it is designed, not built.                                                                 |
| RWA fund                 | The 6% RWA leg accrues in the `rwa` treasury per net. No custodian, no broker integration, no keeper.                                                                       |
| Claim endpoint           | None. There is no `POST /rewards/claim`, no signer key, no on-chain vault. The web renders a clear "claims open soon" chip instead of a button.                             |
| Referral fee → credit    | `POST /referrals/claim` converts pending native fee share into `$STONKZ` credits (off-chain). This is the only "claim" today and it never touches a chain.                  |

## Goals

1. A wallet can move its earned `$STONKZ` credits on chain **without the API
   holding custody of tokens per user** and without the API being able to
   mint more than the ledger says.
2. One claim per voucher, ever — replay-proof across restarts, reorgs and
   API instances.
3. Reversible before it is on chain (a reorged trade that funded a crate
   can still be clawed back from the off-chain balance), irreversible after.
4. No new trust assumption beyond the existing operator multisig that already
   controls the fee vaults.

## Design: signed vouchers → rewards vault

```
wallet ── POST /rewards/claim ──► API (voucher signer)
                                     │  1. lock balance row, read claimable
                                     │  2. INSERT reward_claims (pending)
                                     │  3. sign EIP-712 / Ed25519 voucher
                                     ▼
wallet ◄── { voucher, signature } ───┘
   │
   └── RewardsVault.claim(voucher, sig) ──► on chain: verify sig, mark nonce
                                             used, transfer $STONKZ
                                                    │
indexer ◄────────── Claimed(wallet, nonce, amount) ─┘
   │
   └── UPDATE reward_claims SET settled_at, tx_sig; balance already debited
```

### Voucher

```
struct RewardVoucher {
  address  wallet;      // or 32-byte pubkey on Solana
  uint256  amount;      // $STONKZ base units, == credits × 10^decimals
  uint64   nonce;       // reward_claims.id — strictly increasing per wallet
  uint64   deadline;    // unix seconds; vault refuses after
  bytes32  net;         // chain id / genesis hash, so a voucher cannot cross nets
  address  vault;       // the only contract that may honour it
}
```

- **EVM (RH / Base / Arc):** EIP-712 typed data, domain
  `{ name: "StonkzRewards", version: "1", chainId, verifyingContract }`.
- **Solana:** Ed25519 signature over the Borsh-serialised struct, verified
  with the `ed25519` precompile instruction in the same transaction.

### `RewardsVault` (per net)

- Holds `$STONKZ` funded by the buyback sweep (or a one-off treasury
  transfer before the sweep exists). **Cannot mint.** The maximum any bug
  can pay out is the vault's balance — and the vault balance is what the
  operator chose to fund, not the token supply.
- `claim(voucher, sig)`: checks `voucher.vault == address(this)`,
  `block.timestamp <= deadline`, `!used[wallet][nonce]`, recovers the
  signer, requires `signer == voucherSigner`, marks the nonce used,
  transfers `amount` to `wallet`, emits `Claimed(wallet, nonce, amount)`.
- `setSigner(address)` and `pause()` behind the existing operator multisig
  (the same one that holds the fee-vault withdraw authority). Rotating the
  signer invalidates nothing already used and everything unsigned — pending
  vouchers must be re-issued, which the API does automatically when it sees
  a `signer_mismatch` revert.
- Daily payout cap per vault (`maxPerDay`) as a blast-radius limit; a
  reached cap returns a clean revert the web shows as "vault limit reached,
  try tomorrow".

### API side

New table (migration when this ships, not now):

```
reward_claims (
  id            bigserial primary key,          -- the voucher nonce
  wallet        text not null,
  net           text not null,
  asset         text not null,                  -- 'STONKZ' | RWA key
  amount        numeric not null,
  voucher_json  jsonb not null,
  signature     text not null,
  issued_at     timestamptz not null default now(),
  deadline_at   timestamptz not null,
  settled_tx    text,                           -- set by the indexer
  settled_at    timestamptz,
  voided_at     timestamptz                     -- deadline passed unsettled
)
unique (wallet, net, id), index (wallet, net, settled_at)
```

`POST /rewards/claim { asset }` (auth, rate-limited like `crate`):

1. `SELECT … FOR UPDATE` the `balances` row; claimable =
   `stonkz − Σ(amount of pending unexpired reward_claims)`. Refuse below a
   minimum (dust) and while the wallet has a pending voucher for the asset.
2. `INSERT reward_claims`, debit `balances.stonkz` **now** with a
   `balance_ledger` row `reason: 'claim_voucher', ref_type: 'reward_claim',
ref_id: id`. Debiting at issue time (not at settlement) is what makes a
   double-issue impossible even across API instances.
3. Sign with the voucher key. The key lives in the API's KMS / env, never
   in the repo, and is **not** the JWT secret or `CRATE_HMAC_SECRET`.
4. Return voucher + signature. The web submits the on-chain transaction
   with the user's wallet (gas is the user's, like every other action).

Expiry: a voucher not settled by `deadline_at` (24h) is voided by a sweeper
and the amount is credited back with `reason: 'claim_voided'`. The vault
refuses the expired voucher, so credit-back cannot double-pay.

Indexer: a new `Claimed` event kind → `settled_tx/settled_at`. On a reorg
that disowns a `Claimed` event, nothing moves off-chain (the debit already
happened at issue); the voucher simply becomes settle-able again until its
deadline.

### RWA claims

RWA units are **not** claimable through this vault. Tokenized stocks on
Robinhood Chain and PAXG have transfer restrictions and a custody model
the fund keeper does not exist for yet. Until it does the rewards page says
so (`CLAIMS OPEN SOON` on the RWA card) and the USD figure is informational.
When the fund keeper ships, RWA settles as an **operator-initiated transfer
from the fund wallet** against a signed claim request, with the same
`reward_claims` row and the same debit-at-issue rule; there is no on-chain
vault contract because the assets are not ours to wrap.

## Threat model notes

- **API compromise:** the attacker can sign vouchers up to each wallet's
  ledger balance (bounded by the ledger, which they may also edit) — but
  never more than the vault holds, and never more than `maxPerDay`. Fund the
  vault in tranches.
- **Replay:** `(wallet, nonce)` is marked on chain; `nonce = reward_claims.id`
  is unique; a voucher names its `vault` and `net`, so it cannot be replayed
  on a sibling chain or a redeployed vault.
- **Double-issue race:** row lock on `balances` + debit at issue.
- **Signer rotation:** old vouchers fail closed; the API re-issues.
- **Reorg of the trade that earned the credit:** `rollback.ts` already
  reverses `xp_events`/`balances` credits; a credit that was already
  vouchered leaves the balance negative, which is the documented "no reorged
  credit is still spendable" invariant — surface it in the admin panel.

## Go-live checklist

1. `$STONKZ` live on at least one net and the vault funded.
2. `RewardsVault` audited (small contract, ~120 lines) and deployed per net.
3. Voucher signer key in KMS; rotation runbook in `indexer-runbooks.md`.
4. `reward_claims` migration, `POST /rewards/claim`, sweeper, indexer kind.
5. `GET /rewards` flips `claims.stonkz.open` per net from a settings-service
   flag; the web's `CLAIMS OPEN SOON` chip becomes the claim button and the
   existing `#claimBtn` handler (not yet written) drives the wallet flow.
6. `docs/real-vs-simulated.md` updated; legal review of "reward credits" vs
   "tokens owed".
