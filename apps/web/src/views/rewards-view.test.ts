import { createHash, createHmac, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CRATES, SP_LEVELS, crateRollFromDigest, crateRollMessage, rollDrop } from '@stonkz/shared';
import type { CrateProof } from '@stonkz/shared';
import {
  type RewardsModel,
  achHTML,
  balancesHTML,
  cooldownPct,
  crateStatus,
  defaultLadder,
  dropLogHTML,
  itemsHTML,
  levelPanelHTML,
  spSubline,
  stripHTML,
  unlockedWhen,
  verdictText,
  verifyCrateProof,
} from './rewards-view.js';

/**
 * The rewards page's states, rendered without a DOM: loading, guest, empty,
 * populated, on-cooldown, and the in-browser proof check.
 */

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const HOUR = 3_600_000;

function base(over: Partial<RewardsModel> = {}): RewardsModel {
  return {
    live: true,
    loading: false,
    connected: true,
    xp: 0,
    sp: 0,
    stonkz: 0,
    rwa: [],
    rwaUsd: undefined,
    streak: 1,
    spLevel: { level: 1, next: 250, pct: 0, toNext: 250, cur: 0, claimed: [1] },
    ladder: defaultLadder(0, [1]),
    items: [],
    claims: { open: false },
    nextCommit: null,
    log: [],
    ach: {},
    readyAt: 0,
    inventory: { BRONZE: 2 },
    now: NOW,
    ...over,
  };
}

const flat = (h: { value: string }): string => h.value.replace(/\s+/g, ' ');

describe('crate status', () => {
  it('is READY with inventory and no cooldown', () => {
    const st = crateStatus('BRONZE', 2, 0, NOW);
    expect(st).toMatchObject({ ready: true, left: 0, label: 'READY', button: 'OPEN BRONZE CRATE' });
    expect(st.reason).toContain('2 IN INVENTORY');
  });

  it('shows the countdown while the global lock runs, whatever the inventory', () => {
    const st = crateStatus('GOLD', 1, NOW + 90 * 60_000, NOW);
    expect(st.ready).toBe(false);
    expect(st.label).toBe('1h 30m');
    expect(st.reason).toContain('GLOBAL LOCK 1h 30m');
    expect(st.button).toBe('LOCKED · 1h 30m');
    const none = crateStatus('GOLD', 0, NOW + 90 * 60_000, NOW);
    expect(none.reason).toContain('NO GOLD IN INVENTORY');
  });

  it('points at SP levels when there is nothing to open', () => {
    const st = crateStatus('RHODIUM', 0, 0, NOW);
    expect(st).toMatchObject({ ready: false, label: 'EARN VIA SP', button: 'NEED INVENTORY' });
    expect(st.reason).toContain('LEVEL UP TO EARN ONE');
  });

  it('cooldown bar fills from 2% to 100%', () => {
    expect(cooldownPct(1, NOW + HOUR, NOW)).toBe(2);
    expect(cooldownPct(1, NOW + HOUR / 2, NOW)).toBeCloseTo(50);
    expect(cooldownPct(1, NOW - 1, NOW)).toBe(100);
  });
});

describe('SP subline', () => {
  it('walks loading → guest → empty → progressing → max', () => {
    expect(spSubline(base({ loading: true }))).toBe('LOADING…');
    expect(spSubline(base({ connected: false }))).toContain('CONNECT A WALLET');
    expect(spSubline(base({ spLevel: undefined }))).toContain('TRADE TO EARN SP');
    expect(spSubline(base({ spLevel: { level: 4, next: 3500, pct: 28, toNext: 1660 } }))).toBe(
      'SP LV 4 · 1,660 SP TO NEXT CRATE GRANT',
    );
    expect(spSubline(base({ spLevel: { level: 20, next: null, pct: 100, toNext: 0 } }))).toBe(
      'SP LV 20 · MAX',
    );
  });
});

