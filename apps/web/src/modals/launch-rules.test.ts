import { describe, expect, it } from 'vitest';
import { WalletError } from '../wallet/errors.js';
import {
  LAUNCH_LIMITS,
  checkDesc,
  checkImageFile,
  checkName,
  checkTelegram,
  checkTicker,
  checkWebsite,
  checkXHandle,
  devBuyPresets,
  fmtBuy,
  fmtWait,
  launchErrorCopy,
  parseDevBuy,
} from './launch-rules.js';

const value = (r: ReturnType<typeof checkWebsite>): string | null => (r.ok ? r.value : null);

/** `LiveApiError`'s shape without importing the transport. */
function apiErr(code: string, detail = '', status = 400, retryAfterMs?: number): Error {
  const e = new Error(detail || code) as Error & {
    code: string;
    status: number;
    retryAfterMs?: number;
  };
  e.name = 'LiveApiError';
  e.code = code;
  e.status = status;
  if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
  return e;
}

const ctx = { unit: 'SOL' as const, netName: 'SOLANA', base: 'SOL', buy: 0 };

describe('launch field rules', () => {
  it('requires a name and caps it at the card width', () => {
    expect(checkName('   ').ok).toBe(false);
    expect(value(checkName('  Moon \n Coin '))).toBe('Moon Coin');
    expect(checkName('x'.repeat(LAUNCH_LIMITS.name + 1)).ok).toBe(false);
  });

  it('normalises tickers exactly as the server does', () => {
    expect(value(checkTicker('$moon-2'))).toBe('MOON2');
    expect(checkTicker('$$$').ok).toBe(false);
  });

  it('caps descriptions and strips control characters', () => {
    expect(value(checkDesc('a\u0000b'))).toBe('a b');
    expect(checkDesc('x'.repeat(LAUNCH_LIMITS.desc + 1)).ok).toBe(false);
  });

  it('only ever stores http(s) websites', () => {
    expect(value(checkWebsite(''))).toBe('');
    expect(value(checkWebsite('moon.xyz'))).toBe('https://moon.xyz/');
    expect(value(checkWebsite('http://moon.xyz/a?b=1'))).toBe('http://moon.xyz/a?b=1');
    for (const evil of [
      'javascript:alert(1)',
      'JavaScript://moon.xyz/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'https://user:pw@moon.xyz',
      'https://localhost',
      'https://<script>',
    ]) {
      expect(checkWebsite(evil).ok, evil).toBe(false);
    }
  });

  it('accepts X handles and profile links, stored as @handle', () => {
    expect(value(checkXHandle('stonkz'))).toBe('@stonkz');
    expect(value(checkXHandle('@@stonkz_1'))).toBe('@stonkz_1');
    expect(value(checkXHandle('https://x.com/stonkz?s=20'))).toBe('@stonkz');
    expect(value(checkXHandle('twitter.com/stonkz/'))).toBe('@stonkz');
    expect(checkXHandle('"><img src=x>').ok).toBe(false);
    expect(checkXHandle('a'.repeat(16)).ok).toBe(false);
  });

  it('accepts Telegram handles, links and invites, stored as https://t.me/…', () => {
    expect(value(checkTelegram('@stonkzchat'))).toBe('https://t.me/stonkzchat');
    expect(value(checkTelegram('t.me/stonkzchat/'))).toBe('https://t.me/stonkzchat');
    expect(value(checkTelegram('https://telegram.me/stonkzchat?x=1'))).toBe(
      'https://t.me/stonkzchat',
    );
    expect(value(checkTelegram('t.me/+AbCdEf123'))).toBe('https://t.me/+AbCdEf123');
    expect(value(checkTelegram('https://t.me/joinchat/AbCdEf'))).toBe(
      'https://t.me/joinchat/AbCdEf',
    );
    expect(checkTelegram('javascript:alert(1)').ok).toBe(false);
    expect(checkTelegram('https://evil.com/stonkz').ok).toBe(false);
  });
});

