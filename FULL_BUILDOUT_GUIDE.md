# Stonkz — Full Buildout Guide

**Status of this document:** describes the frontend exactly as shipped in `index.html`, draws a hard line around what is simulated, and lays out every backend, contract and operational piece required to turn it into a complete, live product on **ston.kz**.

Read it top to bottom once. After that, §4 (Simulation Boundary) and §6 (Backend Buildout) are the working reference.

---

## Table of contents

1. [Product thesis](#1-product-thesis)
2. [Frontend architecture](#2-frontend-architecture)
3. [Feature inventory](#3-feature-inventory)
4. [Simulation boundary](#4-simulation-boundary)
5. [Data model reference](#5-data-model-reference)
6. [Backend buildout](#6-backend-buildout)
7. [On-chain buildout](#7-on-chain-buildout)
8. [Frontend → API migration map](#8-frontend--api-migration-map)
9. [Frontend hardening](#9-frontend-hardening)
10. [Economics & anti-abuse](#10-economics--anti-abuse)
11. [Known gaps and decisions still open](#11-known-gaps-and-decisions-still-open)
12. [Phased roadmap](#12-phased-roadmap)
13. [Glossary](#13-glossary)

---

## 1. Product thesis

Stonkz is a memecoin launchpad that borrows the *feel* of a Bloomberg terminal — black ground, amber accent, dense monospace data, hairline panels, zero radius — and wraps it around a pump.fun-style mechanic: fair launch on a bonding curve, graduation at **$69K market cap**, liquidity migrates to a DEX and the LP burns.

What makes it Stonkz rather than another fork is the **game layer** on top of trading:

| Loop | Mechanic |
|---|---|
| Progression | XP on every trade, launch, stake, claim, follow and post → 10 ranks (LURKER → STONK LORD) with a rank-up ceremony |
| Retention | Daily streaks multiply XP (1.00× day one → 1.30× at seven days) |
| Collection | 10 achievements, each with its own XP |
| Variable reward | Stonkdrops — 8 crate tiers on cooldowns from 1h to 7d with published drop tables |
| Ownership | Creator fees, cashback launches, staking with lock multipliers, shoutbox tips |
| Social | Profiles, follows, member walls, most-profitable friends, per-token and global chat |

Everything is designed so the first minute closes the loop: land → learn (wizard) → connect → trade → level up → unlock → come back tomorrow.

---

## 2. Frontend architecture

### 2.1 Shape

One file. `index.html` carries three sections in order:

1. `<style>` — all CSS, token-driven (`:root` custom properties), single committed dark theme.
2. Markup — header, tape, five views (board / token / rewards / profile) as sibling `.wrap` containers toggled with `hidden`, fixed footer, chat drawer, and six modal scrims.
3. `<script>` — a single IIFE in strict mode. Modules are comment-delimited sections, not separate files. There are **no external scripts**; fonts are the only network dependency (Google Fonts: IBM Plex Mono, IBM Plex Sans Condensed, Silkscreen).

Total ≈ 210 KB uncompressed. No framework, no bundler, no transpiler — it runs as-is.

### 2.2 Views and routing

There is no URL routing. `showView(name)` toggles `hidden` on `#boardView`, `#tokenView`, `#rewardsView`, `#profileView`. Back buttons and Escape unwind. Token and profile views are re-rendered from templates on open; board is rendered once and mutated in place.

**Buildout note:** the real product needs URLs (`/t/WOJAK`, `/u/7xKQ…`, `/rewards`) — see §9.

### 2.3 Rendering strategy

- **Board cards** are created once (`card(c)`), cached on the coin object (`c.el`), then patched by `paint(c)` every tick. Lane moves re-parent the same element (FLIP-animated).
- **Token page, rewards, profile, modals** are rebuilt from HTML strings via `innerHTML` and re-wired. Live numbers are then patched by `sync*()` functions each tick so inputs keep focus.
- **Charts and pixel art** are Canvas, DPR-aware, redrawn on data change and resize.

### 2.4 The heartbeat

`setInterval(tick, 1100)` drives the simulation:

- random-walks every coin's market cap and 24h change
- accrues fees (`accrueFees`) — creator cut, cashback token buys, staking pool
- migrates coins between lanes when curve % crosses thresholds
- mints a new coin every 9 beats (cap 28)
- ages coins, saves stake rewards every 9 beats, checks Diamond Hands every 10
- updates King of the Hill, the open token page, the open stake modal and the profile

A second `setInterval(updateCrates, 1000)` runs crate countdowns. The tape has its own randomized push loop (850–2350 ms). Chat has a 3.5–7.7 s message loop.

**Buildout note:** `tick()` is the seam. In production it is replaced by WebSocket subscriptions (§8).

### 2.5 Persistence

Two `localStorage` keys, both wrapped in try/catch and safe to lose:

| Key | Contents |
|---|---|
| `stonkz.rewards.v1` | the `USER` object — XP, $STONKZ balance, crates, drop log, fees claimed, wizard/hello flags, stake positions, follows, username, bio, streak, achievements |
| `stonkz.settings.v1` | the `SET` object — slippage, priority fee, MEV mode/tip, fee cap, default buy, confirm toggle |

Everything else (coins, trades, holdings, walls, members, wallet) is in-memory and regenerates deterministically from seeds on reload.

### 2.6 Effects systems

- `FX` — one fixed full-viewport canvas for pixel debris. `FX.burst(x, y, h, {n, spread, gold, green})`. Used by the tape, lane inserts, King of the Hill crowning, crate opens, rank-ups, achievements, fills.
- `punchIn(el)` — CSS keyframe punch + shake + a debris burst, for anything landing on the board.
- `moneyRain(n)` — the +$10,000 shower on the wizard's finish step (CSS custom-property keyframes, 36 elements).
- `rankUp(i)` — full-screen overlay with gold bursts.
- Toasts stack three deep (`toast(msg, kind)` with `gold`, `ach`, `red` variants).

All animation respects `prefers-reduced-motion`.

---

## 3. Feature inventory

Each item lists what the UI does and, in **▶**, what it's wired to today.

### 3.1 Header
- Brand (meme-man 32×32 sprite + Silkscreen wordmark) → home.
- Search: filters cards live; Enter on an exact ticker opens the token. ▶ client-side over `COINS`.
- Rank widget (hidden until a wallet connects): level, rank name, XP bar, XP; hover tooltip with XP to next, next rank, $STONKZ, crates ready, streak multiplier, achievements; click → rewards. ▶ `USER`.
- HOW IT WORKS → 3-step wizard, +$10,000 rain on first finish only.
- CONNECT WALLET → network picker (**Solana**, **Robinhood**) → mock connect. Connected chip shows network dot + short address; menu shows network, balance, copyable full address, PROFILE / SETTINGS / DISCONNECT. ▶ `WALLET`, `NETS`; no signing.

### 3.2 Live tape
- Prints punch in from the right with debris; the row FLIP-slides left.
- Hover freezes a **clone** of the print (bright amber) while the row keeps moving; a card shows a mini chart sized to the coin's age (5M → 24H) — click opens the token. ▶ synthetic prints from `COINS`.

### 3.3 Board
- **NEW HERE?** strip for disconnected first-time visitors (opens the wizard; dismiss persists).
- **King of the Hill**: highest-cap pre-graduation coin; crowning punches in with a 5-second gold glow.
- Sort chips: NEWEST / MARKET CAP / GAINERS / MOST REPLIES. `+ LAUNCH A COIN` (grey until a wallet connects; 8-second wake animation on connect; 10–15 s nudge thereafter).
- Three lanes — NEW MINTS (< 55% curve), ABOUT TO GRADUATE (55–99%), GRADUATED (100%). Cards: pixel avatar, ticker, name, creator (clickable), age, replies, description, market cap, holders, curve % and a bottom progress bar. Lane changes punch in and slide neighbours. Graduation fires a toast, chat system message and (if you hold it) the GRADUATE achievement.

### 3.4 Token page
- Strip: avatar, ticker/name, pair, supply, fee, CA, creator (clickable), age, ACTIVE/BONDED chip, PRICE / MCAP / 24H / VOL / LIQUIDITY / HOLDERS, **SHARE** (copies `https://ston.kz/t/SYM`), **STAKE**.
- Cashback banner while the window is live (fee decay, countdown, progress bar).
- Chart: market-cap scale, volume bars, hi/lo labels, last-price tag, crosshair readout, 15M/1H/6H/ALL. Bonding-curve meter with "$X to go".
- Trade box: BUY/SELL, amount + quick chips, **quote** (receive, pay, price, impact, slippage/fee, network prio+MEV from settings, min received, route) refreshing on an 8-second bar; balance line in the pair's unit; **YOUR POSITION** line with live PnL; fill → panel flash, green debris, stacked toasts, realized-PnL toast on sells, XP, achievements (First Blood, Whale).
- Activity tabs: RECENT TRADES (live, CASHBACK-tagged buys, clickable traders) / HOLDERS (clickable, DEV/SNIPER/WHALE/CURVE tags) / COMMENTS (post, clickable authors).
- X Stream: handle input → themed simulated posts. ▶ no X API call.

### 3.5 Launch a coin (3 steps)
1. **Identity** — avatar reroll, name, ticker (validated, collision-checked), description, website, X, Telegram.
2. **Market** — base token (network-aware: Solana top-10 majors or Robinhood ETH-led majors; **STOCK TOKENS** tab with the top-20 tokenized stocks from GeckoTerminal's Solana category, snapshot 2026-09-06), filter box; supply 1M / 500M / 1B / 1T; trading fee slider 1.0–5.0% in 0.1 steps.
3. **Dev buy** — bonding-curve preview redrawn on every keystroke (entry marker, green fill to your fill, price after), four stat tiles, summary line; **CASHBACK** card (only selectable at zero dev buy) — for 5 minutes the fee opens at 50% and decays to the set fee, every fee is spent buying the token for the creator, then fees accrue in the native unit.
- LAUNCH deploys, records the dev buy as the first trade, pays 150 XP, unlocks Deployer / Cashback King, opens the token page.

### 3.6 Rewards
- Rank strip with progress, XP to next, $STONKZ balance, crates ready.
- **Stonkdrops**: 8 tiers with cooldowns BRONZE 1h · IRON 2h · SILVER 4h · GOLD 6h · PLATINUM 12h · IRIDIUM 24h · PALLADIUM 3d · RHODIUM 7d. Selecting shows the drop table (five rarity rows with odds and ranges); OPEN shakes, bursts gold, reveals, starts cooldown, pays XP, logs. Cooldowns persist across reloads.
- **Achievements** grid (10). **Drop History** table.

### 3.7 Staking
- STAKE modal per token: total staked (% of circulating), your stake and multiplier, fees-to-pool %, your earnings; donut of creator-fee split; amount + MAX; lock grid FLEX 1× · 1D 1.1× · 7D 1.25× · 30D 1.5× · 90D 2.5× · 180D 5× · 1Y 8×; STAKE / UNSTAKE (locked positions refuse until their date); CLAIM.
- Pool share = **50% × (staked ÷ circulating)**, circulating = 80% of supply. Rewards pay in the token during a cashback window, native unit otherwise. Positions persist.

### 3.8 Profiles
- Own: username + bio (EDIT PROFILE), followers/following, rank (→ rewards), five-tile metrics incl. CREATOR FEES, **Portfolio** (HOLDINGS / STAKED + CLAIM ALL), **Wall** (SHOUTBOX default / RECENT ACTIVITY), **Coins You Launched** (CLAIM FEES → claim modal), **Most Profitable Friends** (24H / 7D / 1M).
- Others (any address anywhere is a link): same layout minus owner controls; FOLLOW/UNFOLLOW; tip-gated shoutbox — minimum **0.001 SOL / 0.0001 ETH**, 100% to the recipient. Members are generated deterministically from the address hash; their launched coins are real (`COINS` filtered by creator).

### 3.9 Chat drawer
- Left edge tab with unread badge. GLOBAL room always; a `$SYM` room appears while on a token, with room chips to hop between them. System messages for mints, graduations, connects, claims. Sending may get a simulated reply.

### 3.10 Settings
- Slippage (chips + free entry), priority fee (LOW/FAST/TURBO), MEV SHIELD / PRIVATE RELAY / OFF with tip, max fee cap, default buy, confirm-before-send. Applied to every quote. Persisted.

---

## 4. Simulation boundary

This is the contract for the buildout. **Every row below is fake today** and names its replacement.

| Area | Simulated as | Real replacement |
|---|---|---|
| Prices, volume, 24h change | seeded random walk in `tick()` | indexer + WebSocket price feed (§6.3) |
| Candles / history | `histOf()` geometric series | OHLCV from indexer |
| New mints, graduations, lane moves | timer-driven | on-chain events via indexer |
| Trades table, tape prints | generated | on-chain fills |
| Holders table | seeded | token account snapshot from indexer |
| Wallet connect | mock addresses per network | Wallet adapters + SIWS/SIWE (§6.2) |
| SOL / ETH balance | in-memory number | RPC balance |
| Buy / sell fills | instant local mutation | signed transaction against the curve / DEX router |
| Quote | local formula (impact ∝ size ÷ liquidity) | curve program simulation / DEX aggregator quote |
| Launch | pushes into `COINS` | `create_token` + `dev_buy` transactions |
| Cashback window | `cbStart` + 5-minute timer, local fee routing | program-enforced decaying fee with buy-back router |
| Creator fees / claims | `c.fee` accrues from simulated volume | on-chain fee vault + claim instruction |
| Staking, locks, rewards | `USER.stake` math in `accrueFees` | staking program with lock escrow and reward accrual |
| Crates, odds, cooldowns | client-side RNG + timestamps | server-side rolls with verifiable randomness (§10) |
| XP, ranks, streaks, achievements | client-side, `localStorage` | server ledger with signed event validation (§6.4) |
| $STONKZ balance | number in `USER` | SPL/ERC-20 token or ledger with claim |
| Profiles, follows, walls, tips | in-memory / `localStorage` | Postgres + tip transaction verification |
| Chat | scripted loops | WebSocket chat service with moderation |
| X Stream | scripted posts | X API v2 with server cache |
| Tokenized stock list | static snapshot array | GeckoTerminal / oracle pull, refreshed server-side |
| Share links | copies `https://ston.kz/t/SYM` | real routes + OG images |

---

## 5. Data model reference

Names as they appear in the script. This is what the API must be able to hydrate.

### 5.1 Coin (`COINS[i]`)
```
id, sym, name, desc
mc            market cap USD (price = mc / supply)
chg           24h %
reps, hold    replies, holders
age           minutes since launch
seed          avatar / deterministic-series seed
dev           creator address
lane          "new" | "soon" | "grad"
el            cached card element
lastMc        previous tick, for flash direction
x, web, tg    socials
h, hv         history (mcap[], volume[]) — lazy
trades        [{t, buy, sol, tok, mc, w, v, cb, fresh}] — lazy
comments      [{who, t, text, mine}] — lazy
mine          launched by this wallet
fee           unclaimed creator fees in native unit
feeTokens     creator token allocation from cashback
supply        1e6 | 5e8 | 1e9 | 1e12 (default 1e9)
base          pair base symbol (SOL, ETH, USDC, AAPLx …)
tfee          trading fee % (1.0–5.0)
net           "SOL" | "RH"
cashback      bool
cbStart       ms epoch
_oth          simulated third-party stake (lazy)
```

### 5.2 User (`USER`, persisted)
```
xp, stonkz
crates        { TIER: readyAtMs }
log           [{t, k, r, col}]        drop history
feesClaimed   lifetime native
seenWiz, seenHello
stake         { SYM: {amt, mult, days, until, rewTok, rewSol} }
follow        { address: 1 }
name, bio
streak, lastDay
ach           { key: unlockedAtMs }
```

### 5.3 Wallet (`WALLET`) · Networks (`NETS`)
```
WALLET: on, net, addr (short), full, sol (native balance), seed, provider
NETS.SOL / NETS.RH: k, name, sub, col, provider, seed, addr, full
```

### 5.4 Settings (`SET`, persisted)
`slip, prio, mev ("SHIELD"|"RELAY"|"OFF"), mevTip, cap, defBuy, confirm`

### 5.5 Members & walls (in-memory)
```
MEMBERS[addr]: addr, seed, name, bio, followers, following, joined, xp, _h (holdings), _t (trades)
WALLS[addr]:   [{from, text, tip, t, mine}]
```

### 5.6 Constants worth knowing
`GRAD = 69000` · `SUPPLY = 1e9` · `CB_MS = 300000` · `CB_START_FEE = 50` · `LOCKS` · `RANKS` · `CRATES` (with drop tables) · `ACH` · `STOCKS` · `MAJORS` · `SUPPLIES` · bonding curve `curveMc(sol) = 1400 + 2600 · sol^1.12`.

---

## 6. Backend buildout

### 6.1 Services overview

```
                 ┌────────────┐      ┌──────────────┐
  Browser ─────▶ │  API (REST │ ───▶ │  Postgres    │  profiles, follows, walls, chat,
    ▲            │  + WS)     │      │              │  xp ledger, crates, achievements
    │            └─────┬──────┘      └──────────────┘
    │                  │
    │            ┌─────▼──────┐      ┌──────────────┐
    └── WS ◀──── │  Indexer   │ ◀─── │  Chains      │  Solana programs · Robinhood Chain
                 │ (Geyser /  │      │  (RPC/Geyser)│  contracts
                 │  logs)     │      └──────────────┘
                 └─────┬──────┘
                       ▼
                 ┌────────────┐      ┌──────────────┐
                 │ ClickHouse │      │  Redis        │  hot prices, quotes, rate limits,
                 │ (trades,   │      │              │  WS fan-out
                 │  candles)  │      └──────────────┘
                 └────────────┘
```

### 6.2 Auth
- Sign-In-With-Solana / SIWE message signed by the wallet → session JWT (short-lived) + refresh.
- Wallet adapters: Solana Wallet Standard (Phantom, Backpack, Solflare); EVM via wagmi/viem for Robinhood Chain.
- The frontend's `connectWallet(netKey)` becomes: pick network → adapter connect → sign nonce → `POST /auth/siws`.

### 6.3 Indexer
- Subscribe to the launchpad program (Solana: Geyser plugin or Helius webhooks; EVM: log subscriptions).
- Materialize: tokens, trades, holders, candles (1m/5m/15m/1h/4h/1d), volume, curve state, graduations, fee events, stake events, cashback windows.
- Emit to Redis pub/sub → WS gateway → clients subscribed by token / board / user.

### 6.4 API surface (REST + WS)

**Tokens & market**
- `GET /tokens?lane=&sort=&q=` — board
- `GET /tokens/:sym` — strip + curve state
- `GET /tokens/:sym/candles?tf=` · `/trades` · `/holders` · `/comments`
- `POST /tokens/:sym/comments`
- `GET /tokens/:sym/quote?side=&amount=` — server-side curve simulation (or aggregator for graduated)
- `GET /koth`, `GET /tape` (recent fills across the board)
- `WS board`, `WS token:{sym}` — prices, fills, curve, cashback fee, lane moves

**Launch**
- `POST /launch/prepare` — validate identity, base token, supply, fee, dev-buy/cashback → unsigned tx(s)
- `POST /launch/confirm` — tx signature → token record
- `GET /base-tokens?network=` — majors + tokenized stocks (server-refreshed)

**Wallet & user**
- `GET /me` — profile, balances, XP, streak, achievements, crates, stake positions, unclaimed fees
- `PATCH /me` — username, bio
- `GET /users/:addr` — public profile (portfolio, activity, launched coins, friends' PnL)
- `POST /users/:addr/follow` · `DELETE …`
- `GET /users/:addr/wall` · `POST /users/:addr/wall` — body includes the tip tx signature; server verifies amount ≥ minimum and recipient before posting
- `GET /friends/pnl?window=24h|7d|1m`

**Rewards**
- `GET /rewards` — crates with cooldown state, drop tables, XP, rank
- `POST /rewards/crates/:tier/open` — server rolls (§10), returns reward, starts cooldown
- `GET /achievements` — definitions + unlocks; unlock evaluation is server-side on events

**Staking & fees**
- `GET /stake/:sym` — pool totals, your position, earnings, split
- `POST /stake/:sym/prepare` (stake/unstake with lock) → unsigned tx
- `POST /stake/:sym/claim/prepare`
- `GET /fees` · `POST /fees/claim/prepare`

**Social**
- `WS chat:global`, `WS chat:{sym}` — messages, presence, moderation events
- `GET /x/:handle` — cached X posts (server holds the API key)

### 6.5 Storage

**Postgres**: users (address, network, username, bio, created_at), follows, wall_posts (with tip_tx), comments, chat_messages, xp_events (append-only ledger), achievements, crate_opens, streaks, settings.
**ClickHouse** (or TimescaleDB): trades, candles, holder snapshots, fee events.
**Redis**: latest price per token, quote cache (8-second TTL matches the UI), rate limits, WS fan-out, cooldown locks.
**Object storage**: token images and profile avatars (uploads replace the generated pixel art), OG share images.

### 6.6 Operations
- Hosting: static frontend on a CDN; API + WS on autoscaled containers; indexer as a stateful service with replay.
- Observability: request/WS metrics, indexer lag alarms, chain RPC health.
- Rate limiting per IP and per wallet; captcha on launch and wall posts if abuse appears.
- Moderation: profanity/URL filters on chat, walls, comments, token names; report/ban tooling.
- Legal: terms, risk disclosure, jurisdiction gating, tokenized-stock disclaimers; the UI's `SIMULATED DATA · NOT FINANCIAL ADVICE` chip becomes a real disclosure link.

---

## 7. On-chain buildout

The frontend's mechanics imply these programs. Solana first (Anchor); mirror on Robinhood Chain (EVM) with the same interfaces.

### 7.1 Launchpad / bonding curve program
- `create_token(name, ticker, uri, supply, base_mint, fee_bps, cashback: bool)` — mints fixed supply, revokes mint/freeze authority, seeds the curve vault, records creator.
- `buy(amount_in, min_out)` / `sell(amount_in, min_out)` — against the curve with slippage protection.
- Curve: the UI uses `mc = 1400 + 2600·sol^1.12`; choose a production curve (constant-product virtual reserves are standard) and expose its parameters so the quote endpoint and the Step-3 preview match the chain exactly.
- **Graduation** at $69K (oracle-priced) → migrate reserves to a DEX pool (Raydium/Meteora; Uniswap-style on EVM), burn LP tokens, flip token to `graduated`.
- Pairs against any base mint including tokenized stocks — the vault must hold the base mint, so quote math converts via oracle.

### 7.2 Fee router
- Per-trade fee `fee_bps` (100–500). Split: protocol 1%, remainder to creator vault, minus the staking pool share computed from `staked / circulating` (max 50% of the creator portion).
- **Cashback mode**: for 300 s after launch, fee = `base + (5000 − base) × remaining/300` bps; the fee is swapped into the token and credited to the creator's allocation instead of the native vault. Enforce on-chain, not in the client.
- `claim_creator_fees()` — native + token allocation.

### 7.3 Staking program
- `stake(amount, lock_days ∈ {0,1,7,30,90,180,365})` → escrow + weight = amount × multiplier `{1,1.1,1.25,1.5,2.5,5,8}`.
- `unstake(amount)` — rejected before `lock_until`.
- Reward accrual per token pool from the fee router; `claim()` pays in the token during cashback, native after — or simplify to native-only and let the UI relabel.
- Read-only: pool totals, per-user weight, pending rewards (the UI's stake modal fields).

### 7.4 Tips
- Wall posts require a transfer ≥ 0.001 SOL / 0.0001 ETH to the recipient. Simplest: a plain transfer whose signature is submitted with the post; the API verifies recipient, amount and recency before accepting. No program needed.

### 7.5 $STONKZ
- Decide: on-chain token (SPL + ERC-20 bridged) vs off-chain ledger with periodic settlement. Crates and achievements pay $STONKZ; if on-chain, mint from a rewards treasury via a server-signed claim to avoid per-drop transactions.

---

## 8. Frontend → API migration map

Where each simulated function gets rewired. Function names are the ones in `index.html`.

| Frontend today | Becomes |
|---|---|
| `tick()` price walk | `WS board` handler → `paint(c)`; `WS token` → `syncToken()` + candle append |
| `histOf(c,n)` / `seedSeries` | `GET /tokens/:sym/candles` |
| `seedTrades`, `pushTrade` (random) | `GET …/trades` + `WS` fills; keep `pushTrade` as the renderer |
| `holdersOf` | `GET …/holders` |
| `renderQuote()` local math | `GET …/quote` (debounced) — keep the 8-second bar as the refresh cadence |
| `#t-go` handler | build tx from quote → wallet sign → `POST` confirm → optimistic `pushTrade` |
| `doLaunch()` | `POST /launch/prepare` → sign → `/confirm` → `openToken` |
| `connectWallet(netKey)` | adapter connect + SIWS/SIWE |
| `renderWallet` balance | RPC balance subscription |
| `accrueFees()` | remove; fees, cashback and stake rewards arrive from the indexer |
| `openStake / doStake / claimStake` | `/stake/*` prepare → sign |
| `openClaim / doClaim` | `/fees/claim/prepare` → sign |
| `openCrate` RNG | `POST /rewards/crates/:tier/open`; render the returned reward |
| `addXP`, `unlock`, `touchStreak` | server emits `xp` / `achievement` / `streak` events over WS; UI keeps the ceremonies (`rankUp`, toasts) |
| `memberOf`, `memHold`, `memTrades`, `memProfit` | `GET /users/:addr`, `/friends/pnl` |
| `postShout` | tip transfer → sign → `POST /users/:addr/wall` with signature |
| `toggleFollow` | `POST/DELETE /users/:addr/follow` |
| chat loops | `WS chat:*` |
| `renderX` | `GET /x/:handle` |
| `STOCKS`, `MAJORS` arrays | `GET /base-tokens?network=` |
| `localStorage` USER/SET | server-side; keep `SET` local as a fallback |

Keep: all rendering, animation, FX, layout, the wizard, the launch stepper, the staking modal, the profile templates. They are presentation and are already shaped around these data models.

---

## 9. Frontend hardening

Do these before wiring the API — they make the rewiring safer.

1. **Split the file.** `styles/`, `views/{board,token,rewards,profile}`, `modals/`, `fx/`, `state/`, `api/`. Vite + TypeScript. Keep zero framework or adopt Preact; the code is DOM-string based and ports cleanly to either.
2. **Types** for the §5 models; the API client returns them.
3. **Routing**: `/`, `/t/:sym`, `/u/:addr`, `/rewards`, `/launch`; history-aware back buttons; OG tags per token for the SHARE link.
4. **Security**: every user string already goes through `esc()` — keep that invariant, add a CSP (`script-src 'self'`, fonts allow-listed), sanitise uploaded images, never render URLs from users as clickable without validation.
5. **Accessibility**: modals need focus trapping and `aria-modal` (attributes exist, trapping doesn't); tables need scope headers; the tape and drawer already have labels.
6. **Mobile**: layout collapses to one column at 680 px, but the trade box, chart crosshair and drawer want a real touch pass; the tape hover has no touch equivalent (tap = open is fine).
7. **Performance**: the board re-sorts on each chip click and re-parents cards; at 1,000+ tokens virtualise lanes. Charts redraw every 1.1 s while a token is open — throttle to visible frames.
8. **Tests**: unit-test the pure math (`curveMc`, `effFee`, `poolFrac`, `rankOf`, `xpMult`, `rollDrop`), snapshot the templates, Playwright the journeys in §12.
9. **i18n**: all copy is inline uppercase strings; extract if localisation is planned.
10. **Art**: `WIZART` and the brand sprite are hooks for real illustrations (data URIs or hosted assets).

---

## 10. Economics & anti-abuse

- **XP** is an anti-sybil surface: award only on server-verified events (confirmed txs, real follows, real tips). Cap XP per wallet per day; weight by notional to stop dust trades.
- **Crates**: odds must be rolled server-side with verifiable randomness (Switchboard VRF / drand commit-reveal) and the drop tables published; cooldowns enforced server-side keyed to wallet, not device.
- **Streaks**: server clock, one increment per UTC day per wallet.
- **Achievements**: evaluate from the ledger, not the client.
- **Creator fee routing** and **cashback** must be enforced in the program — the client only displays.
- **Staking** share formula (50% × staked/circulating) is cheap to game with wash-staking of a coin you control; consider a minimum lock for pool weight or an honest-circulating measure.
- **Tips** are real transfers; verify signatures and prevent replay (one post per signature).
- **Tokenized stocks** as base pairs carry regulatory weight — jurisdiction gate and disclaim.

---

## 11. Known gaps and decisions still open

- **Units on non-native pairs.** Balances and quotes are SOL/ETH-denominated; a coin paired to AAPLx shows amounts in AAPLx but the wallet balance is native. Decide whether the vault holds the base mint (true pairs) or whether "base" is a display/oracle choice.
- **Robinhood Chain** is treated as an EVM L2 with ETH gas; confirm the actual chain, token standards and available DEX for graduation.
- **Curve formula** in the UI is illustrative; the production curve decides graduation math, dev-buy previews and fee amounts.
- **$STONKZ** tokenomics, supply, and whether crates settle on-chain.
- **Circulating supply** is fixed at 80% of supply in the UI; production should read curve reserves.
- **Members** are generated from address hashes; usernames must be unique and reserved server-side.
- **X Stream** requires an X API tier and caching strategy.
- **Art**: wizard illustrations and the brand head are canvas stand-ins.
- **Tokenized-stock list** is a dated snapshot; refresh server-side.

---

## 12. Phased roadmap

**Phase 0 — Hardening (frontend only)**
Split, type, route, test. No behaviour change. Exit: same UX from modules, CI green.

**Phase 1 — Read-only on-chain**
Indexer + API + WS for tokens, candles, trades, holders, board, tape, King of the Hill. Wallet connect with SIWS/SIWE and real balances. Exit: the board and token pages show real Solana data; trading still simulated with a clear banner.

**Phase 2 — Trading + launch**
Curve program, fee router, graduation, quote endpoint, buy/sell, launch flow (dev buy). Exit: real fair launches and fills; creator fee claims.

**Phase 3 — Game layer**
XP ledger, ranks, streaks, achievements, crates with VRF, $STONKZ settlement, rewards page live. Exit: rank-ups and drops are server-authoritative.

**Phase 4 — Ownership mechanics**
Cashback launches, staking program with locks, pool split, claims. Exit: staking modal and cashback banner reflect chain state.

**Phase 5 — Social**
Profiles, follows, walls with verified tips, chat service, X integration, friends' PnL. Exit: every address link resolves to a real member.

**Phase 6 — Robinhood Chain**
Deploy EVM equivalents; the UI's network picker already branches on `WALLET.net`.

Journeys to Playwright at every phase: land → wizard → connect → buy → sell → rank up; launch (dev buy) → token page; launch (cashback) → banner → 5-minute handoff; stake with lock → claim; visit member → follow → tip → post; open crate → cooldown → reload.

---

## 13. Glossary

- **Bonding curve** — deterministic price-vs-supply function the launchpad sells into before a DEX exists.
- **Graduation** — the curve reaching $69K market cap; liquidity migrates to a DEX and the LP tokens are burned.
- **Cashback launch** — no dev buy; a 5-minute decaying fee (50% → set fee) that is spent buying the token for the creator.
- **King of the Hill** — the highest-market-cap coin that has not yet graduated.
- **Stonkdrop** — a reward crate on a cooldown, paying $STONKZ or an item by published odds.
- **Stake weight** — staked amount × lock multiplier, the share used to split the staking pool.
- **Wall / shoutbox** — a member's public message board; posting requires a tip to that member.
- **XP / rank** — progression points and the ten named levels they unlock.