describe('level panel', () => {
  it('renders the ladder with claimed / current / locked markers and the next grant', () => {
    const m = base({
      sp: 1_000,
      spLevel: { level: 3, next: 1_800, pct: 23.8, toNext: 800, cur: 750, claimed: [1, 2, 3] },
      ladder: defaultLadder(1_000, [1, 2, 3]),
    });
    const out = flat(levelPanelHTML(m));
    expect(out).toContain('LEVEL 3 OF 20');
    expect(out).toContain('3 GRANTED');
    expect(out).toContain('800 SP TO LV 4');
    expect(out).toContain('IRON ×2'); // L4's grant preview
    expect((out.match(/lvl-step done/g) ?? []).length).toBe(3);
    expect(out).toMatch(/lvl-step done cur/);
    expect((out.match(/class="lvl-step"/g) ?? []).length).toBe(SP_LEVELS.length - 3);
  });

  it('shows a level that is reached but not yet granted as due', () => {
    const ladder = defaultLadder(250, [1]);
    const out = flat(levelPanelHTML(base({ sp: 250, ladder })));
    expect(out).toContain('lvl-step due');
    expect(out).toContain('GRANTING…');
  });

  it('says MAX LEVEL and EVERY TIER UNLOCKED at the top', () => {
    const m = base({
      sp: 250_000,
      spLevel: { level: 20, next: null, pct: 100, toNext: 0 },
      ladder: defaultLadder(
        250_000,
        SP_LEVELS.map((l) => l.level),
      ),
    });
    const out = flat(levelPanelHTML(m));
    expect(out).toContain('MAX LEVEL');
    expect(out).toContain('EVERY TIER UNLOCKED');
  });

  it('shows the loading and guest states', () => {
    expect(flat(levelPanelHTML(base({ loading: true })))).toContain('LOADING…');
    expect(flat(levelPanelHTML(base({ connected: false })))).toContain('CONNECT TO SEE YOUR LEVEL');
  });
});

describe('balances', () => {
  it('shows CLAIMS OPEN SOON instead of a dead button while claims are closed', () => {
    const out = flat(balancesHTML(base({ stonkz: 12_340 })));
    expect(out).toContain('12,340');
    expect(out).toContain('CLAIMS OPEN SOON');
    expect(out).not.toContain('id="claimBtn"');
  });

  it('renders a claim button only when the API says claims are open', () => {
    expect(flat(balancesHTML(base({ claims: { open: true } })))).toContain('id="claimBtn"');
  });

  it('prices RWA holdings in USD and degrades when the feed is down', () => {
    const rwa = [{ asset: 'PAXG', units: 0.0042 }];
    expect(flat(balancesHTML(base({ rwa, rwaUsd: 15.12 })))).toContain('≈ $15.12');
    expect(flat(balancesHTML(base({ rwa, rwaUsd: null })))).toContain('PRICE FEED DOWN');
    expect(flat(balancesHTML(base({ rwa, rwaUsd: undefined })))).toContain('FROM SILVER+ CRATES');
    expect(flat(balancesHTML(base({ rwa })))).toContain('0.0042 PAXG');
  });

  it('marks the sim mode as nothing to claim', () => {
    expect(flat(balancesHTML(base({ live: false })))).toContain('SIMULATED · NOTHING TO CLAIM');
  });
});

describe('items', () => {
  it('lists held items with their live / not-live / expired state', () => {
    const out = flat(
      itemsHTML(
        base({
          items: [
            { item: 'XP BOOST 2X 1H', count: 1, expiresAt: NOW + 30 * 60_000, implemented: true },
            { item: 'FEE REBATE 24H', count: 1, expiresAt: NOW + HOUR, implemented: false },
            { item: 'SNIPER ALERT PASS 7D', count: 1, expiresAt: NOW - 1, implemented: false },
            { item: 'RHODIUM KEY · INSTANT CRATE', count: 2, expiresAt: null, implemented: true },
          ],
        }),
      ),
    );
    expect(out).toContain('4 HELD');
    expect(out).toContain('30m 00s LEFT');
    expect(out).toContain('HELD · NOT LIVE YET');
    expect(out).toContain('EXPIRED');
    expect(out).toContain('READY');
    expect(out).toContain('×2');
  });

  it('has an empty state', () => {
    expect(flat(itemsHTML(base()))).toContain('NO ITEMS YET');
  });
});

describe('achievements', () => {
  it('shows the unlock time on unlocked entries and the XP on locked ones', () => {
    const out = flat(achHTML({ first: NOW - 60_000, whale: NOW - 3 * 86_400_000 }, NOW));
    expect(out).toContain('UNLOCKED · TODAY');
    expect(out).toContain('UNLOCKED · 3D AGO');
    expect(out).toContain('+100 XP'); // deploy, locked
    expect((out.match(/ach done/g) ?? []).length).toBe(2);
  });

  it('formats unlock recency', () => {
    expect(unlockedWhen(NOW - 1000, NOW)).toMatch(/^TODAY /);
    expect(unlockedWhen(NOW - 2 * 86_400_000, NOW)).toBe('2D AGO');
    expect(unlockedWhen(NOW - 30 * 86_400_000, NOW)).toBe('2026-08-30');
  });
});

