import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { encodeFunctionResult, toFunctionSelector } from 'viem';
import { DEFAULT_CURVE_PARAMS, packParamsWord } from '@stonkz/shared';
import { solanaParamsPda } from '../admin/chain-ops.js';
import { JsonRpcError } from './jsonrpc.js';
import {
  CurveParamsReader,
  LAUNCHPAD_PARAMS_ABI,
  ROUTER_CONFIG_ABI,
  curveParamsTargets,
  decodeParamsWord,
  matchesDefaultParams,
  toCurveParams,
  type ParamsTarget,
} from './params.js';
import { readEnv } from '../env.js';
import { createFakeRpcs } from './fake.js';

const LAUNCHPAD = '0xe308287C9A85E2B53F1027a1c589B5e3969928e8';
const ROUTER = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const PARAMS_SEL = toFunctionSelector('paramsWord()');
const MAXBUY_SEL = toFunctionSelector('maxBuyNative()');

const wordResult = (w: bigint): string =>
  encodeFunctionResult({ abi: LAUNCHPAD_PARAMS_ABI, functionName: 'paramsWord', result: w });
const capResult = (v: bigint): string =>
  encodeFunctionResult({ abi: ROUTER_CONFIG_ABI, functionName: 'maxBuyNative', result: v });

/** A fake `eth_call` keyed by (address, selector), counting calls. */
function fakeEth(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  return {
    calls,
    eth: {
      async ethCall(to: string, data: string): Promise<string> {
        const key = `${to.toLowerCase()}:${data.slice(0, 10)}`;
        calls.push(key);
        const a = answers[key];
        if (a instanceof Error) throw a;
        return a ?? '0x';
      },
    },
  };
}

const CUSTOM = {
  ...DEFAULT_CURVE_PARAMS,
  feeProtocolBps: 2000,
  feeOpsBps: 500,
  feeBurnBps: 500,
  maxFeeBps: 300,
  cbWindowSecs: 120,
  gradUsd: 100_000,
  maxSupply: 1e9,
};

