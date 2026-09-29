import { describe, expect, it } from 'vitest';
import type {
  LiveReferralClaimAsset,
  LiveReferralPayout,
  LiveReferralSnapshot,
} from '../api/social.js';
import {
  type ReferralModel,
  claimButtonLabel,
  claimControlsHTML,
  onchainEnabled,
  payoutRowText,
  referralHTML,
} from './referral-view.js';

/**
 * The referral panel's states without a DOM: sim mode, guest, loading, a
 * request-only net, an on-chain net with / without something to claim, a
 * claim in flight, and the history rows for both settlement methods.
 */

const flat = (h: { value: string }): string => h.value.replace(/\s+/g, ' ');

function snapshot(over: Partial<LiveReferralSnapshot> = {}): LiveReferralSnapshot {
  return {
    code: 'AB12CD34',
    rates: [0.15, 0.1, 0.05],
    spKickbackRate: 0.05,
    referredBy: null,
    directReferrals: 3,
    pendingNative: 0.15,
    lifetimeNative: 0.4,
    tiers: [
      { tier: 1, rate: 0.15, pendingNative: 0.15, lifetimeNative: 0.4, fills: 4 },
      { tier: 2, rate: 0.1, pendingNative: 0, lifetimeNative: 0, fills: 0 },
      { tier: 3, rate: 0.05, pendingNative: 0, lifetimeNative: 0, fills: 0 },
    ],
    requestedNative: 0,
    paidNative: 0.25,
    payouts: [],
    ...over,
  };
}

function asset(over: Partial<LiveReferralClaimAsset> = {}): LiveReferralClaimAsset {
  return {
    asset: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    decimals: 18,
    vault: '0x1111111111111111111111111111111111111111',
    claimableNative: 0.15,
    claimableAtoms: '150000000000000000',
    pendingNative: 0.15,
    awaitingConfirmAtoms: '0',
    paidCumulativeAtoms: '250000000000000000',
    cumulativeAtoms: '400000000000000000',
    outstandingIds: [],
    ...over,
  };
}

function model(over: Partial<ReferralModel> = {}): ReferralModel {
  return {
    live: true,
    connected: true,
    loading: false,
    snapshot: snapshot(),
    unit: 'ETH',
    claimable: null,
    busy: null,
    ...over,
  };
}