/* ------------------------------------------------------------- proofs */

function makeProof(clientSeed: string, tier: 'BRONZE' | 'GOLD' = 'BRONZE'): CrateProof {
  const serverSeed = 'ab'.repeat(32);
  const digest = createHmac('sha256', serverSeed)
    .update(crateRollMessage('SOL', 'W', tier, clientSeed))
    .digest();
  const draws = crateRollFromDigest(digest);
  const crate = CRATES.find((c) => c.k === tier)!;
  return {
    serverSeedHash: createHash('sha256').update(serverSeed).digest('hex'),
    serverSeed,
    clientSeed,
    rollCommit: digest.toString('hex'),
    rollValue: draws.rollValue,
    amountRoll: draws.amountRoll,
    dropIndex: rollDrop(crate, () => draws.rollValue / 100),
  };
}

describe('drop log', () => {
  it('renders a proof toggle for verifiable rows, LEGACY for old ones, and the next commitment', () => {
    const proof = makeProof('seed-1');
    const legacy: CrateProof = { ...proof, serverSeed: null, clientSeed: null };
    const out = flat(
      dropLogHTML(
        base({
          nextCommit: 'c'.repeat(64),
          log: [
            { t: '09:14', k: 'BRONZE', r: '180 $STONKZ', col: '#c07434', rarity: 'COMMON', proof },
            { t: '08:02', k: 'GOLD', r: '0.02 TSLA', col: '#ffd23f', proof: legacy },
            { t: '07:00', k: 'IRON', r: 'FEE REBATE 24H', col: '#98a4b0' },
          ],
        }),
      ),
    );
    expect(out).toContain('data-proof="0"');
    expect(out).toContain('id="proof-0"');
    expect(out).toContain(proof.serverSeedHash);
    expect(out).toContain('LEGACY');
    expect(out).toContain('NEXT OPEN COMMITTED');
    expect(out).toContain('cccccccccccccccc…');
  });

  it('has empty and loading states', () => {
    expect(flat(dropLogHTML(base()))).toContain('NO DROPS YET');
    expect(flat(dropLogHTML(base({ loading: true })))).toContain('LOADING…');
  });
});

describe('verifyCrateProof (WebCrypto)', () => {
  const subtle = webcrypto.subtle as unknown as SubtleCrypto;
  const ctx = { net: 'SOL', wallet: 'W', tier: 'BRONZE' as const };

  it('accepts a genuine proof', async () => {
    const v = await verifyCrateProof(makeProof('good'), ctx, subtle);
    expect(v.ok).toBe(true);
    expect(verdictText(v)).toMatch(/^VERIFIED/);
  });

  it('rejects a seed that does not hash to the commitment', async () => {
    const p = { ...makeProof('x'), serverSeedHash: 'd'.repeat(64) };
    const v = await verifyCrateProof(p, ctx, subtle);
    expect(v).toMatchObject({ ok: false, failed: 'seed_hash' });
  });

  it('rejects a tampered digest, draws or drop row', async () => {
    const p = makeProof('y');
    expect((await verifyCrateProof({ ...p, rollCommit: 'e'.repeat(64) }, ctx, subtle)).failed).toBe(
      'digest',
    );
    expect((await verifyCrateProof({ ...p, rollValue: p.rollValue + 1 }, ctx, subtle)).failed).toBe(
      'draws',
    );
    expect(
      (await verifyCrateProof({ ...p, dropIndex: (p.dropIndex + 1) % 5 }, ctx, subtle)).failed,
    ).toBe('drop');
  });

  it('reports a legacy row as unverifiable', async () => {
    const p = { ...makeProof('z'), serverSeed: null, clientSeed: null };
    const v = await verifyCrateProof(p, ctx, subtle);
    expect(v.failed).toBe('unverifiable');
    expect(verdictText(v)).toContain('NOT VERIFIABLE');
  });
});

describe('strip', () => {
  it('shows rank, XP to next, and the streak multiplier', () => {
    const out = flat(stripHTML(base({ xp: 900, streak: 3 })));
    expect(out).toContain('DEGEN');
    expect(out).toContain('900 XP TOTAL');
    expect(out).toContain('600 XP TO TRENCH RAT');
    expect(out).toContain('3 DAYS');
    expect(out).toContain('XP ×1.10');
  });
});