describe('CurveParamsReader — EVM', () => {
  it('decodes the packed word and the router cap', async () => {
    const { eth, calls } = fakeEth({
      [`${LAUNCHPAD.toLowerCase()}:${PARAMS_SEL}`]: wordResult(packParamsWord(CUSTOM)),
      [`${ROUTER.toLowerCase()}:${MAXBUY_SEL}`]: capResult(5n * 10n ** 18n),
    });
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: ROUTER }),
      now: () => 1_000,
    });
    const p = await r.get('RH');
    expect(p.source).toBe('chain');
    expect(p.set).toBe(true);
    expect(p.matchesDefaults).toBe(false);
    expect(p.error).toBeNull();
    expect(p.readAt).toBe(1_000);
    expect(toCurveParams(p)).toEqual({ ...CUSTOM, maxBuyNative: '5000000000000000000' });
    expect(calls).toHaveLength(2);
  });

  it('reads a zero word as the contract defaults, still from chain', async () => {
    const { eth } = fakeEth({
      [`${LAUNCHPAD.toLowerCase()}:${PARAMS_SEL}`]: wordResult(0n),
      [`${ROUTER.toLowerCase()}:${MAXBUY_SEL}`]: capResult(0n),
    });
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: ROUTER }),
    });
    const p = await r.get('BASE');
    expect(p.source).toBe('chain');
    expect(p.set).toBe(false);
    expect(p.matchesDefaults).toBe(true);
    expect(toCurveParams(p)).toEqual(DEFAULT_CURVE_PARAMS);
  });

  it('falls back to the defaults when paramsWord() answers empty (pre-params implementation)', async () => {
    const { eth } = fakeEth({
      [`${ROUTER.toLowerCase()}:${MAXBUY_SEL}`]: capResult(10n ** 18n),
    });
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: ROUTER }),
    });
    const p = await r.get('RH');
    expect(p.source).toBe('default');
    expect(p.set).toBe(false);
    expect(p.error).toMatch(/predates params/);
    expect(p.gradUsd).toBe(69_000);
    // The old router still answers maxBuyNative(); that part is kept.
    expect(p.maxBuyNative).toBe('1000000000000000000');
  });

  it('treats a node-reported revert as "unknown selector", not an outage', async () => {
    const { eth } = fakeEth({
      [`${LAUNCHPAD.toLowerCase()}:${PARAMS_SEL}`]: new JsonRpcError(3, 'execution reverted'),
      [`${ROUTER.toLowerCase()}:${MAXBUY_SEL}`]: new JsonRpcError(-32000, 'execution reverted'),
    });
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: ROUTER }),
    });
    const p = await r.get('RH');
    expect(p.source).toBe('default');
    expect(p.maxBuyNative).toBe('0');
    expect(p.error).toMatch(/predates params/);
  });

  it('refuses a word that is not a valid record (a fallback that answers any selector)', async () => {
    const { eth } = fakeEth({
      // A 20-byte address where a word should be: every bps field reads as garbage.
      [`${LAUNCHPAD.toLowerCase()}:${PARAMS_SEL}`]: wordResult(BigInt(ROUTER)),
    });
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: null }),
    });
    const p = await r.get('RH');
    expect(p.source).toBe('default');
    expect(p.error).toMatch(/invalid record/);
    expect(toCurveParams(p)).toEqual(DEFAULT_CURVE_PARAMS);
  });

  it('skips the router read when none is configured', async () => {
    const { eth, calls } = fakeEth({
      [`${LAUNCHPAD.toLowerCase()}:${PARAMS_SEL}`]: wordResult(packParamsWord(CUSTOM)),
    });
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: null }),
    });
    const p = await r.get('RH');
    expect(p.maxBuyNative).toBe('0');
    expect(p.gradUsd).toBe(100_000);
    expect(calls).toHaveLength(1);
  });

  it('caches for the TTL, dedupes concurrent reads, and re-reads afterwards', async () => {
    let word = packParamsWord(CUSTOM);
    const calls: string[] = [];
    const eth = {
      async ethCall(_to: string, data: string): Promise<string> {
        calls.push(data.slice(0, 10));
        return data.startsWith(PARAMS_SEL) ? wordResult(word) : capResult(0n);
      },
    };
    let now = 0;
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: ROUTER }),
      now: () => now,
      ttlMs: 60_000,
    });
    const [a, b] = await Promise.all([r.get('RH'), r.get('RH')]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(2);
    word = packParamsWord({ ...CUSTOM, gradUsd: 1 });
    now = 59_999;
    expect((await r.get('RH')).gradUsd).toBe(100_000);
    expect(calls).toHaveLength(2);
    now = 60_000;
    expect((await r.get('RH')).gradUsd).toBe(1);
    expect(calls).toHaveLength(4);
    // Nets are cached independently.
    await r.get('BASE');
    expect(calls).toHaveLength(6);
    r.invalidate('RH');
    await r.get('RH');
    expect(calls).toHaveLength(8);
    await r.get('BASE');
    expect(calls).toHaveLength(8);
  });

  it('serves the last good read through a transport failure, defaults when there was none', async () => {
    let failing = false;
    const eth = {
      async ethCall(_to: string, data: string): Promise<string> {
        if (failing) throw new Error('fetch failed: ECONNRESET');
        return data.startsWith(PARAMS_SEL) ? wordResult(packParamsWord(CUSTOM)) : capResult(7n);
      },
    };
    let now = 0;
    const errors: string[] = [];
    const r = new CurveParamsReader({
      target: () => ({ kind: 'evm', eth, launchpad: LAUNCHPAD, router: ROUTER }),
      now: () => now,
      ttlMs: 1_000,
      onError: (net, err) => errors.push(`${net}:${(err as Error).message}`),
    });
    expect((await r.get('RH')).gradUsd).toBe(100_000);
    failing = true;
    now = 1_000;
    const stale = await r.get('RH');
    expect(stale.gradUsd).toBe(100_000);
    expect(stale.source).toBe('chain');
    expect(stale.maxBuyNative).toBe('7');
    expect(stale.error).toMatch(/^stale: /);
    expect(errors).toEqual(['RH:fetch failed: ECONNRESET']);
    // A net that never read successfully gets the defaults, marked.
    const fresh = await r.get('BASE');
    expect(fresh.source).toBe('default');
    expect(fresh.error).toMatch(/^rpc: /);
  });

  it('is the defaults for an undeployed net and for an RPC without eth_call', async () => {
    const r = new CurveParamsReader({
      target: (net) =>
        net === 'ARC' ? null : { kind: 'evm', eth: null, launchpad: LAUNCHPAD, router: null },
    });
    expect((await r.get('ARC')).error).toBe('not deployed on this environment');
    expect((await r.get('RH')).error).toBe('RPC cannot eth_call');
    const all = await r.all();
    expect(Object.keys(all).sort()).toEqual(['ARC', 'BASE', 'RH', 'SOL']);
  });

  it('decodeParamsWord / matchesDefaultParams', () => {
    expect(decodeParamsWord(wordResult(42n))).toBe(42n);
    expect(() => decodeParamsWord('0x')).toThrow();
    expect(matchesDefaultParams({ ...DEFAULT_CURVE_PARAMS, maxBuyNative: '99' })).toBe(true);
    expect(matchesDefaultParams({ ...DEFAULT_CURVE_PARAMS, gradUsd: 1 })).toBe(false);
  });
});

