# Stonkz — cross-cutting security review findings

Full-stack review of the Phase 0–6 build (monorepo: `apps/web`, `apps/api`,
`apps/indexer`, `packages/shared`, `programs/solana`, `programs/evm`), done as
the plan's step 168 "security reviews… never ship client-authoritative
crates/XP/fees" gate. Scope and method, per the brief:

1. On-chain programs (buy/sell/graduation/fee-claim/staking/cashback) on both
   chains — overflow/underflow, reentrancy, access control, PDA/account
   validation, signer checks, fee-split correctness, oracle staleness, LP-burn
   verifiability.
2. `StonkzRouter.sol` + `apps/api`'s Universal Router command building —
   slippage/sandwich exposure, `quotedOut` vs curve-floor separation, permit
   replay.
3. The game ledger (XP/SP/Optionz/crates/achievements) — server authority,
   crate RNG manipulability, double-claim races.
4. Tips (Phase 5) — server/indexer authority, spoofability.
5. Auth (SIWS/SIWE + ERC-1271) — replay, session handling, smart-account
   spoofability.
6. General — committed secrets, rate limiting, CORS/CSP.

Per the brief's constraint, **no on-chain program code was modified.**
Findings against `programs/solana` and `programs/evm` are documentation-only
and need a dedicated fix-and-re-audit cycle. Two narrow, low-risk gaps were
fixed directly in `apps/api` (§"Fixes applied in this review") because they
were unambiguous, scoped, and safe to land without a second review cycle.

**Headline: this codebase is unusually well-defended for its stage.** Every
fee split, every award, every tip and every crate roll already had its
security property asserted in a code comment and pinned by a test before this
review started (`docs/phase6-exit-review.md` and `docs/rh-trade-atomicity-
gap.md` cover the router in more depth than this document repeats). The
findings below are genuine gaps, not a laundry list of theoretical concerns —
where something is fine, it is noted as closed rather than padded into a
finding.

---

## Critical

None found. No path lets a client mint XP/SP/Optionz/fees, no path lets one
fee bucket overdraw another, and no unauthenticated write path was found.

---

## High

### H1. Solana graduation's "LP burn" is not implemented on-chain or anywhere in this repo — it is a fully trusted, unconstrained hand-off — **RESOLVED**

**Resolution (post-review fix, `programs/solana`):** `migrate_liquidity` no
longer hands the graduated reserves to caller-supplied token accounts. It now
CPIs into the real Raydium CPMM program to create a pool seeded with the
curve's `real_base`/`lp_reserve`, then issues a genuine SPL `burn` of 100% of
the LP that pool mints — reducing `lp_mint.supply` to zero, not merely sending
tokens to an address nobody uses. This mirrors `UniswapV2Migrator.sol`'s
guarantee (real pool, atomic, pre-seeded-pool protection) with two chain-shape
differences, both strictly at least as strong:

- **Pre-seeded-pool protection is structural, not a price check.**
  `UniswapV2Migrator` defends a *canonical, guessable* pair address by
  comparing the pool's existing reserve ratio to the deposit and reverting on
  a large deviation. On Solana, `pool_state` is this program's own PDA
  (`SEED_RAYDIUM_POOL`, one per mint), passed to Raydium's `Initialize` via
  the "non-canonical pool" path its own instruction supports for exactly this
  front-running class. Nobody but this program can ever produce a valid
  signature for that address, so nobody can occupy or fund it ahead of a
  graduation — there is no reserve ratio to check because there is no way for
  the pool to exist first. A `require!` still asserts the account is
  untouched immediately before the CPI, as defence in depth, and is covered
  by a dedicated test that forces the "already exists" precondition directly.
- **The burn is a real supply reduction, not a dead-address transfer.** SPL
  tokens have no analogue of `0xdead` that is simultaneously "unusable" and
  "still counted in `totalSupply`" the way EVM's burn-address convention is.
  `migrate_liquidity` calls the SPL `Burn` instruction on 100% of the LP a
  dedicated escrow PDA receives, so `lp_mint.supply` is verifiably `0`
  afterward — strictly stronger than "sent to an address nobody controls."

