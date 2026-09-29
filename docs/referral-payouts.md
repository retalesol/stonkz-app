# Referral commissions: how they are earned, seen and paid

> Companion to `docs/fee-split-rollout.md` (the 69 / 15 / 10 / 6 schedule)
> and `scripts/reconcile-fees.ts`. Migrations `0022_referral_payouts`,
> `0028_referral_onchain_claims`.

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

and paying a commission out is, ultimately, a protocol-vault withdrawal.

## Attaching a referrer

`POST /referrals/attach { code }` binds the signed-in wallet to the code's
owner once (no self-referral, no cycles, immutable). The web applies a code
from the Rewards panel, and remembers a `?ref=CODE` on any shared URL and
applies it on the first signed-in visit (`apps/web/src/views/rewards.ts`).
Only fills **after** the bind earn.

## Seeing earnings

`GET /referrals` returns, per wallet: `pendingNative`, `lifetimeNative`,
`tiers[]` (pending / lifetime / fills for T1, T2, T3), `requestedNative`
(native payouts drained but not yet settled), `paidNative`, the recent
`payouts` (each with `method: 'batch' | 'onchain'`) and `onchainClaims` —
whether this net has a referral vault, i.e. whether the panel shows
**CLAIM ON CHAIN** or **REQUEST PAYOUT**. `GET /referrals/claimable` is the
per-asset view the on-chain button reads (`views/referral-view.ts`).

## Claiming

Three ways, all draining the pending balance atomically (balance and tier
rows are locked and zeroed together; a credit landing concurrently stays
pending) and each leaving a `referral_payouts` row:

| Path                                               | What happens                                                                                                                              | Row                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `POST /referrals/claim { payout: 'stonkz' }`       | Pending × `REFERRAL_STONKZ_PER_NATIVE` (10,000) credited to the wallet's `$STONKZ` reward balance at once. The default.                   | `mode: stonkz`, `paid`                                  |
| `POST /referrals/claim/prepare` → sign → `confirm` | **Self-serve on chain.** The API signs a voucher for the wallet's lifetime total, the wallet redeems it against the net's referral vault. | `mode: native`, `method: onchain`, `requested` → `paid` |
| `POST /referrals/claim { payout: 'native' }`       | **Operator batch** (the fallback, and the only path on a net with no vault): a request the protocol withdraw authority settles later.     | `mode: native`, `method: batch`, `requested` → `paid`   |

### Self-serve on chain: the design

The API holds no key that can move treasury money, and it must not
(`SPEC.md` §4, `ASSUMPTIONS.md` §1.4). It does hold message-signing keys —
the same posture as `STOCK_PRICE_ATTESTER_KEY` — and a dedicated **referral
vault** per chain holds only what the operator has moved into it. So:

1. **A vault per chain, funded by the treasury authority, never by the fill.**
   - EVM: `programs/evm/src/ReferralVault.sol`, standalone and
     non-upgradeable, one per chain (`script/DeployReferralVault.s.sol`).
     Holds WETH (and any ERC-20 admin enables with `setMaxPerDay`).
   - Solana: `["referral_vault", base_mint]`, a token account owned by the
     data-less `["referral_authority"]` PDA
     (`programs/launchpad/src/instructions/referral.rs`). Opened by anyone
     with `init_referral_vault`; funded with `fund_referral_vault` or by
     pointing `withdraw_treasury(Protocol, amount)` at it as `destination`.
     No existing instruction can sign for the referral authority, and the
     referral instructions cannot reach `protocol_vault`.
