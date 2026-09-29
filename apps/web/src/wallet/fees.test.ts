import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from '@wallet-standard/base';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { evmGasFields } from './evm.js';
import { openSolanaWallet } from './solana.js';

/**
 * How the settings reach the wire at the wallet layer:
 *
 * - EVM: the gas preset becomes explicit EIP-1559 fields (`evmGasFields`).
 * - Solana: an MEV mode flips the wallet from sign-and-send to sign-only and
 *   routes the bytes through the API relay, falling back to our RPC — and the
 *   result reports which of those happened.
 *
 * No network: `Connection`'s confirmation poll and raw send are stubbed.
 */

describe('evmGasFields', () => {
  const est = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }; // 1 gwei / 0.1 gwei

  it('NORMAL leaves the wallet in charge', () => {
    expect(evmGasFields(est, 'NORMAL')).toBeNull();
    expect(evmGasFields(est, undefined)).toBeNull();
  });

  it('FAST and TURBO scale the tip and keep the base-fee headroom', () => {
    expect(evmGasFields(est, 'FAST')).toEqual({
      maxPriorityFeePerGas: 150_000_000n,
      maxFeePerGas: 900_000_000n + 150_000_000n,
    });
    expect(evmGasFields(est, 'TURBO')).toEqual({
      maxPriorityFeePerGas: 250_000_000n,
      maxFeePerGas: 900_000_000n + 250_000_000n,
    });
  });

  it('floors a zero L2 tip so the preset still does something', () => {
    const zero = { maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 0n };
    expect(evmGasFields(zero, 'FAST')).toEqual({
      maxPriorityFeePerGas: 10_000_000n,
      maxFeePerGas: 60_000_000n,
    });
    expect(evmGasFields(zero, 'TURBO')?.maxPriorityFeePerGas).toBe(50_000_000n);
  });
});

/* ------------------------------------------------------------------ Solana */

const SIGNED = new Uint8Array([9, 9, 9, 9]);

function legacyTxBase64(): string {
  const payer = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
  });
  tx.add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  );
  return Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');
}

function fakeWallet(opts: { signAndSend: boolean; signTransaction: boolean }): {
  wallet: Wallet;
  calls: string[];
} {
  const calls: string[] = [];
  const account = {
    address: 'So11111111111111111111111111111111111111112',
    publicKey: new Uint8Array(32),
    chains: [],
    features: [],
  };
  const features: Record<string, unknown> = {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
    'solana:signMessage': {
      version: '1.0.0',
      signMessage: async () => [{ signedMessage: new Uint8Array(), signature: new Uint8Array(64) }],
    },
  };
  if (opts.signAndSend) {
    features['solana:signAndSendTransaction'] = {
      version: '1.0.0',
      signAndSendTransaction: async () => {
        calls.push('signAndSend');
        return [{ signature: new Uint8Array(64).fill(3) }];
      },
    };
  }
  if (opts.signTransaction) {
    features['solana:signTransaction'] = {
      version: '1.0.0',
      signTransaction: async () => {
        calls.push('signTransaction');
        return [{ signedTransaction: SIGNED }];
      },
    };
  }
  const wallet = {
    version: '1.0.0',
    name: 'Phantom',
    icon: 'data:image/svg+xml;base64,AA==',
    chains: ['solana:devnet'],
    features,
    accounts: [account],
  } as unknown as Wallet;
  return { wallet, calls };
}

describe('Solana MEV routing at the wallet layer', () => {
  const confirmed = vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({
    context: { slot: 1 },
    value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  });
  const rawSend = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('rpcSig');

  afterEach(() => {
    confirmed.mockClear();
    rawSend.mockClear();
  });

  it('SHIELD: signs without sending and relays the exact signed bytes', async () => {
    const { wallet: w, calls } = fakeWallet({ signAndSend: true, signTransaction: true });
    const wallet = await openSolanaWallet(w);
    let relayed: string | null = null;
    const out = await wallet.signAndSend({
      net: 'SOL',
      transaction: legacyTxBase64(),
      mev: 'SHIELD',
      broadcast: async (b64) => {
        relayed = b64;
        return { signature: 'jitoSig', via: 'jito' };
      },
    });
    expect(calls).toEqual(['signTransaction']);
    expect(relayed).toBe(Buffer.from(SIGNED).toString('base64'));
    expect(out).toMatchObject({ signature: 'jitoSig', route: 'jito' });
    expect(out.routeFallback).toBeUndefined();
    expect(rawSend).not.toHaveBeenCalled();
  });

  it('passes the relay’s own fallback through when the API sent over public RPC', async () => {
    const { wallet: w } = fakeWallet({ signAndSend: true, signTransaction: true });
    const wallet = await openSolanaWallet(w);
    const out = await wallet.signAndSend({
      net: 'SOL',
      transaction: legacyTxBase64(),
      mev: 'RELAY',
      broadcast: async () => ({
        signature: 's',
        via: 'rpc',
        fallback: 'private_rpc_not_configured',
      }),
    });
    expect(out).toMatchObject({ route: 'rpc', routeFallback: 'private_rpc_not_configured' });
  });

  it('relay down: the signed bytes still go out over our RPC, flagged as unprotected', async () => {
    const { wallet: w, calls } = fakeWallet({ signAndSend: true, signTransaction: true });
    const wallet = await openSolanaWallet(w);
    const out = await wallet.signAndSend({
      net: 'SOL',
      transaction: legacyTxBase64(),
      mev: 'SHIELD',
      broadcast: async () => {
        throw new Error('API unreachable');
      },
    });
    expect(calls).toEqual(['signTransaction']);
    expect(rawSend).toHaveBeenCalledTimes(1);
    expect(rawSend.mock.calls[0]![0]).toEqual(SIGNED);
    expect(out).toMatchObject({ signature: 'rpcSig', route: 'rpc' });
    expect(out.routeFallback).toMatch(/^relay: API unreachable/);
  });

  it('OFF: the wallet’s own send is used and nothing is relayed', async () => {
    const { wallet: w, calls } = fakeWallet({ signAndSend: true, signTransaction: true });
    const wallet = await openSolanaWallet(w);
    const broadcast = vi.fn();
    const out = await wallet.signAndSend({
      net: 'SOL',
      transaction: legacyTxBase64(),
      mev: 'OFF',
      broadcast,
    });
    expect(calls).toEqual(['signAndSend']);
    expect(broadcast).not.toHaveBeenCalled();
    expect(out.route).toBe('wallet');
    expect(out.routeFallback).toBeUndefined();
  });

  it('a wallet that can only sign-and-send cannot be protected, and says so', async () => {
    const { wallet: w, calls } = fakeWallet({ signAndSend: true, signTransaction: false });
    const wallet = await openSolanaWallet(w);
    const broadcast = vi.fn();
    const out = await wallet.signAndSend({
      net: 'SOL',
      transaction: legacyTxBase64(),
      mev: 'SHIELD',
      broadcast,
    });
    expect(calls).toEqual(['signAndSend']);
    expect(broadcast).not.toHaveBeenCalled();
    expect(out.route).toBe('wallet');
    expect(out.routeFallback).toMatch(/own RPC/);
  });
});
