import { describe, expect, it } from 'vitest';
import { moderateLaunch } from '../router/moderation.js';
import {
  checkTelegram,
  checkUri,
  checkWebsite,
  checkXHandle,
  imageUrlFromUri,
  nameSkeleton,
  sanitizeDescr,
  sanitizeName,
  utf8Length,
} from './launch-validate.js';

describe('sanitizeName', () => {
  it('drops bidi overrides, zero-width and control characters and collapses spaces', () => {
    expect(sanitizeName('\u202Egnp.exe\u200B  Coin\u0007\n')).toBe('gnp.exe Coin');
    expect(sanitizeName('\uFEFFＰｅｐｅ')).toBe('Pepe'); // NFKC folds full-width forms
  });

  it('counts UTF-8 bytes the way the Solana program does', () => {
    expect(utf8Length('Moon')).toBe(4);
    expect(utf8Length('月')).toBe(3);
    expect(utf8Length('🚀')).toBe(4);
  });
});

describe('sanitizeDescr', () => {
  it('keeps single line breaks but strips invisible characters', () => {
    expect(sanitizeDescr('line one\r\n\r\n\r\n\u200Bline   two\u202E')).toBe(
      'line one\n\nline two',
    );
  });
});

describe('nameSkeleton', () => {
  it('collides case, punctuation, zero-width and Cyrillic/Greek look-alikes', () => {
    const base = nameSkeleton('Pepe');
    for (const clone of ['PEPE', 'Pepe!', 'P e p e', 'Pe\u200Bpe', 'Реpe', 'Ρepe', 'Pépé']) {
      expect(nameSkeleton(clone)).toBe(base);
    }
    expect(nameSkeleton('Pepper')).not.toBe(base);
  });
});

describe('checkUri', () => {
  it('accepts https and ipfs links and empty', () => {
    expect(checkUri('')).toEqual({ ok: true, value: '' });
    expect(checkUri(' https://gw.example/ipfs/bafy ')).toEqual({
      ok: true,
      value: 'https://gw.example/ipfs/bafy',
    });
    expect(checkUri('ipfs://bafy123').ok).toBe(true);
  });

  it('refuses script, data, http, credentials, whitespace and oversize links', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'http://img.example/a.png',
      'https://user:pass@img.example/a.png',
      'https://img.example/a b.png',
      `https://img.example/${'a'.repeat(200)}`,
      'not a url',
    ]) {
      expect(checkUri(bad).ok, bad).toBe(false);
    }
  });

  it('maps ipfs:// through the gateway for the board image', () => {
    expect(imageUrlFromUri('ipfs://bafy/1.png', 'gw.example')).toBe(
      'https://gw.example/ipfs/bafy/1.png',
    );
    expect(imageUrlFromUri('https://a.example/x.png', 'gw.example')).toBe(
      'https://a.example/x.png',
    );
    expect(imageUrlFromUri('', 'gw.example')).toBeNull();
  });
});

describe('socials', () => {
  it('normalises X handles from @handles and profile links', () => {
    for (const v of ['@stonkz', 'stonkz', 'https://x.com/stonkz', 'twitter.com/stonkz/']) {
      expect(checkXHandle(v)).toEqual({ ok: true, value: 'stonkz' });
    }
    expect(checkXHandle('')).toEqual({ ok: true, value: null });
    expect(checkXHandle('has space').ok).toBe(false);
    expect(checkXHandle('waytoolonghandle_16').ok).toBe(false);
  });

  it('stores telegram as a canonical t.me link', () => {
    for (const v of [
      '@stonkzchat',
      'stonkzchat',
      'https://t.me/stonkzchat',
      'telegram.me/stonkzchat/',
    ]) {
      expect(checkTelegram(v)).toEqual({ ok: true, value: 'https://t.me/stonkzchat' });
    }
    expect(checkTelegram('t.me/+AbCdEfGh123')).toEqual({
      ok: true,
      value: 'https://t.me/+AbCdEfGh123',
    });
    for (const bad of [
      'abc',
      'javascript:alert(1)',
      'https://evil.example/stonkzchat',
      'https://user:pw@t.me/stonkzchat',
    ]) {
      expect(checkTelegram(bad).ok, bad).toBe(false);
    }
  });

  it('only accepts http(s) websites', () => {
    expect(checkWebsite('stonkz.xyz')).toEqual({ ok: true, value: 'https://stonkz.xyz/' });
    expect(checkWebsite('http://stonkz.xyz/a')).toEqual({ ok: true, value: 'http://stonkz.xyz/a' });
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://a.example',
      'localhost',
      'https://u:p@a.example',
    ]) {
      expect(checkWebsite(bad).ok, bad).toBe(false);
    }
  });
});

describe('moderateLaunch', () => {
  it('still catches separated and look-alike slurs', () => {
    expect(moderateLaunch({ name: 'fuck coin', ticker: 'X', descr: '' }).ok).toBe(false);
    expect(moderateLaunch({ name: 'f.u.c.k', ticker: 'X', descr: '' }).ok).toBe(false);
    expect(moderateLaunch({ name: 'fuсk', ticker: 'X', descr: '' }).ok).toBe(false); // Cyrillic с
    expect(moderateLaunch({ name: 'Coin', ticker: 'SPIC', descr: '' }).ok).toBe(false);
    expect(moderateLaunch({ name: 'nazis', ticker: 'X', descr: '' }).ok).toBe(false);
  });

  it('lets ordinary words that contain a short blocked term through', () => {
    for (const name of [
      'Spicy',
      'Grape',
      'Skyscraper',
      'Therapeutic',
      'Flame Retardant',
      'Drapes',
    ]) {
      expect(moderateLaunch({ name, ticker: 'OK', descr: '' }).ok, name).toBe(true);
    }
  });
});