2. **Cumulative vouchers, no nonces.** The voucher certifies the recipient's
   **lifetime** entitlement in the asset's atoms. The vault pays
   `cumulativeAmount − claimed[recipient][asset]` and stores the new
   cumulative. A replayed voucher, or an older one, pays nothing and fails;
   a voucher that was signed but never redeemed is simply re-issued next
   time with a fresh deadline. The API therefore only ever needs to sign a
   monotone number, and the most a recipient can ever pull is the largest
   number the API signed for them.
   - EVM: EIP-712, domain `{ name "StonkzReferralVault", version "1",
chainId, verifyingContract = vault }`, message
     `ReferralClaim(address recipient, address asset, uint256 cumulativeAmount, uint256 deadline)`.
     `claim(to, asset, cumulative, deadline, sig)` pays the ERC-20 to `to`
     (anyone may submit it); `claimAsEth(to, cumulative, deadline, sig)`
     unwraps WETH to ETH and only `to` may send it. The web uses `claimAsEth`.
   - Solana: Ed25519 over
     `"STONKZ_REFERRAL_V1" || cluster_tag[8] || vault || recipient || base_mint || cumulative u64 LE || deadline i64 LE`
     (138 bytes), carried in an `Ed25519Program` instruction the transaction
     places before `claim_referral`. The program reads it back through the
     instructions sysvar and requires program id = Ed25519, a single
     signature whose offsets all point into that instruction, public key =
     `ReferralConfig.signer`, and message = the bytes above, byte for byte.
     The runtime already rejected the transaction if the signature did not
     verify. The per-recipient counter is `["referral_claim", base_mint, recipient]`.
     The recipient signs, pays the rent of that counter and of their ATA
     (created by the program if missing), and receives the delta in the base
     mint (wSOL for native commissions).
3. **An immutable ledger on the API side.** `prepareOnchainClaim` (one DB
   transaction, `FOR UPDATE` on the balance row) drains pending into a
   `referral_payouts` row carrying `amount_atoms` and `cumulative_atoms =
previous max + amount_atoms`. The next voucher is always
   `max(cumulative_atoms)` over the wallet's `onchain` rows, so a signed
   number can never exceed lifetime earned, whatever order requests arrive
   in. Atoms are rounded from the double ledger at 12 decimals
   (`nativeToAtoms`), so the same balance always yields the same number. A
   per-wallet Redis lock (`refclaim:<net>:<wallet>`, 20 s) keeps two prepares
   from interleaving between drain and sign. `onchain` rows can never be
   voided (their cumulative may already be in a voucher) and never reach the
   operator batch.
