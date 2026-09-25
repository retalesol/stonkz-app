# Phase 5 social layer — OG rewrites, tip flow, and hybrid live/sim scope

Working notes for decisions made in Phase 5 (social profiles, follows, walls,
tips, chat, X cache, OG tags, legal disclosure) that need a human's eyes
before they go further, plus the reasoning behind a few judgment calls.

## OG crawler rewrites (`apps/web/vercel.json`)

`apps/web` is a pure Vite SPA with no server-rendering, so a social crawler
hitting `https://ston.kz/t/SYM` or `https://ston.kz/u/ADDR` directly gets the
same `index.html` shell every browser gets — no `og:title`/`og:description`
reflects the coin or the member. `apps/api/src/routes/og.ts`'s
`GET /og/t/:sym` and `GET /og/u/:net/:addr` are the server-rendered stand-in a
crawler should see instead; `apps/web/vercel.json` rewrites known bot user
agents on those two paths to the API host.

**Known gap: `/u/:addr` carries no net segment.** `app/route.ts`'s profile
route is `/u/:addr` — it was never `/u/:net/:addr` — because sim-mode profiles
never needed to disambiguate a chain. `GET /og/u/:net/:addr` does need one, so
the rewrite in `vercel.json` hardcodes `SOL`. A Robinhood-chain member's
shared profile link will therefore render Solana's (usually empty) profile
data in the OG tags until one of two things happens: the frontend route grows
a net segment (a breaking URL change, so a redirect from the old path is
worth planning), or the OG route is taught to try both nets and prefer
whichever has a `users` row. Flagging rather than guessing since either fix
changes a URL contract this doc cannot make unilaterally.

**Not deployed or verified against a live Vercel project** — there is no
Vercel account wired to this repo in this environment. The rewrite rule's
`has.value` regex is copied from the common set of social-media crawler user
agents; verify against Vercel's own bot rewrite docs before relying on it in
production, and confirm the destination host (`api.ston.kz`) matches whatever
`PUBLIC_WEB_ORIGIN`/API deployment is actually live.

## Tip flow: a real broadcast attempt, not a fabricated signature

`apps/api/src/social/tips.ts`'s `verifyTip` only ever accepts a real,
confirmed on-chain transfer — it re-derives the sender, recipient and amount
from `ChainRpc.getNativeTransfer`, never from the request body. That means a
client can never _fake_ a tip regardless of what the frontend does.

The frontend (`apps/web/src/app/tip.ts`) makes an honest choice given that:
it uses `@solana/web3.js` to build, sign (with the practice keypair) and
actually broadcast a native SOL transfer to a real RPC, then calls
`POST /wall/:net/:addr` with whatever signature comes back. This will always
fail — the practice key (`app/keys.ts`) is never funded, matching the
existing `app/signer.ts` honesty tradeoff for trade/launch/claim — but it
fails for the _real_ reason (a real RPC refusing a real, unfunded transfer),
surfaced as a clear toast, rather than a fabricated signature that would just
bounce off `verifyTip` as "not found" for an unrelated reason. Robinhood
Chain has no wallet-adapter or RPC-signing path in this build at all, so its
tip flow reports "needs a funded wallet" without attempting anything.

**This only becomes a real tip once a real, funded wallet-adapter connection
exists** (Phase 1.B's outstanding `TODO` in `app/wallet.ts`). Until then, the
wall's tip button is real infrastructure with no funded sender — exercised
end to end in `e2e/live.spec.ts`'s "tipping on a wall..." test, which mocks
the RPC response only for determinism (a real mainnet RPC would refuse the
same transfer for the same underlying reason, just slower).

## Hybrid scope: live actions on sim-rendered profile pages

`views/profile.ts` still renders another member's profile (bio, avatar,
holdings, wall backscroll, friends) from `state/social.ts`'s deterministic sim
generators in _every_ mode — `GET /users/:net/:addr` and `GET /wall/:net/:addr`
exist and are tested (`routes/social.test.ts`) but nothing in the frontend
calls them yet. Only the _write_ actions are live-gated on `api.mode ===
'live'`: follow/unfollow (`POST`/`DELETE /follow/:net/:addr`), the wall's
tip-and-post (`POST /wall/:net/:addr`), and `PATCH /me` from the edit modal.

This means, today, the "profile" a live-mode user sees for someone else is
still simulated flavour text — but liking, following or tipping that address
for real works, verified by the real server. Wiring the two `GET` reads into
`renderProfile` for live mode is the natural next slice; it was left out of
this pass to keep the change surface for follow/tip/chat reviewable on its
own, and because `state/social.ts`'s sim addresses (`fakeAddr()`, an `XXXX..
YYYY` shorthand, not a real base58 pubkey or a real derived wallet) are not
valid tip targets in live mode regardless — a real fix needs live-derived
addresses on both sides (holders, trades, friends), which is a larger, related
piece of work than the read-wiring alone.

## Legal disclosure: footer link, not a first-visit gate

`apps/web/index.html` gained a `#legalScrim` dialog (placeholder risk/legal
copy, explicitly marked as not legal advice) reachable from a new footer
button. An earlier version of this also auto-opened it once per device on
first boot; that was reverted after it broke 12 of `journeys.spec.ts`' and
`shell.spec.ts`'s 14 sim-mode e2e tests by stacking a focus-trapped dialog on
top of the existing "hello card" boot sequence and intercepting pointer
events across the whole board. `USER.seenLegal` (added to `packages/shared`'s
`User` type) is still there, unused, for whoever wants to build a real
first-visit gate later — it would need to coordinate with the hello card
rather than stack blindly on top of it.
