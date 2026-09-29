import { describe, expect, it } from 'vitest';
import {
  canSeePrivate,
  checkProfilePatch,
  checkUsername,
  walletForms,
  withCostBasis,
  type CostBasis,
} from './profile.js';

/** Pure halves of the profile read model — no database, no app. */

describe('checkUsername', () => {
  it('accepts the documented charset and clears on empty', () => {
    expect(checkUsername('Trench_Rat9')).toEqual({ ok: true, value: 'Trench_Rat9' });
    expect(checkUsername('  ')).toEqual({ ok: true, value: null });
    expect(checkUsername(undefined)).toEqual({ ok: true, value: null });
  });

  it('folds full-width letters to ASCII before the charset check', () => {
    // NFKC turns `Ｍｅｍｅ` into `Meme`; a client cannot dodge the rule with look-alikes.
    expect(checkUsername('Ｍｅｍｅ')).toEqual({ ok: true, value: 'Meme' });
  });

  it('refuses length, charset, all-underscore and reserved names', () => {
    expect(checkUsername('x'.repeat(23)).ok).toBe(false);
    expect(checkUsername('has space').ok).toBe(false);
    expect(checkUsername('émoji🙂').ok).toBe(false);
    expect(checkUsername('<script>').ok).toBe(false);
    expect(checkUsername('___').ok).toBe(false);
    for (const name of ['admin', 'Admin', 'STONKZ', 'support', 'me', 'null', 'Moderator']) {
      const r = checkUsername(name);
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(/reserved/);
    }
  });
});

describe('checkProfilePatch', () => {
  it('normalises every field and reports the first failure by name', () => {
    const ok = checkProfilePatch({
      username: 'Mememan',
      bio: '  gm​  fren \n\n\n\nok ',
      xHandle: 'https://x.com/@degen',
      website: 'ston.kz',
      telegram: '@stonkz_chat',
      private: true,
    });
    expect(ok).toEqual({
      ok: true,
      patch: {
        username: 'Mememan',
        bio: 'gm fren\n\nok',
        xHandle: 'degen',
        website: 'https://ston.kz/',
        telegram: 'https://t.me/stonkz_chat',
        private: true,
      },
    });

    expect(checkProfilePatch({ website: 'javascript:alert(1)' })).toMatchObject({
      ok: false,
      field: 'website',
    });
    expect(checkProfilePatch({ website: 'ftp://x.y' })).toMatchObject({
      ok: false,
      field: 'website',
    });
    expect(checkProfilePatch({ avatarUrl: 'http://insecure.example/a.png' })).toMatchObject({
      ok: false,
      field: 'avatarUrl',
    });
    expect(checkProfilePatch({ xHandle: 'way_too_long_handle_here' })).toMatchObject({
      ok: false,
      field: 'xHandle',
    });
    expect(checkProfilePatch({ telegram: 'https://evil.example/x' })).toMatchObject({
      ok: false,
      field: 'telegram',
    });
    expect(checkProfilePatch({ private: 'yes' })).toMatchObject({ ok: false, field: 'private' });
    expect(checkProfilePatch({ bio: 'x'.repeat(161) })).toMatchObject({ ok: false, field: 'bio' });
  });

  it('clears a field on an empty string', () => {
    expect(
      checkProfilePatch({ username: '', bio: '', website: '', telegram: '', xHandle: '' }),
    ).toEqual({
      ok: true,
      patch: { username: null, bio: null, website: null, telegram: null, xHandle: null },
    });
  });
});

