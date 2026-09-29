import { describe, expect, it } from 'vitest';
import type { Trade } from '../state/coins.js';
import { fmtNativeAmt, fmtTradeTime, tradesTableHTML } from './token-trades.js';

/* MEMEMAN on Base Sepolia: the two indexed buys plus a provisional third. */
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const SIG1 = '0x0df81a74760dffca76878fb466324dbc1cb13f70b0bb8f9a42f81ebbe8542ca0';
const SIG2 = '0xc9cb1630b6b535c54f37fe5319262950683da8b47cdd88e65e218b9e2301d328';

const TRADES: Trade[] = [
  {
    t: new Date(NOW - 30_000),
    buy: false,
    sol: 0.0025,
    tok: 1500,
    mc: 4400.1,
    w: '0x1FA9..Bdca',
    addr: CREATOR,
    v: 'CURVE',
    sig: '0xabc',
    pending: true,
    usd: 6.8,
  },
  {
    t: new Date(1_790_687_804_000),
    buy: true,
    sol: 0.01,
    tok: 6111.521679362614,
    mc: 4413.656488,
    w: '0x1FA9..Bdca',
    addr: CREATOR,
    v: 'CURVE',
    sig: SIG2,
    usd: 27.366026,
    id: 2,
  },
  {
    t: new Date(1_790_686_260_000),
    buy: true,
    sol: 0.01,
    tok: 6182.783899285643,
    mc: 4362.931659,
    w: '0x1FA9..Bdca',
    addr: CREATOR,
    v: 'CURVE',
    sig: SIG1,
    usd: 27.366026,
    id: 1,
  },
];

function render(over: Partial<Parameters<typeof tradesTableHTML>[0]> = {}): string {
  return tradesTableHTML({
    trades: TRADES,
    net: 'BASE',
    supply: 1_000_000,
    live: true,
    now: NOW,
    txUrl: (sig) => 'https://sepolia.basescan.org/tx/' + sig,
    nameOf: (w) => (w === CREATOR ? 'mememan.eth' : w),
    hasMore: false,
    loading: false,
    ...over,
  }).value.replace(/\s+/g, ' ');
}

describe('fmtNativeAmt', () => {
  it('never rounds a small ETH fill to zero', () => {
    expect(fmtNativeAmt(0.01)).toBe('0.01');
    expect(fmtNativeAmt(0.0025)).toBe('0.0025');
    expect(fmtNativeAmt(0.00005)).toBe('0.00005');
    expect(fmtNativeAmt(1.5)).toBe('1.5');
    expect(fmtNativeAmt(0)).toBe('0');
  });
});

describe('fmtTradeTime', () => {
  it('shows the clock today and the date before that', () => {
    const today = new Date(NOW - 5 * 60_000);
    expect(fmtTradeTime(today, NOW)).toMatch(/^\d\d:\d\d:\d\d$/);
    const lastWeek = new Date(NOW - 7 * 86_400_000);
    expect(fmtTradeTime(lastWeek, NOW)).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
  });
});

describe('tradesTableHTML', () => {
  it('renders side, native + tokens, spot price, cap, trader link and explorer link per row', () => {
    const out = render();
    expect(out).toContain('<th scope="col" class="r">ETH</th>');
    expect(out).toContain('>BUY<');
    expect(out).toContain('>SELL<');
    // Native size with enough decimals, the USD notional beside it.
    expect(out).toMatch(/0\.01\s*<i class="dm">\$27<\/i>/);
    expect(out).toMatch(/0\.0025\s*<i class="dm">\$7<\/i>/);
    expect(out).toContain('6,112');
    // Spot price after the fill: cap over supply, the header's own number.
    expect(out).toContain('$0.004414');
    expect(out).toContain('$4.4K');
    // Trader links to the full wallet, labelled by display name.
    expect(out).toContain(`data-addr="${CREATOR}"`);
    expect(out).toContain('mememan.eth');
    // Time cell is the explorer link.
    expect(out).toContain('https://sepolia.basescan.org/tx/' + SIG2);
    expect(out).not.toContain('LOAD OLDER');
  });

  it('dims a provisional fill and marks it as awaiting the indexer', () => {
    const out = render();
    expect(out).toMatch(/<tr class="tr-row newrow pend"|<tr class="tr-row pend"/);
    expect(out).toContain('Awaiting indexer');
    expect(out).toContain('awaiting indexer finality');
  });

  it('keeps newest-first order', () => {
    const out = render();
    expect(out.indexOf(SIG2)).toBeLessThan(out.indexOf(SIG1));
  });

  it('offers LOAD OLDER only when the API has more', () => {
    expect(render({ hasMore: true })).toContain('id="tr-more"');
    expect(render({ hasMore: true, loading: true })).toContain('LOADING…');
  });

  it('expands a multi-hop route under its row', () => {
    const hop: Trade = {
      ...TRADES[1]!,
      v: 'UNISWAP → CURVE',
      open: true,
      hops: [
        { venue: 'UNISWAP', inSymbol: 'ETH', outSymbol: 'USDC', inAmount: 0.01, outAmount: 27.3 },
        { venue: 'CURVE', inSymbol: 'USDC', outSymbol: 'MEMEMAN', inAmount: 27.3, outAmount: 6111 },
      ],
    };
    const out = render({ trades: [hop] });
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('HOP 1');
    expect(out).toContain('HOP 2');
    expect(out).toContain('colspan="8"');
  });

  it('escapes anything that came from the wire', () => {
    const evil: Trade = { ...TRADES[1]!, w: '<img src=x onerror=alert(1)>', addr: '<b>x</b>' };
    const out = render({ trades: [evil], nameOf: (w) => w });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('shows the loading and empty states', () => {
    expect(render({ trades: [], loading: true })).toContain('LOADING TRADES');
    expect(render({ trades: [] })).toContain('NO RECENT TRADES YET');
  });
});
