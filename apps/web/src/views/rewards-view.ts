import {
  ACH,
  CRATES,
  HOUR,
  RANKS,
  SP_LEVELS,
  type AchievementKey,
  type CrateProof,
  type CrateTier,
  type DropLogEntry,
  type RwaReward,
  type UserItem,
  crateBy,
  crateRollFromDigest,
  crateRollMessage,
  num,
  rankOf,
  rollDrop,
  usd,
} from '@stonkz/shared';
import { DOT, MID, cdText, clock, fmtUnits } from '../lib/fmt.js';
import { type Html, attr, html } from '../lib/html.js';

/**
 * The rewards page's pure renderers.
 *
 * Everything here takes an explicit {@link RewardsModel} and returns markup,
 * so the loading / guest / empty / populated states are unit-testable
 * without a DOM (the same pattern as `modals/stake-view.ts`). `rewards.ts`
 * builds the model from `state/user.ts` and wires the events.
 *
 * Information hierarchy, top to bottom: SP → level ladder → crates →
 * balances (with the on-chain claim state) → items → referral →
 * achievements → drop history with roll proofs.
 */

export interface LadderRow {
  level: number;
  sp: number;
  grants: Partial<Record<CrateTier, number>>;
  claimed: boolean;
  reached: boolean;
}

export interface RewardsModel {
  live: boolean;
  /** Live mode, wallet connected, `GET /rewards` not back yet. */
  loading: boolean;
  connected: boolean;
  xp: number;
  sp: number;
  stonkz: number;
  rwa: RwaReward[];
  /** `undefined` = never priced, `null` = priced but the oracle was down. */
  rwaUsd: number | null | undefined;
  streak: number;
  spLevel:
    | {
        level: number;
        next: number | null;
        pct: number;
        toNext: number;
        cur?: number;
        claimed?: number[];
      }
    | undefined;
  ladder: LadderRow[];
  items: UserItem[];
  /** Null until the API has said whether claims are open. */
  claims: { open: boolean } | null;
  nextCommit: string | null;
  log: DropLogEntry[];
  ach: Partial<Record<AchievementKey, number>>;
  /** Global crate cooldown end, 0 when clear. */
  readyAt: number;
  inventory: Partial<Record<CrateTier, number>>;
  now: number;
}

/** The shipped ladder as {@link LadderRow}s for sim mode / before hydrate. */
export function defaultLadder(sp: number, claimed: readonly number[] = []): LadderRow[] {
  const set = new Set(claimed);
  return SP_LEVELS.map((l) => ({
    level: l.level,
    sp: l.sp,
    grants: { ...l.grants },
    claimed: set.has(l.level) || (claimed.length === 0 && sp >= l.sp),
    reached: sp >= l.sp,
  }));
}

/* ------------------------------------------------------------ crate status */

export interface CrateStatus {
  /** Openable right now. */
  ready: boolean;
  /** Cooling: ms left, else 0. */
  left: number;
  inventory: number;
  /** Short label for the grid card. */
  label: string;
  /** Sentence for the pane. */
  reason: string;
  /** Button caption. */
  button: string;
}

export function crateStatus(
  tier: CrateTier,
  inventory: number,
  readyAt: number,
  now: number,
): CrateStatus {
  const left = Math.max(0, readyAt - now);
  const ready = left <= 0 && inventory > 0;
  if (ready) {
    return {
      ready,
      left,
      inventory,
      label: 'READY',
      reason: `READY ${DOT} ${inventory} IN INVENTORY`,
      button: 'OPEN ' + tier + ' CRATE',
    };
  }
  if (left > 0) {
    const t = cdText(left);
    return {
      ready,
      left,
      inventory,
      label: t,
      reason:
        inventory > 0
          ? `GLOBAL LOCK ${t} ${DOT} OPENING ANY CRATE LOCKS ALL`
          : `GLOBAL LOCK ${t} ${DOT} NO ${tier} IN INVENTORY`,
      button: 'LOCKED ' + DOT + ' ' + t,
    };
  }
  return {
    ready,
    left,
    inventory,
    label: 'EARN VIA SP',
    reason: `NO ${tier} INVENTORY ${DOT} LEVEL UP TO EARN ONE`,
    button: 'NEED INVENTORY',
  };
}