4. **Confirm from the chain, not the client.** `POST /referrals/claim/confirm
{ signature }` reads the receipt (`ReferralClaimed(recipient, asset,
amount, cumulativeAmount, …)` from the vault) or the transaction logs
   (the program's `ReferralClaimed` event) and marks every open `onchain`
   row at or below the confirmed cumulative `paid` with the hash. A receipt
   that paid someone else, a reverted transaction, or one not yet visible
   settle nothing (`no_claim_in_tx` / `tx_failed` / `not_confirmed`); the
   web retries confirm on the next panel refresh.
5. **Blast radius.** The signer is a hot key by design, so its damage is
   bounded elsewhere: it can only ever move what is in the vault, and
   `maxPerDay[asset]` (EVM; `0` = asset disabled, `type(uint256).max` =
   uncapped, refused on mainnet by the deploy script) / `ReferralConfig.max_per_day`
   (Solana; base atoms, `0` refuses all, `u64::MAX` uncapped) caps what all
   recipients together can pull per rolling day. The launchpad's emergency
   pauser can stop claims instantly (`ReferralVault.pause()` reads
   `launchpad.pauser()`; Solana's `set_referral_paused(true)` accepts the
   `["pauser"]` holder); only admin restarts them. Insufficient vault balance
   reverts the whole claim — nothing partial, nothing recorded.

The indexer needs no change: EVM logs from the vault's address are not the
launchpad's and are ignored; on Solana `AnchorEventCoder` returns `null`
for a discriminator it does not know (`apps/api/src/chain/events/anchor.ts`),
so the new `ReferralClaimed` / `ReferralVaultFunded` / `ReferralConfigSet`
events are skipped. The API confirm path is the source of truth for
`referral_payouts`.

### Environment

| Variable                               | Purpose                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `REFERRAL_SIGNER_KEY_EVM`              | 32-byte hex secp256k1 key; its address must equal each EVM vault's `signer()`. Unset: EVM on-chain claims off.                     |
| `REFERRAL_SIGNER_KEY_SOL`              | Ed25519 seed (32-byte hex, 64-byte hex secret key, or `solana-keygen` JSON); must equal `ReferralConfig.signer`. Unset: SOL off.   |
| `REFERRAL_VAULT_ADDRESS_{RH,BASE,ARC}` | Deployed `ReferralVault` per EVM net. Zero (default) = keep the request flow there.                                                |
| `REFERRAL_ASSET_{RH,BASE,ARC}`         | `address:decimals:symbol` the vault pays. Defaults to the net's pinned WETH on RH and Base; Arc must be set (no wrapped USDC pin). |
| `REFERRAL_CLAIM_DEADLINE_SECONDS`      | Voucher lifetime (default 1800).                                                                                                   |

A malformed key fails the boot rather than silently disabling claims.

### Operator runbook

**Deploy / enable, per chain.**

- Base / RH (and Arc once an asset is pinned):
  ```
  LAUNCHPAD_ADDRESS=0x… EXPECT_CHAIN_ID=84532 \
  REFERRAL_SIGNER=0x<address of REFERRAL_SIGNER_KEY_EVM> REFERRAL_MAX_PER_DAY=<wei> \
    forge script script/DeployReferralVault.s.sol:DeployReferralVault --rpc-url $RPC --broadcast -vvv
  ```
  then `REFERRAL_VAULT_ADDRESS_<NET>` on the API. On a testnet the deployer
  (or `ADMIN`) is admin; on mainnet the script is `MainnetGuard`-aware: it
  refuses to run without the governance env, requires the launchpad to
  already be under the timelock (`requireTimelockAdmin`), makes the
  launchpad's admin — the timelock — the vault's admin, and refuses an
  uncapped `REFERRAL_MAX_PER_DAY`. Every later admin action (signer rotation,
  caps, unpause, sweep) is therefore a timelocked proposal; `pause` is not.
- Solana: `init_referral_vault(wSOL)` (anyone; a payer), then admin
  `set_referral_signer(signer, max_per_day, cluster_tag)` with the API key's
  public key, a lamport cap and the 8-byte tag the API signs with
  (`mainnet\0`, `devnet\0\0`, `testnet\0`, `localnet` — `solClusterTag`).
  Admin is the Squads vault on mainnet, behind its timelock.

**Funding: how much to move.** Everything the vault may be asked to pay is
already booked, so the target is arithmetic, per net:

```sql
-- not yet drained into a voucher
select net, sum(pending_native) from referral_fee_balances group by net;
-- signed vouchers not yet redeemed (or redeemed and awaiting confirm)
select net, sum(amount_native) from referral_payouts
 where mode = 'native' and method = 'onchain' and status = 'requested' group by net;
```

`top-up = pending + awaiting − vault balance` (never below zero), in the
net's wrapped native. `scripts/reconcile-fees.ts` prints each protocol
vault's balance; the referral vault's is `weth.balanceOf(vault)` /
`spl-token balance` of the PDA. Move it from the **protocol** vault with the
protocol withdraw authority — it is that leg's money:

- EVM: `withdrawTreasury(0, WETH, amount, <ReferralVault>)` on the launchpad
  (the vault has no `Funded` event for this path; anyone can also `fund` /
  `fundEth`, which do emit it).
- Solana: `withdraw_treasury(Protocol, amount)` with `destination` = the
  `["referral_vault", wSOL]` PDA, or `fund_referral_vault` from any wSOL
  account.

Fund a comfortable multiple of the weekly claim volume rather than the exact
figure: a short vault fails claims closed (the referrer sees CLAIM FAILED,
nothing is recorded) until it is topped up. Over-funding is recoverable —
admin `sweep(asset, to, amount)` (EVM) sends it back; on Solana the vault
authority is program-only, so fund conservatively there and treat the
balance as committed. Commissions are booked in the native unit, so both
vaults draw on the **wrapped-native** protocol vault; fills against other
bases (USDC, stock tokens) fund those protocol vaults instead and the
operator tops the native one up from them if it runs short.

**Signer rotation.** Generate a new key; set the new public key on chain
first (`setSigner` through the timelock on mainnet; `set_referral_signer`
by admin), then swap `REFERRAL_SIGNER_KEY_*` on the API and restart. Vouchers
signed by the old key stop verifying the moment the chain flips — a wallet
that holds one gets `BadSignature` / `ReferralSignatureInvalid`, and the
next prepare re-issues the same cumulative under the new key. Nothing is
lost because the cumulative lives in `referral_payouts`, not in the voucher.
On suspicion of a leak, pause first (`ReferralVault.pause()` from the pauser
key, `set_referral_paused(true)`), then rotate, then unpause through admin.
The daily cap bounds what a leaked key can move before that: set it from
the expected weekly claim volume, not from the vault balance.

**Solana program size.** With the referral instructions `launchpad.so`
builds to **830,136 bytes** (from 749,880; clean `anchor build`, anchor-cli
0.32.1 / platform-tools v1.54). The devnet `ProgramData` was extended to
759,656 bytes, so it must be extended by at least 70,480 bytes before the
next `anchor upgrade` — `solana program extend FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg 100000`
leaves ~30 KB of headroom (rent ≈ 0.7 SOL). Note for whoever trims the
binary next: requiring the recipient's ATA to pre-exist (dropping the
`init_if_needed` + associated-token program from `claim_referral`) measured
_larger_ (903,816 bytes) on this toolchain, twice, clean; keep the on-chain
create.

