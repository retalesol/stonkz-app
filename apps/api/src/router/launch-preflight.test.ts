import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { encodeErrorResult } from 'viem';
import { EvmRpc } from '../chain/evm.js';
import { SolanaRpc } from '../chain/solana.js';
import { RpcError, type FetchLike } from '../chain/types.js';
import {
  decodeSolanaBaseOracle,
  encodeSolanaBaseOracle,
  mapLaunchFailure,
} from './launch-preflight.js';

/** One canned JSON-RPC reply (or a thrown transport error) per call. */
function rpcReplying(reply: unknown | Error): FetchLike {
  return async () => {
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(reply as object) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const ERROR_STRING_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
] as const;

describe('mapLaunchFailure', () => {
  it.each([
    ['execution reverted: stale oracle', 503, 'oracle_stale'],
    ['Error Code: OracleStale. Error Message: Oracle price is stale.', 503, 'oracle_stale'],
    ['execution reverted: launch paused', 503, 'launch_paused'],
    ['Error Code: LaunchPaused', 503, 'launch_paused'],
    ['execution reverted: ticker', 422, 'invalid_ticker'],
    ['execution reverted: fee', 422, 'invalid_fee'],
    ['Error Code: MetadataTooLong', 422, 'metadata_too_long'],
    ['Error Code: SlippageExceeded', 409, 'dev_buy_slippage'],
    ['"InsufficientFundsForFee"', 422, 'insufficient_funds'],
    ['Transfer: insufficient lamports 1, need 5', 422, 'insufficient_funds'],
    ['insufficient funds for gas * price + value', 422, 'insufficient_funds'],
    ['execution reverted (0x12345678)', 422, 'simulation_failed'],
  ])('%j → %i %s', (reason, status, error) => {
    const r = mapLaunchFailure(reason, 'SOL');
    expect(r.status).toBe(status);
    expect(r.error).toBe(error);
    expect(r.detail).not.toContain('0x12345678');
  });

  it('asks the client to retry a stale oracle in a minute', () => {
    expect(mapLaunchFailure('execution reverted: stale oracle', 'ETH')).toEqual({
      status: 503,
      error: 'oracle_stale',
      detail: 'price feed is updating, try again in a minute',
      retryAfter: 60,
    });
  });

  it('does not read a longer revert that merely contains "ticker" as invalid_ticker', () => {
    expect(mapLaunchFailure('execution reverted: tickerless thing', 'ETH').error).toBe(
      'simulation_failed',
    );
  });
});

describe('Solana BaseOracle layout', () => {
  it('round-trips the account bytes and checks the base mint', () => {
    const mint = Keypair.generate().publicKey;
    const buf = encodeSolanaBaseOracle(mint, {
      price1e6: 150_000_000n,
      conf1e6: 10n,
      publishTime: 1_790_000_000,
      baseDecimals: 9,
    });
    expect(decodeSolanaBaseOracle(buf, mint)).toEqual({
      price1e6: 150_000_000n,
      conf1e6: 10n,
      publishTime: 1_790_000_000,
      baseDecimals: 9,
    });
    expect(decodeSolanaBaseOracle(buf, Keypair.generate().publicKey)).toBeNull();
    expect(decodeSolanaBaseOracle(buf.subarray(0, 40))).toBeNull();
  });
});

describe('EvmRpc.simulateCall', () => {
  const tx = { from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), data: '0x1234' };

  it('decodes an Error(string) revert into a result', async () => {
    const data = encodeErrorResult({
      abi: ERROR_STRING_ABI,
      errorName: 'Error',
      args: ['stale oracle'],
    });
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 84532,
      net: 'BASE',
      fetchImpl: rpcReplying({
        error: { code: 3, message: 'execution reverted: stale oracle', data },
      }),
    });
    expect(await rpc.simulateCall(tx)).toEqual({
      ok: false,
      reason: 'execution reverted: stale oracle',
    });
  });

  it('reads a -32000 revert without data from the message', async () => {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying({ error: { code: -32000, message: 'execution reverted' } }),
    });
    const res = await rpc.simulateCall(tx);
    expect(res.ok).toBe(false);
  });

  it('returns ok on a clean call', async () => {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying({ result: '0x' }),
    });
    expect(await rpc.simulateCall(tx)).toEqual({ ok: true });
  });

  it('throws RpcError on a transport failure so the caller can fail open', async () => {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying(new Error('socket hang up')),
    });
    await expect(rpc.simulateCall(tx)).rejects.toBeInstanceOf(RpcError);
  });

  it('treats a non-revert node error as a transport failure', async () => {
    const rpc = new EvmRpc({
      url: 'http://rpc',
      chainId: 46630,
      fetchImpl: rpcReplying({ error: { code: -32005, message: 'rate limited' } }),
    });
    await expect(rpc.simulateCall(tx)).rejects.toBeInstanceOf(RpcError);
  });
});

describe('SolanaRpc transaction reads', () => {
  function legacyTxBase64(): { base64: string; message: string } {
    const payer = Keypair.generate();
    const t = new Transaction({
      feePayer: payer.publicKey,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
    t.sign(payer);
    return {
      base64: t.serialize().toString('base64'),
      message: t.compileMessage().serialize().toString('base64'),
    };
  }

  it('reports a landed-but-failed transaction as failed', async () => {
    const { base64, message } = legacyTxBase64();
    const rpc = new SolanaRpc({
      url: 'http://rpc',
      fetchImpl: rpcReplying({
        result: {
          transaction: [base64, 'base64'],
          meta: { err: { InstructionError: [0, { Custom: 6008 }] } },
        },
      }),
    });
    expect(await rpc.getTransactionOutcome('sig')).toEqual({
      messageBase64: message,
      failed: true,
    });
  });

  it('reports a successful transaction as not failed', async () => {
    const { base64, message } = legacyTxBase64();
    const rpc = new SolanaRpc({
      url: 'http://rpc',
      fetchImpl: rpcReplying({ result: { transaction: [base64, 'base64'], meta: { err: null } } }),
    });
    expect(await rpc.getTransactionOutcome('sig')).toEqual({
      messageBase64: message,
      failed: false,
    });
    expect(await rpc.getTransactionMessageBase64('sig')).toBe(message);
  });

  it('turns a simulateTransaction error into a result carrying the program logs', async () => {
    const rpc = new SolanaRpc({
      url: 'http://rpc',
      fetchImpl: rpcReplying({
        result: {
          value: {
            err: { InstructionError: [2, { Custom: 6008 }] },
            logs: ['Program log: AnchorError occurred. Error Code: OracleStale.'],
          },
        },
      }),
    });
    const res = await rpc.simulateTransaction('AAAA');
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : mapLaunchFailure(res.reason, 'SOL').error).toBe('oracle_stale');
  });
});