describe('canSeePrivate', () => {
  const owner = {
    net: 'RH' as const,
    wallet: '0xAbC0000000000000000000000000000000000001',
    jti: 'j',
    sessionId: null,
  };
  it('public profiles are visible to everyone, private ones to the owner only', () => {
    expect(canSeePrivate(undefined, 'RH', owner.wallet, { private: false })).toBe(true);
    expect(canSeePrivate(undefined, 'RH', owner.wallet, null)).toBe(true);
    expect(canSeePrivate(undefined, 'RH', owner.wallet, { private: true })).toBe(false);
    expect(canSeePrivate(owner, 'RH', owner.wallet.toLowerCase(), { private: true })).toBe(true);
    expect(canSeePrivate({ ...owner, net: 'BASE' }, 'RH', owner.wallet, { private: true })).toBe(
      false,
    );
    expect(
      canSeePrivate(
        { ...owner, wallet: '0xabc0000000000000000000000000000000000002' },
        'RH',
        owner.wallet,
        {
          private: true,
        },
      ),
    ).toBe(false);
  });

  it('walletForms covers the checksummed and lowercase EVM spellings, exact on Solana', () => {
    expect(walletForms('RH', '0xAbC')).toEqual(['0xAbC', '0xabc']);
    expect(walletForms('BASE', '0xabc')).toEqual(['0xabc']);
    expect(walletForms('SOL', 'AbC')).toEqual(['AbC']);
  });
});

describe('withCostBasis', () => {
  const basis = (over: Partial<CostBasis>): CostBasis => ({
    boughtTok: 0,
    boughtUsd: 0,
    soldTok: 0,
    soldUsd: 0,
    netTok: 0,
    avgCost: 0,
    realisedUsd: 0,
    ...over,
  });

  it('prices, attaches average-cost PnL, filters dust and sorts by value', () => {
    const out = withCostBasis(
      [
        { sym: 'DUST', mint: 'm-dust', tok: 1, priceUsd: 0.000001 },
        { sym: 'WOJAK', mint: 'm-wojak', tok: 100, priceUsd: 2 },
        { sym: 'HOPIUM', mint: 'm-hopium', tok: 1000, priceUsd: 0.1 },
      ],
      new Map([
        ['m-wojak', basis({ boughtTok: 100, boughtUsd: 100, netTok: 100, avgCost: 1 })],
        [
          'm-hopium',
          basis({
            boughtTok: 2000,
            boughtUsd: 400,
            soldTok: 1000,
            soldUsd: 300,
            netTok: 1000,
            avgCost: 0.2,
            realisedUsd: 100,
          }),
        ],
      ]),
    );
    expect(out.map((h) => h.sym)).toEqual(['WOJAK', 'HOPIUM']);
    expect(out[0]).toMatchObject({
      value: 200,
      cost: 100,
      pnlUsd: 100,
      pnlPct: 100,
      basis: 'trades',
    });
    expect(out[1]).toMatchObject({
      value: 100,
      cost: 200,
      pnlUsd: -100,
      pnlPct: -50,
      realisedUsd: 100,
    });
  });

  it('flags a balance the trades cannot explain (transfer / creator allocation) and no-basis holdings', () => {
    const out = withCostBasis(
      [
        { sym: 'AIRDROP', mint: 'm-a', tok: 500, priceUsd: 1 },
        { sym: 'TOPPED', mint: 'm-t', tok: 300, priceUsd: 1 },
      ],
      new Map([['m-t', basis({ boughtTok: 100, boughtUsd: 50, netTok: 100, avgCost: 0.5 })]]),
    );
    const airdrop = out.find((h) => h.sym === 'AIRDROP');
    const topped = out.find((h) => h.sym === 'TOPPED');
    expect(airdrop).toMatchObject({ basis: 'unknown', cost: 0, pnlUsd: null, pnlPct: null });
    // Only the 100 bought tokens carry a basis; PnL is on that part alone.
    expect(topped).toMatchObject({ basis: 'partial', cost: 50, pnlUsd: 250 });
  });

  it('keeps a worthless bag that cost real money (the loss is the point)', () => {
    const out = withCostBasis(
      [{ sym: 'RUG', mint: 'm-r', tok: 10, priceUsd: 0 }],
      new Map([['m-r', basis({ boughtTok: 10, boughtUsd: 40, netTok: 10, avgCost: 4 })]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ value: 0, cost: 40, pnlUsd: -40, pnlPct: -100 });
  });
});