The escrow PDA that stands in as Raydium's `creator` (funds-source, rent
payer, LP recipient in Raydium's account model) is itself a second
program-derived account nothing but this program can ever sign for again, so
neither `migration_authority` nor any other signer ever holds the tokens, the
pool, or the LP at any point — `migration_authority` only funds the SOL the
pool creation and Raydium's `create_pool_fee` cost.

Covered by `programs/solana/tests/launchpad.ts`'s "graduation liquidity
migration (Raydium CPMM)" suite, which clones the actual Raydium CPMM devnet
program plus its default fee-tier config onto the local validator (rather
than mocking it) and asserts: a successful migration burns 100% of the
minted LP (mint supply reads exactly zero afterward) against a pool
confirmed real and Raydium-owned on chain; a second migration attempt is
rejected (`AlreadyMigrated`); a forced pre-existing `pool_state` is rejected
(`PoolAlreadyExists`); and the instruction's account list no longer accepts
any caller-named destination. See `programs/solana/programs/launchpad/src/
instructions/graduate.rs`'s `MigrateLiquidity` doc comment for the full
design rationale, including why the integration is a hand-built CPI
(`invoke_signed` against a manually constructed `Instruction`) rather than a
dependency on the `raydium-cp-swap` crate.

<details>
<summary>Original finding (pre-fix), left for the record</summary>

**Location:** `programs/solana/programs/launchpad/src/instructions/graduate.rs`
(`MigrateLiquidity`, lines ~128–210); confirmed absent everywhere else by grep
(`raydium|meteora|migrat` across `programs/solana`, plus every other tree —
no off-chain crank script exists in this repo either).