/** Fraction of the cooldown elapsed, floored at 2% so the bar is visible. */
export function cooldownPct(cdHours: number, readyAt: number, now: number): number {
  const left = readyAt - now;
  if (left <= 0) return 100;
  return Math.max(2, Math.min(100, (1 - left / (cdHours * HOUR)) * 100));
}

/* ------------------------------------------------------------------- strip */

/** One line under the SP figure: level, distance to the next grant, or how to start. */
export function spSubline(
  m: Pick<RewardsModel, 'spLevel' | 'live' | 'connected' | 'loading'>,
): string {
  if (m.loading) return 'LOADING…';
  if (m.live && !m.connected) return `CONNECT A WALLET ${DOT} SP UNLOCKS CRATES`;
  const lv = m.spLevel;
  if (!lv) return `TRADE TO EARN SP ${DOT} SP UNLOCKS CRATES`;
  if (lv.next === null) return `SP LV ${lv.level} ${DOT} MAX`;
  return `SP LV ${lv.level} ${DOT} ${num(lv.toNext)} SP TO NEXT CRATE GRANT`;
}

export function stripHTML(m: RewardsModel): Html {
  const r = rankOf(m.xp);
  const marks: Html[] = [];
  for (let i = 1; i < 4; i++)
    marks.push(html`<span class="mk" style="left:${attr(i * 25)}%"></span>`);
  const streak = Math.max(1, m.streak || 1);
  return html`<div class="rw-strip">
    <div class="rw-badge">
      <span class="lv">${r.i + 1}</span>
      <div>
        <h1 id="rw-name">${r.name}</h1>
        <div class="sub" id="rw-sub">
          RANK ${r.i + 1} OF ${RANKS.length} ${DOT} XP FROM EVERY TRADE
        </div>
      </div>
    </div>
    <div class="rw-prog">
      <div
        class="rw-track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="${attr(r.pct.toFixed(0))}"
      >
        <i id="rw-fill" style="width:${attr(r.pct.toFixed(1))}%"></i>${marks}
      </div>
      <div class="rw-legend">
        <span id="rw-cur">${num(m.xp)} XP TOTAL</span
        ><span id="rw-next" class="am">${nextRankText(m.xp)}</span>
      </div>
    </div>
    <div class="rw-bal">
      <span class="lbl">STREAK</span>
      <div class="v" id="rw-streak">${streak} DAY${streak === 1 ? '' : 'S'}</div>
      <span class="hint" id="rw-mult"
        >XP ×${(1 + Math.min(6, streak - 1) * 0.05).toFixed(2)} ${DOT} SHOW UP DAILY</span
      >
    </div>
  </div>`;
}

export function nextRankText(xp: number): string {
  const r = rankOf(xp);
  return r.next === null
    ? 'MAX RANK'
    : num(r.toNext) + ' XP TO ' + (RANKS[r.i + 1] as (typeof RANKS)[number])[0];
}

/* ------------------------------------------------------------------- level */

function grantsText(grants: Partial<Record<CrateTier, number>>): Html[] {
  const out: Html[] = [];
  for (const c of CRATES) {
    const n = grants[c.k];
    if (n && n > 0)
      out.push(html`<span class="lvl-chip" style="color:${attr(c.col)}">${c.k} ×${n}</span>`);
  }
  return out.length ? out : [html`<span class="lvl-chip dm">${MID}</span>`];
}

export function levelPanelHTML(m: RewardsModel): Html {
  return html`<section class="pnl lvl-pnl" id="levelPanel">${levelPanelBodyHTML(m)}</section>`;
}