describe('CurveParamsReader — Solana', () => {
  const programId = Keypair.generate().publicKey;
  const pda = solanaParamsPda(programId).toBase58();

  /** The `Params` account: discriminator, bump, six u16, u32, u64, 64 reserved bytes. */
  function account(p: typeof CUSTOM): string {
    const buf = Buffer.alloc(8 + 1 + 12 + 4 + 8 + 64);
    let o = 8;
    buf[o++] = 254;
    for (const v of [
      p.feeProtocolBps,
      p.feeOpsBps,
      p.feeBurnBps,
      p.minFeeBps,
      p.maxFeeBps,
      p.cbStartFeeBps,
    ]) {
      buf.writeUInt16LE(v, o);
      o += 2;
    }
    buf.writeUInt32LE(p.cbWindowSecs, o);
    o += 4;
    buf.writeBigUInt64LE(BigInt(Math.round(p.gradUsd * 1e6)), o);
    return buf.toString('base64');
  }

  const target = (data: string | null): ParamsTarget => ({
    kind: 'sol',
    reader: {
      async getAccountDataBase64(address: string) {
        return address === pda ? data : null;
      },
    },
    programId: programId.toBase58(),
  });

  it('decodes the params PDA; maxSupply / maxBuyNative stay at the defaults', async () => {
    const r = new CurveParamsReader({ target: () => target(account(CUSTOM)) });
    const p = await r.get('SOL');
    expect(p.source).toBe('chain');
    expect(p.set).toBe(true);
    expect(toCurveParams(p)).toEqual({ ...CUSTOM, maxSupply: 1e12, maxBuyNative: '0' });
  });

  it('is the defaults when the PDA does not exist, from chain when it holds the defaults', async () => {
    const absent = await new CurveParamsReader({ target: () => target(null) }).get('SOL');
    expect(absent.source).toBe('default');
    expect(absent.set).toBe(false);
    expect(absent.error).toMatch(/never set/);
    const explicit = await new CurveParamsReader({
      target: () => target(account({ ...DEFAULT_CURVE_PARAMS })),
    }).get('SOL');
    expect(explicit.source).toBe('chain');
    expect(explicit.set).toBe(true);
    expect(explicit.matchesDefaults).toBe(true);
  });

  it('falls back on an undecodable account and on a reader-less RPC', async () => {
    const short = await new CurveParamsReader({
      target: () => target(Buffer.alloc(12).toString('base64')),
    }).get('SOL');
    expect(short.source).toBe('default');
    expect(short.error).toMatch(/undecodable/);
    const none = await new CurveParamsReader({
      target: () => ({ kind: 'sol', reader: null, programId: programId.toBase58() }),
    }).get('SOL');
    expect(none.error).toBe('RPC cannot read accounts');
  });
});

describe('curveParamsTargets', () => {
  const rpcs = createFakeRpcs();
  const base = { NODE_ENV: 'test', BASE_LAUNCHPAD_ADDRESS: LAUNCHPAD };

  it('resolves SOL to the program by default and to "not deployed" when SOLANA_ENABLED=0', async () => {
    const on = curveParamsTargets(readEnv(base), rpcs);
    expect(on('SOL')).toMatchObject({ kind: 'sol' });
    expect(on('BASE')).toMatchObject({ kind: 'evm', launchpad: LAUNCHPAD });
    // RH has no launchpad in this env either way.
    expect(on('RH')).toBeNull();

    const off = curveParamsTargets(readEnv({ ...base, SOLANA_ENABLED: '0' }), rpcs);
    expect(off('SOL')).toBeNull();
    expect(off('BASE')).toMatchObject({ kind: 'evm', launchpad: LAUNCHPAD });
    expect(off('RH')).toBeNull();

    const r = new CurveParamsReader({ target: off });
    const sol = await r.get('SOL');
    expect(sol).toMatchObject({
      net: 'SOL',
      source: 'default',
      set: false,
      error: 'not deployed on this environment',
    });
    expect(toCurveParams(sol)).toEqual(DEFAULT_CURVE_PARAMS);
  });
});