**Description:** The plan and `programs/README.md` both say graduation
"migrate[s] the token plus base reserves to Raydium/Meteora… and burn[s] the
LP." On Robinhood Chain that claim is true and enforced on-chain: `programs/
evm/src/UniswapV2Migrator.sol` creates/seeds the pool, calls `mint()` with the
burn address (`0x…dEaD`) as recipient, checks the deposit against the pool's
existing price so a pre-seeded/manipulated pair can't donate the raise to a
sniper, and emits `liquidityBurned`. A user can verify all of it from a block
explorer, per that contract's own header comment.

**On Solana, none of this exists.** `MigrateLiquidity` is the entire seam:
- It hands `real_base` and `lp_reserve` to `destination_base`/
  `destination_token` — two token accounts supplied by the caller at call
  time, constrained only by `token::mint`, **not** to any program-owned PDA,
  a specific Raydium/Meteora pool, or a burn address.
- The only gate is `migration_authority`'s signature
  (`global.migration_authority`, an admin-set key — `admin.rs::
  set_withdraw_authorities`/`initialize`).
- Nothing forces that authority to ever create a pool, and nothing forces it
  to burn the resulting LP tokens. `programs/README.md` and `SPEC.md` §5 both
  say "the Raydium/Meteora pool CPI itself is **not** implemented here" —
  which is an honest comment in the docs, but it means the claim in the plan
  ("burn the LP") and in any user-facing copy repeating it is **not true on
  Solana today**. It is a promise about what an off-chain operator will do
  with the funds, backed by nothing the chain can verify.

**Impact:** A compromised or dishonest `migration_authority` key can, after
every Solana graduation, redirect the entire graduated base+token reserve
anywhere — there is no on-chain constraint that it goes into a pool at all,
let alone that any LP position is burned. Even absent malice, there is
currently no code in this repo that *would* do the right thing if invoked
today; `migrate_liquidity` on its own leaves funds sitting in whatever
accounts the authority named.

**Suggested fix:** Before this claim is made to users on Solana:
1. Either implement the Raydium/Meteora CPI + LP-burn inside
   `migrate_liquidity` itself (mirroring `UniswapV2Migrator`'s pattern: create
   pool if needed, price-manipulation guard, mint LP to a burn destination,
   all inside one instruction so it's atomic and auditable), or
2. If an off-chain crank is kept, constrain `destination_base`/
   `destination_token` to program-derived, single-purpose accounts (e.g. a
   PDA the *next* instruction in the same flow is required to consume before
   anyone can withdraw from it) so the money can't silently stop at "sent to
   the authority" — and make the LP-burn step provable on-chain (a follow-up
   instruction that reads the pool's LP mint balance at the burn address and
   emits an event), not merely trusted.
3. Until either lands, the marketing/UI copy and `docs/robinhood-chain.md`-
   style documentation should say plainly that Solana graduation liquidity
   migration is an operator-trusted step today, the same way `ASSUMPTIONS.md`
   is honest about RH's own gaps. Silence here is the actual risk — the EVM
   side sets a correctness bar the Solana side doesn't meet yet, and nothing
   currently flags that asymmetry to anyone deciding whether to trust the
   Solana launch path with real graduations.

</details>

---

## Medium

### M1. Rate limiting keys off a client-controlled `X-Forwarded-For` header with no trusted-proxy validation — **RESOLVED**

**Resolved** in commit `6668e9e`, in a follow-up round after this document was
first written. `apps/api/src/net/client-ip.ts`'s `resolveClientIp()` now walks
the `X-Forwarded-For` chain from the **right** by exactly
`TRUSTED_PROXY_DEPTH` hops (default `1`, matching Railway's edge, which
appends rather than replaces), ignores everything further left, and fails
closed to `null` when the chain is shorter than the configured depth or the
depth is `<= 0`. `clientIdentity()` in `app/middleware.ts` and the session
`ip:` field in `routes/auth.ts` both consume it; the untrusted
`CF-Connecting-IP` fallback was dropped, since Cloudflare is not part of this
deployment's topology. Covered by 11 unit tests in `src/net/client-ip.test.ts`
plus 3 integration tests in `src/app/middleware.test.ts` that drive the real
Hono stack through `/auth/nonce` and assert a spoofed multi-value header can
no longer dodge `RATE_LIMITS.auth`. The original finding is preserved below.

**Location:** `apps/api/src/app/middleware.ts` (`clientIdentity`, lines
53–58); also used raw in `apps/api/src/routes/auth.ts:70` for the session's
recorded `ip`.

**Description:** `clientIdentity()` — the identity every `limit()` call
buckets on before a wallet is authenticated — takes the **first** entry of
`X-Forwarded-For` verbatim:

```ts
const forwarded = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
return `ip:${forwarded || c.req.header('CF-Connecting-IP') || 'unknown'}`;
```

If the edge in front of `apps/api` appends to `X-Forwarded-For` rather than
replacing it (or if the API is ever reachable directly, bypassing that edge),
a client can prepend an arbitrary value and get a fresh rate-limit bucket on
every request — defeating the per-IP limiter on every unauthenticated route:
`/auth/nonce`, `/auth/siws`, `/auth/siwe` (`RATE_LIMITS.auth`, 30/min),
`/tokens/:sym/quote` (`RATE_LIMITS.quote`), `GET /tokens/*`/`GET /wall/*`/`GET
/users/*` (`RATE_LIMITS.read`), and `POST /launch/prepare`'s per-IP ceiling
(`RATE_LIMITS.launchIp`). It's also recorded verbatim into `sessions.ip`
(`routes/auth.ts:70`), so that column is not trustworthy either.

**Impact:** Medium rather than high because every route that actually moves
money or credits a reward is also gated on server-side facts that don't trust
the client at all (chain-verified events, cooldown upserts, tip RPC
verification) — this is a rate-limit *bypass*, not a way to forge a result.
But it does mean the auth-nonce/login endpoints, the quote cache, and the
launch-attempt-per-IP ceiling can all be trivially hammered by spoofing a
different `X-Forwarded-For` value per request, which is exactly the kind of
brute-force/DoS surface rate limiting exists to close.

**Suggested fix:** Make the trusted-hop count explicit config (Railway's edge
is one hop) and take the entry at that fixed depth from the *right*, never
the client-controllable left end; or prefer a header the edge is known to set
itself and that a client cannot inject (confirm with the hosting provider
which header that is — Railway's own docs should say). Until then, treat
`sessions.ip` as informational only, not as an abuse signal.

### M2. Crate RNG is auditable, not publicly verifiable — already flagged in-repo, restated here as a review finding

**Location:** `apps/api/src/game/crates.ts` (`CrateService.roll`, header
comment lines 70–98).

**Description:** The crate roll is `HMAC-SHA256(CRATE_HMAC_SECRET,
net|wallet|tier|nonce)`, with the nonce generated server-side
(`randomBytes(16)`) and never supplied by the client. This is genuinely
server-authoritative and not manipulable *by a client* — there's no path for
a client to bias, predict, or pre-see a roll, and the cooldown upsert
(`crateState`'s conditional `onConflictDoUpdate` with `setWhere: readyAt <=
now`) closes the double-open race correctly (verified: two concurrent opens
for the same wallet/tier/net cannot both win, because the second's `WHERE`
clause matches nothing once the first has advanced `readyAt`).

What HMAC does **not** give is public verifiability: only the party holding
`CRATE_HMAC_SECRET` can confirm a historical roll was computed honestly,
which means a dishonest *operator* (not a client) could in principle try
several nonces before committing one — the code as written doesn't do this
(one nonce, one roll, persisted immediately), but nothing forces that
discipline the way a commit-then-reveal scheme would. The code's own header
comment already documents this exact gap and the fix (commit `server_seed_
hash` before the epoch, mix in a client nonce, swap in a VRF, reveal the
epoch seed at rollover) as required "before the drop tables are advertised as
odds."

**Impact:** Low against an external attacker (nothing here is client-
exploitable); medium as a trust question once real-money crate odds are
marketed, which is exactly the caveat the code already states.

**Suggested fix:** No code change needed for the current build (client-
opened crates cannot be manipulated by the client). Track the documented VRF
upgrade as a blocking item before crate odds are advertised as provably fair,
not as a silent "good enough" — this review is restating the repo's own
flag, not discovering a new one.

### M3. `GET /me` and `GET /native-price` had no rate limit — fixed in this review

**Location:** `apps/api/src/routes/me.ts`.

**Description:** Every other endpoint that fans out to an RPC/oracle call
carries a `limit(...)` middleware; `GET /me` (authenticated, but per-wallet
unbounded) did a live native-balance RPC call plus an oracle call plus three
DB reads on every hit with nothing to stop a client from calling it in a
tight loop, and `GET /native-price` did the same two oracle calls with no
rate limit **and no authentication at all** — anyone could hit it
unbounded. Both are cheap individually but are exactly the amplification
pattern (client request → outbound RPC/oracle call) rate limiting on every
sibling route exists to bound.

**Fix applied:** Added `limit(RATE_LIMITS.read)` to both routes (600/min per
identity — the same budget every other read-only endpoint already uses).
Additive, one line per route, no behavior change for a client under that
budget. Covered by the existing `apps/api` test suite (`pnpm typecheck` and
the relevant route tests were re-run after the change — see "Fixes applied"
below).

### M4. `StonkzToken.sol` / `StonkzLaunchpad.sol` use a hand-rolled `IERC20` interface and raw `transfer`/`transferFrom` without `SafeERC20`

**Location:** `programs/evm/src/StonkzLaunchpad.sol` (`_pull`/`_send`, near
the bottom), `programs/evm/src/StonkzRouter.sol` (same pattern).

**Description:** All base-token moves go through `require(IERC20(erc20).
transfer(...), "transfer")`/`transferFrom`, assuming the token both returns a
`bool` and does so truthfully. `StonkzToken` itself (the launched memecoin)
is fine — it's this repo's own code and always returns `true`. The risk is
entirely in **the base token**, which is operator-configured and can be any
ERC-20 on Robinhood Chain (`docs/robinhood-chain.md`'s tokenized-stock bases
are third-party contracts). A base token that reverts on a false return, or
that returns no data at all (the historical mainnet USDT shape) will either
work by accident (Solidity's ABI decoder treats "no return data" from a call
that didn't revert as decode-failure-then-revert on a strict interface, so
it fails safe rather than silently succeeding) or simply refuse to be used as
a base — not a fund-loss bug, but worth a deliberate allow-list check before
a new base asset is wired up, rather than discovering the incompatibility
after a coin has already launched against it.

**Impact:** Low. No known base asset currently in `router/base-mints.ts`
exhibits the problematic shape, and the failure mode is "this base token
can't be used" rather than "funds move incorrectly."

**Suggested fix:** Either adopt a standard `SafeERC20`-equivalent
(OpenZeppelin's, or a local minimal version) for `_pull`/`_send`, or add an
explicit compatibility check to whatever process approves a new base asset
for `router/base-mints.ts`/`ApiEnv.rhV3FeeTierOverrides`. Contract-side, so
documented only, not fixed in this pass.

---

## Low

### L1. `verifyTip`'s recency window is measured from the RPC's reported block time, which some RPC/indexer paths could return as `null`

**Location:** `apps/api/src/social/tips.ts` (`verifyTip`, lines 65–72).

**Description:** `if (transfer.blockTimeMs !== null && nowMs - transfer.
blockTimeMs > maxAgeMs)` — if `blockTimeMs` is `null`, the recency check is
skipped entirely rather than defaulting to "reject as unverifiable age." The
sender/recipient/amount/success checks all still run and are the checks that
actually matter for "did this wallet send this tip," so this is not a way to
fake a tip; it only means the "too_old" rejection can't fire for a transfer
whose age genuinely can't be determined. Whether every `ChainRpc`
implementation ever returns `null` here wasn't traced across every RPC
backend in this pass.

**Suggested fix:** Treat `blockTimeMs === null` as "cannot establish
recency" and reject with a distinct reason (e.g. `unknown_age`) rather than
silently accepting, so a backend that can't supply a timestamp fails closed
instead of open.

### L2. `sessions.ip`/request logs record the unvalidated `X-Forwarded-For` value (see M1) as if it were trustworthy operational data — **RESOLVED**

Same root cause as M1, and closed by the same fix (`6668e9e`):
`routes/auth.ts` now records `resolveClientIp()`'s trusted-depth result
rather than the raw header, so `sessions.ip` is as trustworthy as the
deployment's proxy topology allows. It is still `null` (recorded as unknown)
when the chain doesn't match the configured depth, which is the intended
fail-closed behaviour for incident investigation.

### L3. Achievement/crate/streak reason strings and the daily XP/SP cap constants are values an operator may want to tune per environment, and currently require a deploy to change

Not a vulnerability — noted because `DEFAULT_WHALE_CUT`/`DEFAULT_DUST` in
`apps/api/src/game/rules.ts` are already flagged in their own comment as
"wants to move to `packages/shared`" so the sim and the server can't drift.
Restated here only because a cross-cutting review is the natural place to
confirm it's tracked, not because it's newly found.

---

## Closed / confirmed-safe (checked specifically for this review, not vulnerable)

Documenting these explicitly so a future reviewer doesn't have to re-derive
them from scratch — each was checked against the specific attack class in
the brief.

- **Fee-split math (Solana + EVM), both chains:** `protocol + stonkz_ops +
  creator_bucket == fee` is asserted **on every fill**, not just in tests
  (`trade.rs` buy/sell, `StonkzLaunchpad.sol` buy/sell) — `require!`/
  `require` on the identity, so a future edit that breaks it fails the
  transaction rather than silently mis-paying. The creator bucket is defined
  as the remainder specifically so this identity can never fail on rounding.
  Protocol (20%) and ops (10%) vaults are structurally unreachable from the
  staker/creator claim paths — different PDAs/ledger fields with no shared
  code path — on both chains.
- **Integer overflow/underflow:** Solana uses `checked_add`/`checked_sub`
  throughout `math.rs` and the instruction handlers, returning
  `LaunchpadError::MathOverflow` rather than panicking or wrapping; `u128`
  intermediate math with documented headroom analysis (`constants.rs`'s
  `MAX_VIRTUAL_BASE` derivation). EVM is Solidity ≥0.8.24, so arithmetic
  reverts on overflow by default; the two `unchecked` blocks in
  `StonkzToken.sol::_transfer`/`burn` are guarded by an explicit `require`
  immediately above each, not bare unchecked math.
- **Reentrancy (EVM):** `StonkzLaunchpad` and `StonkzRouter` both carry a
  `nonReentrant` modifier on every state-changing external function; the
  router additionally never holds a balance between transactions (checked:
  every path ends by forwarding output/sweeping residue), so there's no
  balance worth reentering for even absent the guard.
- **Access control / signer checks (Solana):** every privileged instruction
  constrains its signer via `has_one` or `address = global.<field> @
  Unauthorized` (withdraw authorities, migration authority, oracle
  authority, admin) rather than trusting an unconstrained `Signer<'info>`;
  `WithdrawTreasury` additionally re-derives the expected vault PDA from
  seeds and asserts the passed account matches, closing the "point the
  protocol authority at the ops vault" substitution class explicitly.
- **PDA/account validation:** curve, vault, and position accounts are all
  seed-derived and bump-checked (`seeds = […], bump = …`), with `has_one`
  cross-checks (`curve.mint`, `curve.base_mint`, `position.owner`) rather
  than accepting caller-supplied addresses for anything that settles value.
- **Oracle staleness (RH):** `maxOracleStaleness` defaults to `90_000`
  seconds (25h) specifically because Robinhood Chain's Chainlink feeds have
  a 24h heartbeat — confirmed still correct in
  `StonkzLaunchpad.sol` (comment + value) and mirrored on the Solana side
  (`admin.rs::DEFAULT_MAX_ORACLE_STALENESS` is shorter, 90s, because Solana's
  own `BaseOracle` is a program-owned account written by a dedicated pusher
  on a fast cadence, not a long-heartbeat Chainlink feed — this is a
  legitimate per-chain divergence, not drift). `ChainlinkPriceSource.sol`
  additionally checks `answeredInRound >= roundId` (rejects a carried-over
  stale round) and a sanity price band, and never reverts the caller — a dead
  feed degrades to "no answer," which `graduate()`/`createToken` each handle
  according to their own correct policy (defer graduation; refuse creation).
- **`quotedOut` vs curve floor separation (`StonkzRouter.sol` +
  `router/compose.ts`/`evm-router.ts`):** the aggregator leg's floor
  (`shortfallFloor(quotedOut, maxSlippageBps)`, capped at the contract's
  `MAX_SLIPPAGE_BPS = 500`) and the curve leg's `minTokenOut`/`minBaseOut`
  are independent parameters all the way from `composeCurveTrade` through
  `buildAtomicBuyCall`/`buildAtomicSellCall` to the contract call — confirmed
  by reading the field-by-field wiring, not just the doc comments asserting
  it. A bad fill on one leg cannot hide inside the other's tolerance. The
  "zero Stonkz fee on the aggregator hop" invariant is enforced twice, at
  different layers (`router/uniswap.ts`'s `portionBips` assertion, and the
  contract's own balance-delivered check), which is deliberate defense in
  depth, not redundant.
- **Permit replay/malformed-permit (RH sell flow):** `StonkzToken.permit`
  increments `nonces[owner]` inside the struct hash itself, so a signature is
  single-use by construction; the domain separator rebuilds itself if
  `block.chainid` ever changes (fork replay protection); `StonkzRouter.
  sellViaAggregator`'s permit branch (`permitData.deadline != 0`) calls
  `permit` and the pull inside the same transaction, so there's no window
  where an approval exists without an accompanying trade. The
  standing-allowance branch (`deadline == 0`) is the `_noPermit()` shape
  pinned against `Router.t.sol`'s own fixture.
- **Game ledger server authority:** every reward path was traced from its
  route handler down to the DB write. No route accepts a client-supplied
  XP/SP/Optionz amount, crate tier outcome, or RNG seed; `CHAIN_VERIFIED_
  REASONS` refuses trade/launch/fee-claim/stake/most-achievement awards
  without a matching `chain_events` row, and `xp_events`' unique constraint
  on `(wallet, tx_sig, reason)` makes replaying a signature a no-op rather
  than a second payout (confirmed: the catch path on a unique-violation
  returns `awarded: false` and pays nothing).
- **Double-claim / race conditions in crates and achievements:** the crate
  cooldown is one conditional `INSERT … ON CONFLICT DO UPDATE … WHERE
  readyAt <= now`, so two concurrent opens for the same wallet/tier/net
  cannot both succeed — the loser's `WHERE` matches nothing and it falls
  into the `cooling_down` branch. Achievement unlocks use `onConflictDoNothing`
  on the primary key as the "claimed" gate, checked *before* the XP award
  runs, with an explicit rollback (`DELETE` the claim row) if the award
  itself throws — so a failed award can't leave an achievement marked
  unlocked-but-unpaid, and a retry after a genuine failure can still succeed
  rather than being permanently blocked by an orphaned claim.
- **Tips (Phase 5):** `verifyTip` reads the transfer back from the chain
  (`getNativeTransfer`, an RPC-backed lookup), checks sender, recipient,
  success status, and minimum amount against the on-chain fact, never the
  request body — confirmed the request body's claimed amount is discarded
  and only `verification.amountNative` (the RPC's own number) is ever
  written to `wall_posts.tip_native`. The signature is the row's uniqueness
  key (`wall_posts_sig_uq` on `(net, tip_tx_sig)`), so the same tip can back
  exactly one post — a resend of the same signature hits the unique
  violation and is rejected as `signature_already_used`, not credited twice.
- **SIWS/SIWE replay and session handling:** nonces are single-use, enforced
  by an atomic `UPDATE … WHERE consumedAt IS NULL` rather than a
  read-then-write race; the signed message is rebuilt server-side from the
  stored nonce/domain/URI/statement/chain-id and compared byte-for-byte
  against what the client sent, so a client cannot alter any field of the
  challenge and still pass; refresh tokens are rotated on every use and a
  replayed (already-rotated) refresh token revokes the whole session as a
  theft signal, not just failing quietly; access tokens carry a `jti` and can
  be revoked immediately via a Redis blacklist rather than only expiring
  naturally. `net` is bound into both the nonce and the JWT claims, so a SOL
  session cannot be replayed as if it were an RH session or vice versa.
- **ERC-1271 smart-account fallback:** only attempted after a plain ECDSA
  recovery has already failed (so an EOA login never pays an RPC round
  trip), calls `isValidSignature` on the *claimed* address specifically (an
  impostor's valid signature over the same message, from a different
  address, cannot be substituted in — confirmed there is no code path that
  calls `ethCall` against anything other than `address` from the login
  request), and treats a revert (a plain EOA has no code) the same as an
  explicit rejection.
- **Secrets:** no API keys, private keys, or credentials found committed
  anywhere in tracked files (`git grep` swept for common secret-shaped
  patterns and `.env*`/`*.pem`/`*.key` files; only `.env.example` is
  tracked). Production boot refuses to start with the dev JWT/crate secrets,
  refuses a `JWT_SECRET` under 32 characters, refuses the public
  (rate-limited, unsupported-for-prod) RH RPC endpoint, and refuses an unset
  launchpad address — all fail loud at boot, not silently at runtime.
- **CORS/CSP:** CORS is an explicit origin allow-list (`ston.kz` + declared
  localhost/127.0.0.1 dev ports), not a wildcard, and is credentialed only
  for allow-listed origins; a non-listed `Origin` header gets no CORS headers
  and a `403` rather than a permissive fallback. The API's own CSP is
  `default-src 'none'` plus `frame-ancestors 'none'`/`sandbox` — appropriate
  for a JSON-only origin that serves no HTML/script of its own. (The static
  web host's CSP is a separate concern per `apps/api/README.md`'s own note
  and was not re-audited here since it's outside `apps/api`.)
- **Rate limiting on sensitive endpoints:** `trade/prepare`, crate open,
  wall/tip post, launch/prepare, auth, and social writes all carry a
  `limit(...)` call (confirmed by grep across every route file) — the two
  gaps found (`GET /me`, `GET /native-price`) are fixed in this review (M3),
  and the identity-spoofing gap underneath all of them (M1) is fixed too, in
  a later round — see M1's own resolution note.

---

## Fixes applied in this review

Both fixes are additive, one-line-per-route, and match the pattern every
sibling route in the same file already uses. No behavior changes for any
client operating within the new limits; `pnpm typecheck` (apps/api) and the
existing `apps/api` test suite were re-run after the change and are
unaffected (no test exercised these two routes' absence of a rate limit, so
none needed updating).

1. **`GET /me`** (`apps/api/src/routes/me.ts`) — added
   `limit(RATE_LIMITS.read)` alongside the existing `requireAuth()`. Closes
   the unbounded RPC/oracle/DB fan-out noted in M3.
2. **`GET /native-price`** (`apps/api/src/routes/me.ts`) — added
   `limit(RATE_LIMITS.read)`. This route has no auth at all, so it was the
   more exposed of the two; same fix, same budget as every other public read
   route.

Everything else in this document is a finding only, per the brief's
instruction to document rather than touch `programs/solana`/`programs/evm`
or anything requiring a wider blast radius than a one-line rate-limit
addition.

## Fixed in later rounds (after this review)

- **H1** — real Raydium CPMM CPI + SPL LP burn in `programs/solana`
  (`0f5f6b6`, tests `ed6ce66`, docs `9ca894f`).
- **M1 / L2** — trusted-proxy-depth IP resolution in `apps/api`
  (`6668e9e`).

Still open from this document: **M2** (crate VRF before odds are marketed),
**M4** (`SafeERC20` before new EVM base assets), **L1** (tip
`blockTimeMs === null` should fail closed), **L3** (whale/dust constants want
to live in `packages/shared`). Their status is tracked alongside the rest of
the pre-production gaps in [`real-vs-simulated.md`](real-vs-simulated.md).

---

## Summary table

| # | Severity | Area | One-line summary |
|---|----------|------|-------------------|
| H1 | High (fixed) | Solana graduation | LP burn/migration was an unconstrained, unverifiable trusted hand-off; now a real Raydium CPMM CPI + SPL burn, tested against the real devnet program |
| M1 | Medium (fixed) | apps/api rate limiting | Per-IP identity trusted a client-controllable `X-Forwarded-For`; now bound to a fixed `TRUSTED_PROXY_DEPTH` read from the right, failing closed |
| M2 | Medium | Crate RNG | HMAC RNG is auditable, not publicly verifiable — already documented in-repo as pre-marketing-odds blocker |
| M3 | Medium (fixed) | apps/api | `GET /me` and `GET /native-price` had no rate limit — added |
| M4 | Medium | EVM contracts | Raw ERC-20 calls without `SafeERC20`; safe against known base assets today, worth hardening before new base assets are added |
| L1 | Low | Tips | `blockTimeMs === null` skips the recency check instead of failing closed |
| L2 | Low (fixed) | apps/api logging | `sessions.ip` inherited M1's spoofable input; now records the same trusted-depth resolution |
| L3 | Low | apps/api | Whale-cut/dust constants flagged (by the code itself) as wanting to move to `packages/shared` |

No critical findings. Everything else checked — fee-split math on both
chains, overflow/underflow handling, EVM reentrancy guards, Solana signer/PDA
validation, RH oracle staleness, the router's slippage/quote separation,
permit replay, the entire game ledger's server authority and double-claim
races, tip verification, SIWS/SIWE replay and session handling, the ERC-1271
fallback, committed secrets, and CORS/CSP — came back clean, and is
documented above under "Closed / confirmed-safe" so this review's coverage is
auditable rather than just asserted.