describe('panel states', () => {
  it('sim mode says live only', () => {
    const out = flat(referralHTML(model({ live: false, snapshot: null })));
    expect(out).toContain('LIVE MODE ONLY');
    expect(out).not.toContain('refClaim');
  });

  it('guest and loading', () => {
    expect(flat(referralHTML(model({ connected: false, snapshot: null })))).toContain(
      'CONNECT A WALLET',
    );
    expect(flat(referralHTML(model({ loading: true, snapshot: null })))).toContain('LOADING');
  });

  it('a net without a vault keeps REQUEST PAYOUT and the batch copy', () => {
    const out = flat(referralHTML(model({ claimable: { configured: false, assets: [] } })));
    expect(out).toContain('REQUEST ETH PAYOUT');
    expect(out).not.toContain('CLAIM ON CHAIN');
    expect(out).toContain('id="refPayout"');
    expect(out).not.toContain('id="refPayout" disabled');
    expect(out).toContain('AWAITING PAYOUT');
    expect(out).toContain('TREASURY SIGNER IN A BATCH');
  });

  it('a net with a vault shows CLAIM ON CHAIN per asset and drops the request button', () => {
    const m = model({ claimable: { configured: true, assets: [asset()] } });
    expect(onchainEnabled(m)).toBe(true);
    const out = flat(referralHTML(m));
    expect(out).toContain('CLAIM ON CHAIN · 0.1500 ETH');
    expect(out).toContain('data-asset="0x4200000000000000000000000000000000000006"');
    expect(out).not.toContain('REQUEST ETH PAYOUT');
    expect(out).toContain('AWAITING YOUR CLAIM');
    expect(out).toContain('REDEEMS IT AGAINST THE REFERRAL VAULT');
    // enabled: no `disabled` attribute on the on-chain button
    expect(out).not.toMatch(/id="refClaimChain"[^>]*disabled/);
  });

  it('the snapshot flag alone switches to the on-chain copy before claimable is back', () => {
    const m = model({ snapshot: snapshot({ onchainClaims: true }) });
    expect(onchainEnabled(m)).toBe(true);
    const out = flat(referralHTML(m));
    expect(out).toContain('CLAIM ON CHAIN');
    expect(out).toMatch(/id="refClaimChain" disabled/);
  });

  it('nothing to claim disables the on-chain button; $STONKZ follows pending', () => {
    const none = model({
      snapshot: snapshot({ pendingNative: 0 }),
      claimable: { configured: true, assets: [asset({ claimableNative: 0, claimableAtoms: '0' })] },
    });
    const out = flat(claimControlsHTML(none));
    expect(out).toMatch(/id="refClaimChain"[^>]*disabled/);
    expect(out).toMatch(/id="refClaim" disabled/);
    expect(out).toContain('CLAIM ON CHAIN · 0.0000 ETH');
  });

  it('a claim in flight relabels and disables everything', () => {
    for (const [busy, label] of [
      ['preparing', 'PREPARING…'],
      ['signing', 'SIGN IN WALLET…'],
      ['confirming', 'CONFIRMING…'],
    ] as const) {
      const m = model({ busy, claimable: { configured: true, assets: [asset()] } });
      const out = flat(claimControlsHTML(m));
      expect(out).toContain(label);
      expect(out).toMatch(/id="refClaimChain"[^>]*disabled/);
      expect(out).toMatch(/id="refClaim" disabled/);
      expect(claimButtonLabel(asset(), 'ETH', busy)).toBe(label);
    }
  });

  it('Solana labels the asset in SOL, other assets by symbol', () => {
    expect(claimButtonLabel(asset({ symbol: 'SOL', claimableNative: 1.5 }), 'SOL', null)).toBe(
      'CLAIM ON CHAIN · 1.5000 SOL',
    );
    expect(claimButtonLabel(asset({ symbol: 'USDC', claimableNative: 12 }), 'ETH', null)).toBe(
      'CLAIM ON CHAIN · 12.0000 USDC',
    );
  });
});

describe('history rows', () => {
  const at = Date.parse('2026-09-29T10:00:00.000Z');
  const row = (over: Partial<LiveReferralPayout>): LiveReferralPayout => ({
    id: 1,
    amountNative: 0.15,
    mode: 'native',
    status: 'paid',
    stonkz: null,
    txSig: null,
    requestedAt: at,
    settledAt: null,
    ...over,
  });

  it('renders $STONKZ, batch and on-chain rows distinctly', () => {
    expect(payoutRowText(row({ mode: 'stonkz', stonkz: 1500 }), 'ETH')).toBe(
      '2026-09-29 · 1,500 $STONKZ FOR 0.150000 ETH',
    );
    expect(payoutRowText(row({ status: 'requested' }), 'ETH')).toBe(
      '2026-09-29 · 0.150000 ETH · BATCH · REQUESTED',
    );
    expect(payoutRowText(row({ method: 'onchain', status: 'requested' }), 'ETH')).toBe(
      '2026-09-29 · 0.150000 ETH · ON CHAIN · AWAITING YOUR CLAIM',
    );
    expect(
      payoutRowText(row({ method: 'onchain', status: 'paid', txSig: '0xabcdef0123456789' }), 'ETH'),
    ).toBe('2026-09-29 · 0.150000 ETH · ON CHAIN · PAID · 0xabcdef01…');
    expect(payoutRowText(row({ status: 'void' }), 'SOL')).toBe(
      '2026-09-29 · 0.150000 SOL · BATCH · VOID',
    );
  });

  it('the panel lists the five newest rows', () => {
    const payouts = Array.from({ length: 7 }, (_, i) =>
      row({ id: i, method: 'onchain', txSig: `0xsig${i}00000000` }),
    );
    const out = flat(referralHTML(model({ snapshot: snapshot({ payouts }) })));
    expect(out.match(/ON CHAIN · PAID/g)?.length).toBe(5);
    expect(out).toContain('0xsig00000…');
    expect(out).not.toContain('0xsig60000…');
  });
});
