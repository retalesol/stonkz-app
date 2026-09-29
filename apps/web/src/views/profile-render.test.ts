import { describe, expect, it } from 'vitest';
import type { LiveActivity, LiveFollowEntry, LiveHolding } from '../api/social.js';
import {
  activityTableHTML,
  followRowsHTML,
  holdingsTableHTML,
  linksHTML,
  pnlSummaryHTML,
  privateBadgeHTML,
  privateNoticeHTML,
  stakedRowsHTML,
} from './profile-render.js';

/**
 * The profile page's pure blocks, as a visitor / the owner / a private
 * profile would see them. Rendered to strings — the same markup
 * `views/profile.ts` puts in the DOM — with whitespace collapsed.
 */

const flat = (h: { value: string }): string => h.value.replace(/\s+/g, ' ');

const ACT_OPTS = {
  unitOf: (net: string) => (net === 'SOL' ? 'SOL' : net === 'ARC' ? 'USDC' : 'ETH'),
  txUrl: (net: string, sig: string) => `https://scan.example/${net}/tx/${sig}`,
  nameOf: (wallet: string) =>
    wallet === 'FRIENDWALLET0000000000000000000000000000000' ? 'Alice' : wallet.slice(0, 4) + '…',
} as Parameters<typeof activityTableHTML>[2];

describe('identity block', () => {
  it('renders only http(s) links, never javascript:/data:, with noopener on every anchor', () => {
    const out = flat(
      linksHTML({
        website: 'https://ston.kz/about',
        xHandle: 'degen',
        telegram: 'https://t.me/stonkz_chat',
      }),
    );
    expect(out).toContain('href="https://ston.kz/about"');
    expect(out).toContain('>ston.kz<');
    expect(out).toContain('href="https://x.com/degen"');
    expect(out).toContain('>@degen<');
    expect(out).toContain('href="https://t.me/stonkz_chat"');
    expect(out).toContain('>t.me/stonkz_chat<');
    expect((out.match(/rel="noopener noreferrer nofollow"/g) ?? []).length).toBe(3);

    // A poisoned cache / older row still cannot produce an unsafe link.
    const bad = flat(
      linksHTML({
        website: 'javascript:alert(1)',
        xHandle: '<script>',
        telegram: 'https://evil.example/t.me/x',
      }),
    );
    expect(bad).toBe('');
    expect(flat(linksHTML({ website: null, xHandle: null, telegram: null }))).toBe('');
  });

  it('escapes user text inside links', () => {
    const out = flat(
      linksHTML({ website: 'https://a.b/"onmouseover="x', xHandle: null, telegram: null }),
    );
    expect(out).not.toContain('"onmouseover="');
    expect(out).toContain('&quot;onmouseover=&quot;');
  });

  it('the private badge and notice say who can see what', () => {
    expect(flat(privateBadgeHTML())).toContain('PRIVATE');
    const notice = flat(privateNoticeHTML('holdings and pnl are'));
    expect(notice).toContain('THIS PROFILE IS PRIVATE');
    expect(notice).toContain('HOLDINGS AND PNL ARE ONLY VISIBLE TO THE OWNER');
  });
});

describe('portfolio', () => {
  const holdings: LiveHolding[] = [
    {
      sym: 'WOJAK',
      mint: 'm-w',
      tok: 150,
      cost: 75,
      value: 150,
      pnlUsd: 75,
      pnlPct: 100,
      basis: 'trades',
    },
    {
      sym: 'AIRDROP',
      mint: 'm-a',
      tok: 500,
      cost: 0,
      value: 20,
      pnlUsd: null,
      pnlPct: null,
      basis: 'unknown',
    },
    {
      sym: 'TOPPED',
      mint: 'm-t',
      tok: 300,
      cost: 50,
      value: 30,
      pnlUsd: -20,
      pnlPct: -40,
      basis: 'partial',
    },
  ];

  it('shows PnL for known basis, a dash for unknown, and flags partial basis', () => {
    const out = flat(holdingsTableHTML(holdings));
    expect(out).toContain('data-sym="WOJAK"');
    expect(out).toContain('+$75.00');
    expect(out).toContain('+100.0%');
    // Unknown basis: cost and pnl are dashes, with the `?` flag.
    const airdropRow = out.slice(
      out.indexOf('data-sym="AIRDROP"'),
      out.indexOf('data-sym="TOPPED"'),
    );
    expect(airdropRow).toContain('cost basis unknown');
    expect((airdropRow.match(/>\s*—\s*</g) ?? []).length).toBe(2);
    // Partial basis: the `~` flag and a negative pnl.
    const toppedRow = out.slice(out.indexOf('data-sym="TOPPED"'));
    expect(toppedRow).toContain('bought part only');
    expect(toppedRow).toContain('-$20.00');
    expect(toppedRow).toContain('-40.0%');
  });

  it('empty holdings and the pnl summary line', () => {
    expect(flat(holdingsTableHTML([]))).toContain('NO POSITIONS');
    expect(flat(pnlSummaryHTML(undefined))).toBe('');
    const sum = flat(pnlSummaryHTML({ unrealisedUsd: 55, realisedUsd: -12.5 }));
    expect(sum).toContain('UNREALISED');
    expect(sum).toContain('+$55.00');
    expect(sum).toContain('-$12.50');
  });

  it('read-only staked rows show lock, amount and accrued rewards', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const out = flat(
      stakedRowsHTML(
        [
          {
            sym: 'STK',
            mint: '0xaa',
            amt: 500,
            lockDays: 30,
            mult: 2,
            untilMs: now + 1000,
            rewardNative: 0.01,
            rewardTokens: 0,
            valueUsd: 500,
          },
          {
            sym: 'FLEX',
            mint: '0xbb',
            amt: 10,
            lockDays: 0,
            mult: 1,
            untilMs: 0,
            rewardNative: 0,
            rewardTokens: 3,
            valueUsd: 1,
          },
        ],
        'ETH',
        now,
      ),
    );
    expect(out).toContain('data-stk="STK"');
    expect(out).toContain('2x 30D');
    expect(out).toContain('500 STAKED');
    expect(out).toContain('0.0100 ETH');
    expect(out).toContain('3 FLEX');
    expect(out).not.toContain('CLAIM<');
    expect(flat(stakedRowsHTML([], 'SOL', now))).toContain('NO STAKED POSITIONS');
  });
});