/** The section's contents alone, so a live update can repaint in place and keep the wrapper's id. */
export function levelPanelBodyHTML(m: RewardsModel): Html {
  const lv = m.spLevel;
  const ladder = m.ladder;
  const next = lv && lv.next !== null ? ladder.find((l) => l.sp === lv.next) : undefined;
  const pct = lv ? lv.pct : 0;
  const claimedCount = ladder.filter((l) => l.claimed).length;
  const empty = m.live && !m.connected;
  return html`<div class="pnl-hd">
      <h2>Stonk Pointz</h2>
      <span class="sub" id="lvl-hd-sub"
        >${
          m.loading
            ? 'LOADING…'
            : empty
              ? 'CONNECT TO SEE YOUR LEVEL'
              : `LEVEL ${lv?.level ?? 1} OF ${ladder.length} ${DOT} ${claimedCount} GRANTED`
        }</span
      >
    </div>
    <div class="pnl-bd">
      <div class="lvl-row">
        <div class="lvl-big">
          <span class="lbl">SP</span>
          <div class="v" id="rw-sp">${m.loading ? MID : num(m.sp)}</div>
          <span class="hint" id="rw-ready">${spSubline(m)}</span>
        </div>
        <div class="lvl-prog">
          <div class="lvl-legend">
            <span>LV ${lv?.level ?? 1}</span
            ><span class="am"
              >${
                lv && lv.next !== null
                  ? `${num(lv.toNext)} SP TO LV ${lv.level + 1}`
                  : lv
                    ? 'MAX LEVEL'
                    : `${num(SP_LEVELS[1]?.sp ?? 250)} SP TO LV 2`
              }</span
            >
          </div>
          <div
            class="rw-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="${attr(pct.toFixed(0))}"
          >
            <i id="lvl-fill" style="width:${attr(pct.toFixed(1))}%"></i>
          </div>
          <div class="lvl-next">
            <span class="lbl">NEXT GRANT</span>
            ${next ? grantsText(next.grants) : html`<span class="lvl-chip dm">EVERY TIER UNLOCKED</span>`}
          </div>
        </div>
      </div>
      <div class="lvl-ladder" id="lvlLadder" aria-label="SP level ladder">
        ${ladder.map(
          (l) =>
            html`<div
              class="lvl-step${l.claimed ? ' done' : l.reached ? ' due' : ''}${lv && l.level === lv.level ? ' cur' : ''}"
              title="LV ${l.level} ${DOT} ${num(l.sp)} SP"
            >
              <b>${l.level}</b>
              <span>${l.sp >= 1000 ? (l.sp / 1000).toFixed(l.sp % 1000 ? 1 : 0) + 'K' : l.sp}</span>
              <div class="lvl-tip">
                <span class="lbl">LV ${l.level} ${DOT} ${num(l.sp)} SP</span>
                ${grantsText(l.grants)}
                <span class="hint"
                  >${l.claimed ? 'GRANTED' : l.reached ? 'GRANTING…' : 'LOCKED'}</span
                >
              </div>
            </div>`,
        )}
      </div>
      <p class="hint">
        SP MIRRORS XP FROM EVERY VERIFIED ACTION (PLUS 5% OF YOUR REFERRALS&#8217; SP). CROSSING A
        LEVEL DROPS ITS CRATES STRAIGHT INTO INVENTORY ${DOT} NOTHING TO CLAIM, NOTHING TO LOSE.
      </p>
    </div>`;
}

/* ---------------------------------------------------------------- balances */

export function rwaLine(rwa: RwaReward[]): string {
  const held = rwa.filter((r) => r.units > 0);
  return held.length
    ? held.map((r) => fmtUnits(r.units) + ' ' + r.asset).join(' ' + DOT + ' ')
    : MID;
}

export function claimsChipHTML(claims: RewardsModel['claims'], live: boolean): Html {
  if (!live) return html`<span class="claim-chip sim">SIMULATED ${DOT} NOTHING TO CLAIM</span>`;
  if (claims?.open)
    return html`<button type="button" class="send" id="claimBtn">CLAIM ON CHAIN</button>`;
  return html`<span
    class="claim-chip soon"
    title="Signed vouchers → on-chain rewards vault. See docs/rewards-claims-design.md"
    >CLAIMS OPEN SOON</span
  >`;
}