describe('image checks', () => {
  it('allows only the four raster types under 5 MB', () => {
    expect(checkImageFile({ type: 'image/png', size: 1024 })).toBeNull();
    expect(checkImageFile({ type: 'image/svg+xml', size: 1024 })).toMatch(/PNG/);
    expect(checkImageFile({ type: 'image/png', size: 0 })).toMatch(/EMPTY/);
    expect(checkImageFile({ type: 'image/gif', size: LAUNCH_LIMITS.imageBytes + 1 })).toMatch(
      /5 MB/,
    );
  });
});

describe('dev buy', () => {
  it('parses only finite, non-negative numbers', () => {
    expect(parseDevBuy('')).toBe(0);
    expect(parseDevBuy('0.5')).toBe(0.5);
    expect(parseDevBuy('0,25')).toBe(0.25);
    expect(parseDevBuy('.')).toBe(0);
    expect(parseDevBuy('-1')).toBeNull();
    expect(parseDevBuy('1e999')).toBeNull();
    expect(parseDevBuy('abc')).toBeNull();
  });

  it('offers presets in the unit being spent', () => {
    expect(Math.max(...devBuyPresets('ETH'))).toBeLessThan(1);
    expect(Math.max(...devBuyPresets('USDC'))).toBeGreaterThanOrEqual(10);
    expect(devBuyPresets('SOL')[0]).toBe(0);
    expect(fmtBuy(0.1 + 0.2)).toBe('0.3');
    expect(fmtBuy(0)).toBe('');
  });
});

describe('launch failure copy', () => {
  it('turns retry-after into a readable wait', () => {
    expect(fmtWait(42_000)).toBe('42S');
    expect(fmtWait(30 * 60_000)).toBe('30 MIN');
    expect(fmtWait(undefined)).toBe('A MOMENT');
    expect(
      launchErrorCopy(apiErr('rate_limited', 'launch limit', 429, 1_800_000), ctx).msg,
    ).toContain('30 MIN');
  });

  it('sends validation failures back to the step that caused them', () => {
    expect(launchErrorCopy(apiErr('name_or_ticker_cooldown', '', 409, 120_000), ctx)).toMatchObject(
      { step: 0 },
    );
    expect(launchErrorCopy(apiErr('moderation_rejected'), ctx).step).toBe(0);
    expect(launchErrorCopy(apiErr('ticker_taken', '', 409), ctx).step).toBe(0);
    expect(launchErrorCopy(apiErr('base_mint_not_allowed'), ctx).step).toBe(1);
    expect(launchErrorCopy(apiErr('invalid_curve_params', '', 422), ctx).step).toBe(1);
    expect(launchErrorCopy(apiErr('cashback_dev_buy_conflict', '', 422), ctx).step).toBe(2);
    expect(launchErrorCopy(apiErr('dev_buy_failed', '', 422), ctx).step).toBe(2);
  });

  it('never blames the user for a server fault', () => {
    expect(launchErrorCopy(apiErr('request_failed', 'HTTP 502', 502), ctx).msg).toMatch(
      /DRAFT IS SAVED/,
    );
    expect(launchErrorCopy(new TypeError('Failed to fetch'), ctx).msg).toMatch(/CONNECTION/);
  });

  it('tells a wallet cancel apart from a fault', () => {
    const cancel = launchErrorCopy(new WalletError('rejected', 'User rejected'), ctx);
    expect(cancel.tone).toBe('plain');
    expect(cancel.msg).toMatch(/NOTHING WAS CREATED/);
    const pending = launchErrorCopy(
      new WalletError('rejected', 'A request is already waiting in your wallet.'),
      ctx,
    );
    expect(pending.msg).toMatch(/ALREADY OPEN/);
    const broke = launchErrorCopy(new WalletError('insufficient_funds', 'insufficient funds'), {
      ...ctx,
      unit: 'ETH',
      buy: 0.1,
    });
    expect(broke.msg).toMatch(/NOT ENOUGH ETH FOR THE DEV BUY/);
    expect(broke.step).toBe(2);
    expect(launchErrorCopy(new WalletError('reverted', 'execution reverted'), ctx).msg).toMatch(
      /REVERTED/,
    );
    expect(
      launchErrorCopy(new WalletError('wrong_chain', 'The wallet is on chain 1.'), ctx).msg,
    ).toMatch(/WRONG CHAIN/);
  });
});
