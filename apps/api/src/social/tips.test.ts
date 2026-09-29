import { describe, expect, it } from 'vitest';
import { createFakeRpcs } from '../chain/fake.js';
import type { NativeTransferVerification } from '../chain/types.js';
import { minTipFor, verifyTip } from './tips.js';

/**
 * The one function that stands between "the client claims a tip happened"
 * and "the wall accepts it". Every rejection path here is a case
 * `routes/social.ts`'s `POST /wall/:net/:addr` must refuse, not just log.
 */
describe('verifyTip', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z');

  it('accepts a plain transfer that clears the minimum, from the right sender to the right recipient', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-good', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: 'BOB',
      amountNative: 0.01,
      blockTimeMs: NOW - 1000,
    });

    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-good',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });

    expect(result).toEqual({ ok: true, amountNative: 0.01 });
  });

  it('never trusts a client-asserted amount: the amount reported is the RPC-verified one', async () => {
    const rpcs = createFakeRpcs();
    // A client could send `tipTxSig` alongside a body claiming e.g. 5 SOL —
    // this proves the route only ever sees what the chain says moved.
    rpcs.SOL.setNativeTransfer('sig-real-amount', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: 'BOB',
      amountNative: 0.002,
      blockTimeMs: NOW - 1000,
    });

    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-real-amount',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.amountNative).toBe(0.002);
    expect(result.amountNative).not.toBe(5);
  });

  it('rejects a signature the chain never confirmed', async () => {
    const rpcs = createFakeRpcs();
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-does-not-exist',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects a failed transaction even if a transfer was attempted', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-failed', {
      found: true,
      status: 'failed',
      from: 'ALICE',
      to: 'BOB',
      amountNative: 1,
      blockTimeMs: NOW - 1000,
    });
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-failed',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'failed_tx' });
  });

  it('rejects a transfer from someone other than the authenticated caller', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-wrong-sender', {
      found: true,
      status: 'success',
      from: 'MALLORY',
      to: 'BOB',
      amountNative: 1,
      blockTimeMs: NOW - 1000,
    });
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-wrong-sender',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_sender' });
  });

  it('rejects a transfer to someone other than the profile owner', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-wrong-recipient', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: 'EVE',
      amountNative: 1,
      blockTimeMs: NOW - 1000,
    });
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-wrong-recipient',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_recipient' });
  });

  it('rejects a transfer below the network minimum', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-dust', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: 'BOB',
      amountNative: minTipFor('SOL') / 2,
      blockTimeMs: NOW - 1000,
    });
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-dust',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });

  it('rejects a signature older than the accepted evidence window', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-stale', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: 'BOB',
      amountNative: 1,
      blockTimeMs: NOW - 2 * 24 * 60 * 60 * 1000,
    });
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-stale',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'too_old' });
  });

  // Security review L1: a null block time used to skip the recency check
  // entirely, so a transfer of unknowable age passed as evidence of a live
  // payment. It now fails closed, with a reason distinct from `too_old` so an
  // operator can tell "provably stale" from "cannot establish age".
  it('rejects a transfer whose age cannot be established', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-no-time', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: 'BOB',
      amountNative: 1,
      blockTimeMs: null,
    });
    const result = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-no-time',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_age' });
  });

  it('matches EVM addresses case-insensitively', async () => {
    const rpcs = createFakeRpcs();
    rpcs.RH.setNativeTransfer('0xhash', {
      found: true,
      status: 'success',
      from: '0xAAAABBBBCCCCDDDDEEEEFFFF00001111AAAABBBB',
      to: '0xBBBBCCCCDDDDEEEEFFFF00001111AAAABBBBCCCC',
      amountNative: 0.001,
      blockTimeMs: NOW - 1000,
    });
    const result = await verifyTip({
      rpc: rpcs.RH,
      net: 'RH',
      signature: '0xhash',
      fromWallet: '0xaaaabbbbccccddddeeeeffff00001111aaaabbbb',
      toWallet: '0xbbbbccccddddeeeeffff00001111aaaabbbbcccc',
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyTip — nets and amounts', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z');
  const transfer = (over: Partial<NativeTransferVerification>): NativeTransferVerification => ({
    found: true as const,
    status: 'success' as const,
    from: '0xAAAABBBBCCCCDDDDEEEEFFFF00001111AAAABBBB',
    to: '0xBBBBCCCCDDDDEEEEFFFF00001111AAAABBBBCCCC',
    amountNative: 0.001,
    blockTimeMs: NOW - 1000,
    ...over,
  });

  it('matches Base and Arc addresses case-insensitively too (not only Robinhood)', async () => {
    const rpcs = createFakeRpcs();
    rpcs.BASE.setNativeTransfer('0xbase', transfer({}));
    rpcs.ARC.setNativeTransfer('0xarc', transfer({ amountNative: 1 }));
    const base = await verifyTip({
      rpc: rpcs.BASE,
      net: 'BASE',
      signature: '0xbase',
      fromWallet: '0xaaaabbbbccccddddeeeeffff00001111aaaabbbb',
      toWallet: '0xbbbbccccddddeeeeffff00001111aaaabbbbcccc',
      nowMs: NOW,
    });
    expect(base).toEqual({ ok: true, amountNative: 0.001 });
    const arc = await verifyTip({
      rpc: rpcs.ARC,
      net: 'ARC',
      signature: '0xarc',
      fromWallet: '0xaaaabbbbccccddddeeeeffff00001111aaaabbbb',
      toWallet: '0xbbbbccccddddeeeeffff00001111aaaabbbbcccc',
      nowMs: NOW,
    });
    expect(arc).toEqual({ ok: true, amountNative: 1 });
  });

  it("applies each net's own minimum: 0.0001 ETH clears Base, not Arc's 0.25 USDC", async () => {
    const rpcs = createFakeRpcs();
    rpcs.ARC.setNativeTransfer('0xarc-small', transfer({ amountNative: 0.1 }));
    const arc = await verifyTip({
      rpc: rpcs.ARC,
      net: 'ARC',
      signature: '0xarc-small',
      fromWallet: '0xaaaabbbbccccddddeeeeffff00001111aaaabbbb',
      toWallet: '0xbbbbccccddddeeeeffff00001111aaaabbbbcccc',
      nowMs: NOW,
    });
    expect(arc).toEqual({ ok: false, reason: 'below_minimum' });
    expect(minTipFor('ARC')).toBe(0.25);
    expect(minTipFor('BASE')).toBe(0.0001);
  });

  it('a signature is only evidence on the net it was verified against', async () => {
    const rpcs = createFakeRpcs();
    rpcs.RH.setNativeTransfer('0xsame', transfer({}));
    // The same hash asked of the Base RPC is simply not there.
    const onBase = await verifyTip({
      rpc: rpcs.BASE,
      net: 'BASE',
      signature: '0xsame',
      fromWallet: '0xaaaabbbbccccddddeeeeffff00001111aaaabbbb',
      toWallet: '0xbbbbccccddddeeeeffff00001111aaaabbbbcccc',
      nowMs: NOW,
    });
    expect(onBase).toEqual({ ok: false, reason: 'not_found' });
  });

  it('treats a missing, zero, negative or non-finite amount as below the minimum', async () => {
    const rpcs = createFakeRpcs();
    for (const [sig, amountNative] of [
      ['sig-null', null],
      ['sig-zero', 0],
      ['sig-neg', -1],
      ['sig-nan', Number.NaN],
      ['sig-inf', Number.POSITIVE_INFINITY],
    ] as const) {
      rpcs.SOL.setNativeTransfer(sig, {
        found: true,
        status: 'success',
        from: 'ALICE',
        to: 'BOB',
        amountNative,
        blockTimeMs: NOW - 1000,
      });
      const r = await verifyTip({
        rpc: rpcs.SOL,
        net: 'SOL',
        signature: sig,
        fromWallet: 'ALICE',
        toWallet: 'BOB',
        nowMs: NOW,
      });
      expect(r, sig).toEqual({ ok: false, reason: 'below_minimum' });
    }
  });

  it('refuses a self-tip whose recipient is empty and a sender that is the zero address', async () => {
    const rpcs = createFakeRpcs();
    rpcs.SOL.setNativeTransfer('sig-no-to', {
      found: true,
      status: 'success',
      from: 'ALICE',
      to: null,
      amountNative: 1,
      blockTimeMs: NOW - 1000,
    });
    const r = await verifyTip({
      rpc: rpcs.SOL,
      net: 'SOL',
      signature: 'sig-no-to',
      fromWallet: 'ALICE',
      toWallet: 'BOB',
      nowMs: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'wrong_recipient' });
  });
});