/** `$15.12` under a thousand, the board's `$4.5K` / `$1.20M` above. */
export function usdFine(v: number): string {
  return v < 1000 ? '$' + v.toFixed(2) : usd(v);
}

export function balancesHTML(m: RewardsModel): Html {
  return html`<section class="pnl bal-pnl" id="balancesPanel">${balancesBodyHTML(m)}</section>`;
}

export function balancesBodyHTML(m: RewardsModel): Html {
  const held = m.rwa.filter((r) => r.units > 0);
  const usdText =
    m.rwaUsd === undefined || held.length === 0
      ? ''
      : m.rwaUsd === null
        ? `USD ${MID} (PRICE FEED DOWN)`
        : `≈ ${usdFine(m.rwaUsd)}`;
  return html`<div class="pnl-hd">
      <h2>Balances</h2>
      <span class="sub">REWARD CREDITS ${DOT} OFF-CHAIN UNTIL CLAIMS OPEN</span>
    </div>
    <div class="pnl-bd">
      <div class="bal-grid">
        <div class="bal">
          <span class="lbl">$STONKZ CREDITS</span>
          <div class="v gd" id="rw-stonkz">${m.loading ? MID : num(m.stonkz)}</div>
          <span class="hint">FROM CRATE DROPS AND REFERRAL FEE CLAIMS</span>
          ${claimsChipHTML(m.claims, m.live)}
        </div>
        <div class="bal">
          <span class="lbl">RWA HOLDINGS</span>
          <div class="v rw" id="rw-rwa">${m.loading ? MID : rwaLine(m.rwa)}</div>
          <span class="hint" id="rw-rwa-usd"
            >${usdText || `FROM SILVER+ CRATES ${DOT} FUNDED BY THE 6% RWA LEG`}</span
          >
          ${claimsChipHTML(m.claims, m.live)}
        </div>
      </div>
      <p class="hint">
        CREDITS ARE LEDGER BALANCES TODAY. WHEN CLAIMS OPEN, THE API WILL SIGN A VOUCHER FOR YOUR
        BALANCE AND THE REWARDS VAULT WILL PAY IT OUT ON CHAIN ${DOT} NO PRIVATE KEY EVER LEAVES
        YOUR WALLET.
      </p>
    </div>`;
}

/* ------------------------------------------------------------------- items */

export function itemsHTML(m: RewardsModel): Html {
  return html`<section class="pnl item-pnl" id="itemsPanel">${itemsBodyHTML(m)}</section>`;
}

export function itemsBodyHTML(m: RewardsModel): Html {
  const items = m.items.filter((i) => i.count > 0);
  const rows = items.map((i) => {
    const active = i.expiresAt === null || i.expiresAt > m.now;
    const left = i.expiresAt === null ? null : i.expiresAt - m.now;
    const state = !active
      ? 'EXPIRED'
      : i.implemented === false
        ? 'HELD ' + DOT + ' NOT LIVE YET'
        : left === null
          ? 'READY'
          : cdText(left) + ' LEFT';
    return html`<div class="item${active ? '' : ' off'}${i.implemented === false ? ' na' : ''}">
      <div class="in">${i.item}<span class="hint"> ×${i.count}</span></div>
      <div class="is">${state}</div>
      ${i.blurb ? html`<div class="ib hint">${i.blurb}</div>` : ''}
    </div>`;
  });
  return html`<div class="pnl-hd">
      <h2>Items</h2>
      <span class="sub">${items.length} HELD ${DOT} FROM LEGENDARY DROPS</span>
    </div>
    <div class="pnl-bd">
      ${
        rows.length
          ? html`<div class="item-grid">${rows}</div>`
          : html`<p class="hint">
              NO ITEMS YET ${DOT} EVERY TIER&#8217;S LEGENDARY ROW IS A PERK.
            </p>`
      }
    </div>`;
}

