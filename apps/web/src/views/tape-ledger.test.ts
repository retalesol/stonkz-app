import { describe, expect, it } from 'vitest';
import { TapeLedger, fidOrdinal, fidSig } from './tape-ledger.js';

const SIG = '0x0DF81A74760DFFCA76878FB466324DBC1CB13F70B0BB8F9A42F81EBBE8542CA0';
const LOW = SIG.toLowerCase();
const SOL_SIG =
  '4Lt6KFrBhCT34tk7cGbcpz8BpdRjZaMj4B8Wpmm1E5KyupiKJSvHMhuTcRXBCCqyMM8u82k15DJvJ82TKK3gLzpw';

describe('fid helpers', () => {
  it('splits `${sig}:${ordinal}`', () => {
    expect(fidOrdinal(`${LOW}:0`)).toBe(0);
    expect(fidOrdinal(`${LOW}:3`)).toBe(3);
    expect(fidSig(`${LOW}:3`)).toBe(LOW);
    expect(fidOrdinal('nocolon')).toBe(0);
    expect(fidSig('nocolon')).toBe('nocolon');
  });
});

describe('TapeLedger', () => {
  it('prints a provisional fill once and swallows its indexed twin', () => {
    const l = new TapeLedger();
    expect(l.admit({ sig: LOW, fid: `${LOW}:0` })).toBe(true);
    expect(l.admit({ sig: LOW, fid: `${LOW}:0` })).toBe(false);
  });

  it('is a no-op for the seed replayed after a reconnect', () => {
    const l = new TapeLedger();
    const seed = [`${LOW}:0`, `${SOL_SIG}:0`, `abc:0`].map((fid) => ({ fid, sig: fidSig(fid) }));
    expect(seed.map((f) => l.admit(f))).toEqual([true, true, true]);
    expect(seed.map((f) => l.admit(f))).toEqual([false, false, false]);
    // A fill that landed while the socket was down is still new.
    expect(l.admit({ fid: 'def:0', sig: 'def' })).toBe(true);
  });

  it('keeps two fills of one transaction apart', () => {
    const l = new TapeLedger();
    expect(l.admit({ sig: LOW, fid: `${LOW}:0` })).toBe(true);
    expect(l.admit({ sig: LOW, fid: `${LOW}:1` })).toBe(true);
    expect(l.admit({ sig: LOW, fid: `${LOW}:1` })).toBe(false);
  });

  it('matches EVM hashes case-insensitively and base58 exactly', () => {
    const l = new TapeLedger();
    expect(l.admit({ sig: SIG })).toBe(true);
    expect(l.admit({ sig: LOW })).toBe(false);
    expect(l.admit({ sig: SOL_SIG })).toBe(true);
    expect(l.admit({ sig: SOL_SIG.toLowerCase() })).toBe(true);
  });

  it('treats a fid print as the restatement of an id-less print of the same transaction', () => {
    const l = new TapeLedger();
    expect(l.admit({ sig: SIG })).toBe(true);
    // The first fill is the one already shown; a second fill of that tx is new.
    expect(l.admit({ sig: LOW, fid: `${LOW}:0` })).toBe(false);
    expect(l.admit({ sig: LOW, fid: `${LOW}:1` })).toBe(true);
    // And once identified, an id-less echo is a duplicate too.
    expect(l.admit({ sig: SIG })).toBe(false);
  });

  it('keys on the fid alone when a frame forgets its sig', () => {
    const l = new TapeLedger();
    expect(l.admit({ fid: `${LOW}:0` })).toBe(true);
    expect(l.admit({ sig: SIG, fid: `${LOW}:0` })).toBe(false);
    expect(l.admit({ sig: SIG })).toBe(false);
  });

  it('always shows a print with nothing to key on', () => {
    const l = new TapeLedger();
    expect(l.admit({})).toBe(true);
    expect(l.admit({})).toBe(true);
    expect(l.size).toBe(0);
  });

  it('never grows past its cap', () => {
    const l = new TapeLedger(50);
    for (let i = 0; i < 1000; i++) l.admit({ sig: `sig${i}`, fid: `sig${i}:0` });
    expect(l.size).toBeLessThanOrEqual(100);
    // The newest ids are the ones kept.
    expect(l.admit({ sig: 'sig999', fid: 'sig999:0' })).toBe(false);
    expect(l.admit({ sig: 'sig0', fid: 'sig0:0' })).toBe(true);
  });

  it('forgets everything on clear, for a net switch reseed', () => {
    const l = new TapeLedger();
    l.admit({ sig: LOW, fid: `${LOW}:0` });
    l.clear();
    expect(l.size).toBe(0);
    expect(l.admit({ sig: LOW, fid: `${LOW}:0` })).toBe(true);
  });
});