describe('recent activity', () => {
  const t0 = Date.parse('2026-09-29T10:00:00Z');
  const items: LiveActivity[] = [
    {
      id: 'follow:1',
      kind: 'follow',
      net: 'SOL',
      t: t0 + 6000,
      target: 'FRIENDWALLET0000000000000000000000000000000',
    },
    { id: 'level:2', kind: 'level_up', net: 'SOL', t: t0 + 5000, level: 2, label: 'BAG HOLDER' },
    {
      id: 'crate:3',
      kind: 'crate',
      net: 'SOL',
      t: t0 + 4000,
      tier: 'BRONZE',
      label: '180 $STONKZ',
    },
    {
      id: 'stake_claim:4',
      kind: 'stake_claim',
      net: 'BASE',
      t: t0 + 3000,
      sym: 'MINE',
      sig: '0xclaim',
      native: 0.002,
    },
    {
      id: 'trade:5',
      kind: 'sell',
      net: 'ARC',
      t: t0 + 2000,
      sym: 'MINE',
      sig: '0xsell',
      native: 1.5,
      usd: 1.5,
    },
    {
      id: 'trade:6',
      kind: 'buy',
      net: 'SOL',
      t: t0 + 1000,
      sym: 'MINE',
      sig: 'sigbuy1111111111',
      native: 0.25,
      usd: 50,
    },
    {
      id: 'launch:7',
      kind: 'launch',
      net: 'SOL',
      t: t0,
      sym: 'MINE',
      mint: 'mint-mine',
      sig: 'siglaunch11111111',
    },
  ];

  it('one row per action with per-net units, explorer links and a LOAD MORE cursor', () => {
    const out = flat(activityTableHTML(items, t0, { ...ACT_OPTS, showNet: true }));
    for (const id of items.map((i) => i.id)) expect(out).toContain(`data-act="${id}"`);
    expect(out.indexOf('data-act="follow:1"')).toBeLessThan(out.indexOf('data-act="launch:7"'));
    expect(out).toContain('>Alice<');
    expect(out).toContain('LV 2');
    expect(out).toContain('BAG HOLDER');
    expect(out).toContain('BRONZE');
    expect(out).toContain('180 $STONKZ');
    expect(out).toContain('0.0020 ETH');
    expect(out).toContain('1.5000 USDC');
    expect(out).toContain('0.2500 SOL');
    expect(out).toContain('$50.00');
    expect(out).toContain('href="https://scan.example/BASE/tx/0xclaim"');
    expect(out).toContain('href="https://scan.example/SOL/tx/siglaunch11111111"');
    expect(out).toContain('<span class="pf-net">ARC</span>');
    expect(out).toContain(`id="pfActMore" data-before="${t0}"`);
    // Off-chain rows (crate, level-up, follow) carry no tx link.
    const crateRow = out.slice(
      out.indexOf('data-act="crate:3"'),
      out.indexOf('data-act="stake_claim:4"'),
    );
    expect(crateRow).not.toContain('href=');
  });

  it('no cursor on the last page, and an empty state', () => {
    const out = flat(activityTableHTML(items.slice(0, 1), null, ACT_OPTS));
    expect(out).not.toContain('pfActMore');
    expect(flat(activityTableHTML([], null, ACT_OPTS))).toContain('NO ACTIVITY YET');
  });

  it('escapes anything user-controlled in a row', () => {
    const out = flat(
      activityTableHTML(
        [
          {
            id: 'x',
            kind: 'crate',
            net: 'SOL',
            t: t0,
            tier: '<img src=x onerror=alert(1)>',
            label: '"><b>',
          },
        ],
        null,
        ACT_OPTS,
      ),
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('friends / followers / following', () => {
  const entries: LiveFollowEntry[] = [
    {
      wallet: 'ALICEWALLET00000000000000000000000000000000',
      username: 'Alice',
      avatarUrl: 'https://gw/a.png',
      createdAtMs: 1,
    },
    {
      wallet: 'BOBWALLET0000000000000000000000000000000000',
      username: null,
      avatarUrl: null,
      createdAtMs: 2,
    },
  ];

  it('rows are click targets keyed by wallet, named by username or short address', () => {
    const out = flat(followRowsHTML(entries, { empty: 'NONE', tag: 'MUTUAL', nextBefore: 2 }));
    expect(out).toContain('class="friend" data-addr="ALICEWALLET00000000000000000000000000000000"');
    expect(out).toContain('>Alice<');
    expect(out).toContain('data-avatar="https://gw/a.png"');
    expect(out).toContain('BOBW');
    expect(out).toContain('MUTUAL');
    expect(out).toContain('id="pfFriendsMore" data-before="2"');
    expect(flat(followRowsHTML([], { empty: 'NO FOLLOWERS YET' }))).toContain('NO FOLLOWERS YET');
  });
});
