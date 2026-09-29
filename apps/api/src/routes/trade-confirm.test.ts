import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type AbiEvent,
  type Address,
} from 'viem';
import { applyBuy, buyQuote, mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import { candles, tokens, trades } from '../db/schema.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import { TRADE_FILL_EVENTS_ABI, type FillPayload } from '../chain/trade-fills.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';

/**
 * `POST /trade/confirm`'s fast path, against fake RPC receipts shaped like the
 * one measured on Base Sepolia for MEMEMAN (tx 0x0df81a74…): a routed buy
 * whose launchpad `Trade` names the router and whose `AtomicBuy` names the
 * wallet, surrounded by WETH / ERC-20 `Transfer`s.
 */

const LAUNCHPAD = getAddress('0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35');
const ROUTER = getAddress('0xA947241914E934e6A77480a49a7ea09C2d09Ca9C');
const WETH = getAddress('0x4200000000000000000000000000000000000006');
const MINT = getAddress('0x847eb6311333f8F7F2cd0E9A89379214302aB2c9');
const TRADER = getAddress('0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca');
const SOL_PROGRAM = 'FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg';
const SOL_MINT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_TRADER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';
const BLOCK = 47_458_986;
const BLOCK_MS = 1_790_686_260_000;

let h: TestApp;
const frames: { channel: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
  h = await createTestApp({
    env: {
      BASE_LAUNCHPAD_ADDRESS: LAUNCHPAD,
      BASE_ROUTER_ADDRESS: ROUTER,
      SOLANA_LAUNCHPAD_PROGRAM_ID: SOL_PROGRAM,
    },
  });
  const record = (message: string, channel: string): void => {
    frames.push({ channel, data: JSON.parse(message) as Record<string, unknown> });
  };
  await h.redis.psubscribe('token:*', record);
  await h.redis.subscribe('tape', record);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  frames.length = 0;
});

/* ------------------------------------------------------------- fixtures */

interface Curve {
  state: {
    virtualBase: bigint;
    virtualToken: bigint;
    realBase: bigint;
    realToken: bigint;
    k: bigint;
  };
  supplyAtoms: bigint;
  price1e6: bigint;
  baseDecimals: number;
}

async function seed(opts: {
  net: 'BASE' | 'SOL';
  sym: string;
  mint: string;
  baseMint: string;
  baseDecimals: number;
  tokenDecimals: number;
  price1e6: bigint;
}): Promise<Curve> {
  const supply = 1_000_000;
  const supplyAtoms = BigInt(supply) * 10n ** BigInt(opts.tokenDecimals);
  const derived = deriveCurveColumns(
    supplyAtoms,
    opts.price1e6,
    opts.baseDecimals,
    opts.tokenDecimals,
  );
  if (!derived) throw new Error('curve derivation failed');
  const mc =
    Number(mcapUsd1e6(mcapBase(derived.state, supplyAtoms), opts.price1e6, opts.baseDecimals)) /
    1e6;
  await h.deps.db.insert(tokens).values({
    net: opts.net,
    sym: opts.sym,
    name: opts.sym,
    creator: 'Dev',
    mint: opts.mint,
    baseSymbol: opts.net === 'SOL' ? 'SOL' : 'WETH',
    baseMint: opts.baseMint,
    supply,
    feeBps: 200,
    mc,
    lastMc: mc,
    lane: 'new',
    seed: 1,
    launchedAt: new Date(h.now() - 600_000),
    ...derived.columns,
  });
  return {
    state: derived.state,
    supplyAtoms,
    price1e6: opts.price1e6,
    baseDecimals: opts.baseDecimals,
  };
}

function abiOf(name: 'Trade' | 'AtomicBuy' | 'AtomicSell'): AbiEvent {
  return TRADE_FILL_EVENTS_ABI.find((e) => e.name === name) as AbiEvent;
}

