import { describe, expect, it } from 'vitest';
import { createFakeRpcs } from '../chain/fake.js';
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