/* ------------------------------------------------------------ achievements */

export function achHTML(ach: RewardsModel['ach'], now: number = Date.now()): Html {
  return html`<div class="ach-grid">
    ${ACH.map((a) => {
      const at = ach[a.k];
      const done = !!at;
      return html`<div class="ach${done ? ' done' : ' locked'}" data-ach="${attr(a.k)}">
        <div class="an">${a.n}</div>
        <div class="ad">${a.d}</div>
        <div class="ax">
          ${done ? 'UNLOCKED ' + DOT + ' ' + unlockedWhen(at as number, now) : '+' + a.xp + ' XP'}
        </div>
        <i class="mark"></i>
      </div>`;
    })}
  </div>`;
}

/** `TODAY 09:14`, `3D AGO`, or the date for older unlocks. */
export function unlockedWhen(at: number, now: number): string {
  const d = new Date(at);
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0 && now - at < 86_400_000) return 'TODAY ' + clock(d);
  if (days < 7) return days + 'D AGO';
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- drop log */

export function dropLogHTML(m: RewardsModel): Html {
  if (m.loading) {
    return html`<table class="tbl dlog">
      <tbody>
        <tr>
          <td class="dm">LOADING…</td>
        </tr>
      </tbody>
    </table>`;
  }
  return html`<div class="scrolly">
    <table class="tbl dlog">
      <thead>
        <tr>
          <th scope="col">TIME</th>
          <th scope="col">CRATE</th>
          <th scope="col">REWARD</th>
          <th scope="col" class="r">ROLL</th>
        </tr>
      </thead>
      <tbody>
        ${
          m.log.length
            ? m.log.map(
                (l, i) =>
                  html`<tr data-row="${attr(i)}">
                      <td class="dm">${l.t}</td>
                      <td style="color:${attr(l.col)}">
                        ${l.k}${l.rarity ? html`<span class="hint"> ${DOT} ${l.rarity}</span>` : ''}
                      </td>
                      <td class="gd">${l.r}</td>
                      <td class="r">${proofCellHTML(l.proof, i)}</td>
                    </tr>
                    ${
                      l.proof
                        ? html`<tr class="proof-row" id="proof-${attr(i)}" hidden>
                            <td colspan="4">${proofDetailHTML(l.proof)}</td>
                          </tr>`
                        : ''
                    }`,
              )
            : html`<tr>
                <td colspan="4" class="dm">NO DROPS YET ${DOT} OPEN A CRATE</td>
              </tr>`
        }
      </tbody>
    </table>
    ${
      m.nextCommit
        ? html`<p class="hint commit">
            NEXT OPEN COMMITTED ${DOT} <code>${m.nextCommit.slice(0, 16)}…</code> ${DOT} THE SERVER
            SEED HASH IS FIXED BEFORE YOU PICK YOUR SEED.
          </p>`
        : ''
    }
  </div>`;
}

function proofCellHTML(proof: CrateProof | undefined, i: number): Html {
  if (!proof) return html`<span class="dm">${MID}</span>`;
  if (proof.serverSeed === null)
    return html`<span class="dm" title="Opened before commit–reveal shipped">LEGACY</span>`;
  return html`<button type="button" class="proof-btn" data-proof="${attr(i)}" aria-expanded="false">
    ${proof.rollValue.toFixed(2)} ${DOT} PROOF
  </button>`;
}