### Operator batch (fallback)

Still the only path on a net with no vault (Arc today; any net where the
signer key is unset), and the backstop if a vault is paused:

```
DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts list [--net BASE]
```

prints every `requested` **batch** row grouped by net with the exact call
the authority signs — on EVM the `withdrawTreasury(0, WETH, amountWei, wallet)`
calldata (`cast send <launchpad> <data>` from the authority), on Solana the
`withdraw_treasury(Protocol, amountLamports)` accounts (destination = the
wallet's wSOL ATA). After the transaction confirms:

```
DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts paid --tx <hash> --ids 12,13
```

marks the rows `paid` with the hash. A wrong request is cancelled with
`void --id 12 --note "…"`, which returns the amount to the wallet's pending
balance, per tier. `onchain` rows are invisible to `list`, and `paid` /
`void` refuse them.

The DB protocol treasury is **not** debited by either kind of payout: it was
already credited net of the commission. `TreasuryWithdrawn` events are not
indexed, so `treasuries.protocol` is a lifetime-net figure; the on-chain
vaults are the balance of record.

## Tests

- `programs/evm/test/ReferralVault.t.sol`: domain binding (chain / vault /
  recipient / asset / amount / deadline), replay and older vouchers, deadline,
  daily cap (shared, rolling, disabled at 0, uncapped), pause by the
  launchpad's pauser and unpause by admin only, signer rotation, two-step
  admin, insufficient balance reverting whole, unwrap only for the recipient,
  fuzz on cumulative order and on the cap.
- `programs/launchpad/src/instructions/referral.rs` (`cargo test`): message
  layout, Ed25519 instruction parsing (web3.js shape, multi-sig / out-of-range
  refused), rolling cap. `programs/solana/tests/referral.ts` against a
  local validator: a signed claim pays the delta into a freshly created ATA,
  replay and older vouchers pay nothing, a later voucher pays the increase,
  tampered / stranger / missing / expired vouchers fail closed, the cap
  refuses the crossing claim, the pauser can stop but not start, a short
  vault fails whole.
- `apps/api/src/routes/referrals-onchain.test.ts`, `game/referral-signer.test.ts`:
  EIP-712 verification under the vault domain and not another, calldata
  round-trip, re-prepare returns the same cumulative, accrual between
  vouchers is cumulative, confirm settles the covered rows and refuses
  foreign / reverted / pending receipts, the Redis lock, batch exclusion,
  the Solana transaction shape (Ed25519 verify with the exact message and a
  verifying signature, `claim_referral` args) and event decode.
- `apps/web/src/views/referral-view.test.ts`: every panel state.

## Deferred

- **Solana unwrapped payout.** Referrers receive wSOL in their ATA; a
  close-account step to native SOL is the client's (not yet in the web).
- **Arc.** Needs a pinned wrapped-USDC asset (`REFERRAL_ASSET_ARC`) and a
  vault deployment; until then Arc keeps the request flow.
- **Indexer decode of `ReferralClaimed`.** Optional: the API confirm path is
  authoritative; decoding the event in the indexer would only add a second
  witness for a claim confirmed while the API was down.