function evmLog(
  name: 'Trade' | 'AtomicBuy' | 'AtomicSell',
  args: Record<string, unknown>,
  address: string,
  logIndex: number,
) {
  const abi = abiOf(name);
  const topics = encodeEventTopics({
    abi: [abi],
    eventName: name,
    args: Object.fromEntries(
      abi.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]),
    ) as never,
  }) as string[];
  const data = encodeAbiParameters(
    abi.inputs.filter((i) => !i.indexed),
    abi.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]) as never,
  );
  return { address: address.toLowerCase(), topics, data, logIndex: `0x${logIndex.toString(16)}` };
}

/** An unrelated ERC-20 `Transfer`, as every real buy receipt carries. */
const TRANSFER_LOG = {
  address: WETH.toLowerCase(),
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    `0x${'0'.repeat(24)}${TRADER.slice(2).toLowerCase()}`,
    `0x${'0'.repeat(24)}${LAUNCHPAD.slice(2).toLowerCase()}`,
  ],
  data: `0x${(10n ** 16n).toString(16).padStart(64, '0')}`,
  logIndex: '0xd',
};

function buyFixture(curve: Curve, baseIn: bigint) {
  const fill = buyQuote(curve.state, 200, baseIn);
  if (!fill) throw new Error('buy quote failed');
  const after = applyBuy(curve.state, fill);
  const mc =
    Number(
      mcapUsd1e6(
        mcapBase({ ...after, realBase: 0n, realToken: 0n }, curve.supplyAtoms),
        curve.price1e6,
        curve.baseDecimals,
      ),
    ) / 1e6;
  return { fill, after, mc };
}

function tradeArgs(fx: ReturnType<typeof buyFixture>, trader: Address): Record<string, unknown> {
  return {
    token: MINT,
    trader,
    isBuy: true,
    baseAmount: fx.fill.grossBase,
    tokenAmount: fx.fill.tokensOut,
    effFeeBps: 200,
    inCashback: false,
    feeTotal: fx.fill.fee,
    feeProtocol: 0n,
    feeOps: 0n,
    feeBurn: 0n,
    feeCreatorBucket: 0n,
    feeStakers: 0n,
    feeCreator: 0n,
    cashbackTokens: 0n,
    virtualBase: fx.after.virtualBase,
    virtualToken: fx.after.virtualToken,
    realBase: fx.after.realBase,
    realToken: fx.after.realToken,
  };
}

function hash(seed: string): string {
  return `0x${seed.repeat(64).slice(0, 64)}`;
}

async function confirm(token: string, body: Record<string, unknown>) {
  const res = await h.app.request('/trade/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      ok?: boolean;
      error?: string;
      pending?: boolean;
      provisional?: boolean;
      final?: boolean;
      fills?: FillPayload[];
    },
  };
}

function fillFrames(channel: string): Record<string, unknown>[] {
  return frames
    .filter((f) => f.channel === channel && f.data['type'] === 'fill')
    .map((f) => f.data['payload'] as Record<string, unknown>);
}

async function seedBase(): Promise<Curve> {
  return seed({
    net: 'BASE',
    sym: 'MEMEMAN',
    mint: MINT,
    baseMint: WETH,
    baseDecimals: 18,
    tokenDecimals: 18,
    price1e6: 2_736_600_000n,
  });
}

/* ---------------------------------------------------------------- EVM */

