import { describe, expect, it } from 'vitest';
import type { Holder } from '../state/coins.js';
import { holdersTableHTML } from './token-holders.js';

const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';

/* MEMEMAN after one FLEX stake: the wallet keeps 0.3 tokens on chain, 12,294
 * sit in the launchpad as its stake; the launchpad's balance is split into
 * the curve reserve and the LP reserve by the API. */
const ROWS: Holder[] = [
  {
    w: 'BONDING CURVE',
    p: 78.77,
    amt: 787_705.69,
    kind: 'curve',
    tag: ['CURVE', 'bc'],
    curve: true,
  },
  { w: 'LP RESERVE', p: 20, amt: 200_000, kind: 'lp', tag: ['LP', 'bc'] },
  {
    w: '0x1FA9..Bdca',
    addr: CREATOR,
    p: 1.2294,
    amt: 12_294.3056,
    staked: 12_294,
    kind: 'wallet',
    tag: ['DEV', 'dev'],
  },
];

function render(over: Partial<Parameters<typeof holdersTableHTML>[0]> = {}): string {
  return holdersTableHTML({
    rows: ROWS,
    mc: 4413.656488,
    supply: 1_000_000,
    shown: 25,
    live: true,
    holderCount: 1,
    source: 'explorer',
    nameOf: (w) => (w === CREATOR ? 'mememan.eth' : w),
    loading: false,
    refreshing: false,
    ...over,
  }).value.replace(/\s+/g, ' ');
}

describe('holdersTableHTML', () => {
  it('labels program accounts, links wallets, and shows amount, share, value and stake', () => {
    const out = render();
    expect(out).toContain('BONDING CURVE');
    expect(out).toContain('LP RESERVE');
    expect(out).toContain('>CURVE<');
    expect(out).toContain('>LP<');
    expect(out).toContain('>DEV<');
    expect(out).toContain(`data-addr="${CREATOR}"`);
    expect(out).toContain('mememan.eth');
    expect(out).toContain('12,294');
    expect(out).toContain('12,294 STAKED');
    expect(out).toContain('1.23%');
    // Value = tokens × spot price ($0.004414): 12,294 × 0.004414 ≈ $54.
    expect(out).toContain('>$54<');
    expect(out).toContain('787,706');
  });

  it('never links a program account to a profile', () => {
    const out = render();
    expect(out).not.toContain('data-addr="BONDING CURVE"');
    expect(out).toMatch(/<tr class="hold-program">/);
  });

  it('counts wallets only and names the source', () => {
    const out = render();
    expect(out).toContain('1 HOLDER ');
    expect(out).toContain('CHAIN VIA EXPLORER');
    expect(render({ source: 'db', holderCount: 2 })).toContain('2 HOLDERS · INDEXER SNAPSHOT');
  });

  it('paginates client-side with SHOW ALL', () => {
    const many: Holder[] = Array.from({ length: 40 }, (_, i) => ({
      w: 'W' + i,
      addr: '0x' + String(i).padStart(40, '0'),
      p: 1,
      amt: 10_000,
      kind: 'wallet' as const,
      tag: null,
    }));
    const out = render({ rows: many, shown: 25, holderCount: 40 });
    expect(out.match(/<tr class="">/g)?.length).toBe(25);
    expect(out).toContain('SHOW ALL (40)');
    expect(render({ rows: many, shown: 100, holderCount: 40 })).not.toContain('SHOW ALL');
  });

  it('offers REFRESH in live mode only', () => {
    expect(render()).toContain('id="hold-refresh"');
    expect(render({ refreshing: true })).toContain('REFRESHING…');
    expect(render({ live: false, source: null, holderCount: null })).not.toContain('hold-refresh');
  });

  it('reads <0.01% for dust rather than 0.00%', () => {
    const dust: Holder = { w: 'D', addr: '0xd', p: 0.00003, amt: 0.3, kind: 'wallet', tag: null };
    expect(render({ rows: [dust] })).toContain('&lt;0.01%');
  });

  it('shows the loading and empty states', () => {
    expect(render({ rows: [], loading: true })).toContain('LOADING HOLDERS');
    expect(render({ rows: [] })).toContain('NO HOLDERS ON RECORD YET');
  });
});