function proofDetailHTML(p: CrateProof): Html {
  return html`<div class="proof">
    <div>
      <span class="lbl">SEED HASH (SHOWN BEFORE OPEN)</span><code>${p.serverSeedHash}</code>
    </div>
    <div><span class="lbl">SERVER SEED (REVEALED)</span><code>${p.serverSeed ?? MID}</code></div>
    <div><span class="lbl">YOUR SEED</span><code>${p.clientSeed ?? MID}</code></div>
    <div><span class="lbl">HMAC DIGEST</span><code>${p.rollCommit}</code></div>
    <div>
      <span class="lbl">DRAWS</span
      ><code
        >roll ${p.rollValue.toFixed(6)} / 100 ${DOT} amount ${p.amountRoll.toFixed(6)} ${DOT} row
        ${p.dropIndex}</code
      >
    </div>
    <div class="proof-actions">
      <button type="button" class="send" data-verify>VERIFY IN BROWSER</button>
      <button type="button" class="send" data-copy>COPY PROOF</button>
      <span class="hint" data-verdict></span>
    </div>
    <p class="hint">
      digest = HMAC-SHA256(serverSeed, net|wallet|tier|yourSeed) ${DOT} roll = first 8 bytes / 2⁶⁴ ×
      100 ${DOT} sha256(serverSeed) must equal the hash you were shown first.
    </p>
  </div>`;
}

/* ------------------------------------------------------------------ verify */

export interface ProofVerdict {
  ok: boolean;
  /** Which check failed, if any. */
  failed: 'seed_hash' | 'digest' | 'draws' | 'drop' | 'unverifiable' | null;
  recomputedRoll: number | null;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Re-derive a crate roll in the browser with WebCrypto. Checks, in order: the
 * revealed seed hashes to the pre-published commitment, the HMAC digest
 * matches, the draws map from the digest, and the drop row follows from the
 * roll against the shipped odds table.
 */
export async function verifyCrateProof(
  p: CrateProof,
  ctx: { net: string; wallet: string; tier: CrateTier },
  subtle: SubtleCrypto = crypto.subtle,
): Promise<ProofVerdict> {
  if (p.serverSeed === null || p.clientSeed === null)
    return { ok: false, failed: 'unverifiable', recomputedRoll: null };
  const seedHash = hex(await subtle.digest('SHA-256', enc.encode(p.serverSeed)));
  if (seedHash !== p.serverSeedHash)
    return { ok: false, failed: 'seed_hash', recomputedRoll: null };
  const key = await subtle.importKey(
    'raw',
    enc.encode(p.serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await subtle.sign(
    'HMAC',
    key,
    enc.encode(crateRollMessage(ctx.net, ctx.wallet, ctx.tier, p.clientSeed)),
  );
  if (hex(digest) !== p.rollCommit) return { ok: false, failed: 'digest', recomputedRoll: null };
  const draws = crateRollFromDigest(new Uint8Array(digest));
  if (
    Math.abs(draws.rollValue - p.rollValue) > 1e-6 ||
    Math.abs(draws.amountRoll - p.amountRoll) > 1e-9
  )
    return { ok: false, failed: 'draws', recomputedRoll: draws.rollValue };
  const crate = crateBy(ctx.tier);
  if (crate && rollDrop(crate, () => draws.rollValue / 100) !== p.dropIndex)
    return { ok: false, failed: 'drop', recomputedRoll: draws.rollValue };
  return { ok: true, failed: null, recomputedRoll: draws.rollValue };
}

/** Human line for a verdict. */
export function verdictText(v: ProofVerdict): string {
  if (v.ok) return 'VERIFIED ' + DOT + ' ROLL ' + (v.recomputedRoll ?? 0).toFixed(6);
  switch (v.failed) {
    case 'unverifiable':
      return 'NOT VERIFIABLE ' + DOT + ' OPENED BEFORE COMMIT-REVEAL';
    case 'seed_hash':
      return 'MISMATCH ' + DOT + ' SEED DOES NOT HASH TO THE COMMITMENT';
    case 'digest':
      return 'MISMATCH ' + DOT + ' HMAC DIGEST DIFFERS';
    case 'draws':
      return 'MISMATCH ' + DOT + ' DRAWS DIFFER FROM DIGEST';
    case 'drop':
      return 'MISMATCH ' + DOT + ' ROW DOES NOT FOLLOW FROM ROLL';
    default:
      return 'MISMATCH';
  }
}

/** Rarity label from a drop index, for the reveal card. */
export function rarityOf(dropIndex: number): string {
  return (['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'][dropIndex] ?? 'COMMON') as string;
}