describe('POST /trade/confirm — EVM fast path', () => {
  it('decodes the routed buy, publishes it provisionally, and writes no read table', async () => {
    const curve = await seedBase();
    const fx = buyFixture(curve, 10n ** 16n);
    const tx = hash('0d');
    h.rpcs.BASE.setEvmReceipt(tx, {
      status: 'success',
      from: '0xc066ac5d385419b1a8c43a0e146fa439837a8b8c', // a relayer, as measured
      to: '0xdb9b1e94b5b69df7e401ddbede43491141047db3',
      input: '0x',
      blockNumber: BLOCK,
      logs: [
        TRANSFER_LOG,
        evmLog('Trade', tradeArgs(fx, ROUTER), LAUNCHPAD, 15),
        evmLog(
          'AtomicBuy',
          {
            trader: TRADER,
            token: MINT,
            ethIn: 10n ** 16n,
            baseFromAggregator: 0n,
            tokensOut: fx.fill.tokensOut,
          },
          ROUTER,
          20,
        ),
      ],
    });
    h.rpcs.BASE.setBlockTime(BLOCK, BLOCK_MS);
    const { token } = await h.login('BASE');

    const res = await confirm(token, { sym: 'MEMEMAN', mint: MINT, signature: tx });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(false);
    expect(res.body.provisional).toBe(true);
    const [fill] = res.body.fills ?? [];
    expect(fill).toMatchObject({
      t: BLOCK_MS,
      sym: 'MEMEMAN',
      net: 'BASE',
      mint: MINT,
      buy: true,
      w: TRADER, // AtomicBuy.trader — Trade.trader is the router
      sig: tx,
      fid: `${tx}:0`,
      cb: false,
    });
    expect(fill!.sol).toBeCloseTo(Number(fx.fill.grossBase) / 1e18, 12); // WETH base: exact
    expect(fill!.tok).toBeCloseTo(Number(fx.fill.tokensOut) / 1e18, 9);
    expect(fill!.mc).toBeCloseTo(fx.mc, 6);

    const tokenFrames = fillFrames('token:MEMEMAN');
    expect(tokenFrames).toEqual([{ ...fill, provisional: true }]);
    expect(fillFrames('tape')).toEqual([{ ...fill, provisional: true }]);
    const curveFrame = frames.find(
      (f) => f.channel === 'token:MEMEMAN' && f.data['type'] === 'curve',
    );
    expect(curveFrame?.data).toMatchObject({ mc: fill!.mc, lane: 'new', provisional: true });

    // Display-only: every aggregate stays the indexer's to write.
    expect(await h.deps.db.select().from(trades)).toHaveLength(0);
    expect(await h.deps.db.select().from(candles)).toHaveLength(0);
  });

  it('only trusts a Trade from the launchpad and a router leg from the router', async () => {
    const curve = await seedBase();
    const fx = buyFixture(curve, 10n ** 16n);
    const spoofed = hash('5a');
    h.rpcs.BASE.setEvmReceipt(spoofed, {
      status: 'success',
      from: TRADER,
      to: ROUTER,
      input: '0x',
      blockNumber: BLOCK,
      logs: [
        evmLog('Trade', tradeArgs(fx, TRADER), '0x000000000000000000000000000000000000bEEF', 1),
      ],
    });
    const { token } = await h.login('BASE');
    const a = await confirm(token, { sym: 'MEMEMAN', signature: spoofed });
    expect(a.status).toBe(200);
    expect(a.body.fills).toEqual([]);
    expect(frames).toHaveLength(0);

    const fakeRouter = hash('5b');
    h.rpcs.BASE.setEvmReceipt(fakeRouter, {
      status: 'success',
      from: TRADER,
      to: ROUTER,
      input: '0x',
      blockNumber: BLOCK,
      logs: [
        evmLog('Trade', tradeArgs(fx, ROUTER), LAUNCHPAD, 1),
        evmLog(
          'AtomicBuy',
          { trader: TRADER, token: MINT, ethIn: 1n, baseFromAggregator: 0n, tokensOut: 1n },
          '0x000000000000000000000000000000000000bEEF',
          2,
        ),
      ],
    });
    const b = await confirm(token, { sym: 'MEMEMAN', signature: fakeRouter });
    // The foreign AtomicBuy is ignored, so the fill stays attributed to the
    // launchpad's trader (the router) — exactly what the indexer would record.
    expect(b.body.fills?.[0]?.w).toBe(ROUTER);
  });

  it('broadcasts once per transaction however often the client confirms', async () => {
    const curve = await seedBase();
    const fx = buyFixture(curve, 10n ** 16n);
    const tx = hash('1d');
    h.rpcs.BASE.setEvmReceipt(tx, {
      status: 'success',
      from: TRADER,
      to: ROUTER,
      input: '0x',
      blockNumber: BLOCK,
      logs: [evmLog('Trade', tradeArgs(fx, TRADER), LAUNCHPAD, 3)],
    });
    const { token } = await h.login('BASE');
    const first = await confirm(token, { sym: 'MEMEMAN', signature: tx });
    const second = await confirm(token, {
      sym: 'MEMEMAN',
      txHash: tx.toUpperCase().replace('0X', '0x'),
    });
    expect(first.body.provisional).toBe(true);
    expect(second.body.provisional).toBe(false);
    expect(second.body.fills).toEqual(first.body.fills);
    expect(fillFrames('token:MEMEMAN')).toHaveLength(1);
    expect(fillFrames('tape')).toHaveLength(1);
  });

  it('stays silent once the indexer has recorded the transaction', async () => {
    const curve = await seedBase();
    const fx = buyFixture(curve, 10n ** 16n);
    const tx = hash('2d');
    h.rpcs.BASE.setEvmReceipt(tx, {
      status: 'success',
      from: TRADER,
      to: ROUTER,
      input: '0x',
      blockNumber: BLOCK,
      logs: [evmLog('Trade', tradeArgs(fx, TRADER), LAUNCHPAD, 3)],
    });
    await h.deps.db.insert(trades).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MINT,
      txSig: tx,
      logIndex: 3,
      side: 'buy',
      trader: TRADER,
      nativeAmount: 0.01,
      baseAmount: 0.01,
      tokenAmount: 1,
      usdValue: 27,
      mc: fx.mc,
      price: 1,
      cashback: false,
      blockTime: new Date(BLOCK_MS),
      chainPosition: BLOCK,
    });
    const { token } = await h.login('BASE');
    const res = await confirm(token, { sym: 'MEMEMAN', signature: tx });
    expect(res.body.final).toBe(true);
    expect(res.body.provisional).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('reports pending while the node has no receipt, and 422 for a revert', async () => {
    await seedBase();
    const { token } = await h.login('BASE');
    const pending = await confirm(token, { sym: 'MEMEMAN', signature: hash('3d') });
    expect(pending.status).toBe(200);
    expect(pending.body.pending).toBe(true);
    expect(pending.body.fills).toEqual([]);

    const reverted = hash('4d');
    h.rpcs.BASE.setEvmReceipt(reverted, { status: 'reverted', to: ROUTER, input: '0x', logs: [] });
    const res = await confirm(token, { sym: 'MEMEMAN', signature: reverted });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tx_reverted');
    expect(frames).toHaveLength(0);
  });

  it('ignores a fill for a token this deployment does not list', async () => {
    const curve = await seedBase();
    const fx = buyFixture(curve, 10n ** 16n);
    const tx = hash('6d');
    h.rpcs.BASE.setEvmReceipt(tx, {
      status: 'success',
      from: TRADER,
      to: ROUTER,
      input: '0x',
      blockNumber: BLOCK,
      logs: [
        evmLog(
          'Trade',
          { ...tradeArgs(fx, TRADER), token: getAddress(`0x${'77'.repeat(20)}`) },
          LAUNCHPAD,
          3,
        ),
      ],
    });
    const { token } = await h.login('BASE');
    const res = await confirm(token, { sym: 'MEMEMAN', signature: tx });
    expect(res.body.fills).toEqual([]);
    expect(frames).toHaveLength(0);
  });

  it('requires a session', async () => {
    const res = await h.app.request('/trade/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sym: 'MEMEMAN', signature: hash('7d') }),
    });
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------- Solana */

function borshTrade(f: {
  mint: string;
  trader: string;
  baseAmount: bigint;
  tokenAmount: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  realBase: bigint;
  realToken: bigint;
}): Buffer {
  const u64 = (n: bigint): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const u128 = (n: bigint): Buffer => Buffer.concat([u64(n & (2n ** 64n - 1n)), u64(n >> 64n)]);
  const u16 = Buffer.alloc(2);
  u16.writeUInt16LE(300);
  return Buffer.concat([
    Buffer.from(sha256('event:Trade')).subarray(0, 8),
    Buffer.from(bs58.decode(f.mint)),
    Buffer.from(bs58.decode(f.trader)),
    Buffer.from([1]), // isBuy
    u64(f.baseAmount),
    u64(f.tokenAmount),
    u16,
    Buffer.from([0]), // inCashback
    ...Array.from({ length: 8 }, () => u64(0n)), // fee legs, cashback tokens
    u128(f.virtualBase),
    u128(f.virtualToken),
    u64(f.realBase),
    u64(f.realToken),
    u64(0n), // circulating
    u64(1_790_686_260n), // ts (i64, positive)
  ]);
}

describe('POST /trade/confirm — Solana fast path', () => {
  it('decodes Program data from the launchpad frame only, at confirmed', async () => {
    const curve = await seed({
      net: 'SOL',
      sym: 'DOGGO',
      mint: SOL_MINT,
      baseMint: WSOL,
      baseDecimals: 9,
      tokenDecimals: 6,
      price1e6: 214_080_000n,
    });
    const fill = buyQuote(curve.state, 300, 2_000_000_000n)!;
    const after = applyBuy(curve.state, fill);
    const payload = borshTrade({
      mint: SOL_MINT,
      trader: SOL_TRADER,
      baseAmount: fill.grossBase,
      tokenAmount: fill.tokensOut,
      virtualBase: after.virtualBase,
      virtualToken: after.virtualToken,
      realBase: after.realBase,
      realToken: after.realToken,
    }).toString('base64');
    const sig = '4'.repeat(88);
    h.rpcs.SOL.setSolanaTransactionLogs(sig, {
      slot: 1_234,
      blockTimeMs: 1_790_686_260_000,
      failed: false,
      logMessages: [
        `Program ${SOL_PROGRAM} invoke [1]`,
        `Program data: ${payload}`,
        'Program Evil111111111111111111111111111111111111 invoke [2]',
        `Program data: ${payload}`,
        'Program Evil111111111111111111111111111111111111 success',
        `Program ${SOL_PROGRAM} success`,
      ],
      innerInstructions: [],
      accountKeys: [],
    });
    const { token } = await h.login('SOL');
    const res = await confirm(token, { sym: 'DOGGO', mint: SOL_MINT, signature: sig });
    expect(res.status).toBe(200);
    expect(res.body.fills).toHaveLength(1);
    expect(res.body.fills?.[0]).toMatchObject({
      net: 'SOL',
      sym: 'DOGGO',
      w: SOL_TRADER,
      sig,
      fid: `${sig}:0`,
      t: 1_790_686_260_000,
    });
    expect(res.body.fills?.[0]?.sol).toBeCloseTo(Number(fill.grossBase) / 1e9, 12);
    expect(fillFrames('token:DOGGO')).toHaveLength(1);
  });

  it('refuses a failed transaction', async () => {
    await seed({
      net: 'SOL',
      sym: 'DOGGO',
      mint: SOL_MINT,
      baseMint: WSOL,
      baseDecimals: 9,
      tokenDecimals: 6,
      price1e6: 214_080_000n,
    });
    const sig = '3'.repeat(88);
    h.rpcs.SOL.setSolanaTransactionLogs(sig, {
      slot: 1,
      blockTimeMs: null,
      failed: true,
      logMessages: [],
      innerInstructions: [],
      accountKeys: [],
    });
    const { token } = await h.login('SOL');
    const res = await confirm(token, { sym: 'DOGGO', signature: sig });
    expect(res.status).toBe(422);
  });
});
