import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  openSecret,
  otpauthUri,
  sealSecret,
  totp,
  verifyTotp,
} from './totp.js';

/** RFC 6238 Appendix B, SHA-1 column: secret `12345678901234567890`. */
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 19, 20, 33]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it('encodes the RFC secret to the well-known string', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('RFC 6238 vectors (SHA-1, 30s, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T=%d → %s', (seconds, expected) => {
    expect(hotp(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
  });

  it('6-digit codes are the last six digits of the 8-digit ones', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
  });
});

describe('verifyTotp', () => {
  const nowMs = 1_700_000_000_000;
  const secret = generateTotpSecret();

  it('accepts the current step and one either side, refuses two away', () => {
    expect(verifyTotp(secret, totp(secret, nowMs), nowMs).ok).toBe(true);
    expect(verifyTotp(secret, totp(secret, nowMs - 30_000), nowMs).ok).toBe(true);
    expect(verifyTotp(secret, totp(secret, nowMs + 30_000), nowMs).ok).toBe(true);
    expect(verifyTotp(secret, totp(secret, nowMs - 60_000), nowMs).ok).toBe(false);
  });

  it('refuses a replay of an already-accepted step', () => {
    const first = verifyTotp(secret, totp(secret, nowMs), nowMs);
    expect(first.ok).toBe(true);
    expect(verifyTotp(secret, totp(secret, nowMs), nowMs, first.counter).ok).toBe(false);
  });

  it('refuses malformed input without touching the HMAC', () => {
    expect(verifyTotp(secret, '12345', nowMs).ok).toBe(false);
    expect(verifyTotp(secret, 'abcdef', nowMs).ok).toBe(false);
  });

  it('builds an otpauth URI the authenticator apps accept', () => {
    const uri = otpauthUri('ABCDEFGH', '0xabc');
    expect(uri).toMatch(
      /^otpauth:\/\/totp\/Stonkz%20Admin%3A0xabc\?secret=ABCDEFGH&issuer=Stonkz%20Admin/,
    );
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('secret at rest', () => {
  it('seals and opens under the same key, refuses another', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', 'key-a');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, 'key-a')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => openSecret(sealed, 'key-b')).toThrow();
  });
});
