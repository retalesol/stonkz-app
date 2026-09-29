import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import type { StakePoolSummary, TokenFees } from '@stonkz/shared';
import { LAUNCHPAD_ABI } from '../router/evm-abi.js';
import { COINS_WORD, STAKE_VIEW_ABI } from '../chain/stake-reads.js';
import { creatorVaults, stakePositions, tokens } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { invalidateStakePool, type StakePositionView } from './stake-data.js';

/**
 * The stake read path on BASE, against a fake RPC that answers the
 * launchpad's `positionInfo`, `pendingStakeRewards` and `coins` views.
 *
 * Mirrors the MEMEMAN report: a FLEX stake of 6,182 tokens that succeeded on
 * chain while the dialog showed nothing.
 */

const LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const MEMEMAN = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const E18 = 10n ** 18n;
const T0 = Date.parse('2026-09-06T12:00:00.000Z');
const T0_S = BigInt(Math.floor(T0 / 1000));

interface FakePosition {
  amount: bigint;
  weight: bigint;
  lockDays: number;
  lockUntil: bigint;
  pendingBase: bigint;
  pendingToken: bigint;
}

interface FakePool {
  eligibleStaked: bigint;
  flexStaked: bigint;
  totalWeight: bigint;
  stakerAccruedBase: bigint;
  tokensForSale: bigint;
  realToken: bigint;
}

let h: TestApp;
let chain: { position: FakePosition | null; pool: FakePool | null; calls: string[] };

function coinsWords(pool: FakePool): string {
  const words = new Array<bigint>(38).fill(0n);
  words[0] = BigInt(MEMEMAN);
  words[COINS_WORD.tokensForSale] = pool.tokensForSale;
  words[COINS_WORD.realToken] = pool.realToken;
  words[COINS_WORD.eligibleStaked] = pool.eligibleStaked;
  words[COINS_WORD.flexStaked] = pool.flexStaked;
  words[COINS_WORD.totalWeight] = pool.totalWeight;
  words[COINS_WORD.stakerAccruedBase] = pool.stakerAccruedBase;
  return '0x' + words.map((w) => w.toString(16).padStart(64, '0')).join('');
}

function launchpad(data: string): string {
  const selector = data.slice(0, 10);
  try {
    const call = decodeFunctionData({ abi: STAKE_VIEW_ABI, data: data as Hex });
    chain.calls.push(call.functionName);
    const p = chain.position;
    if (!p) return '0x';
    if (call.functionName === 'positionInfo') {
      return encodeFunctionResult({
        abi: STAKE_VIEW_ABI,
        functionName: 'positionInfo',
        result: {
          amount: p.amount,
          weight: p.weight,
          baseDebt: 0n,
          tokenDebt: 0n,
          unclaimedBase: p.pendingBase,
          unclaimedToken: p.pendingToken,
          lockUntil: p.lockUntil,
          lockDays: p.lockDays,
        },
      });
    }
    return encodeFunctionResult({
      abi: STAKE_VIEW_ABI,
      functionName: 'pendingStakeRewards',
      result: [p.pendingBase, p.pendingToken],
    });
  } catch {
    // Not a position view: `coins(address)`.
    chain.calls.push(`coins:${selector}`);
    return chain.pool ? coinsWords(chain.pool) : '0x';
  }
}

beforeAll(async () => {
  h = await createTestApp({ env: { BASE_LAUNCHPAD_ADDRESS: LAUNCHPAD } });
  h.rpcs.BASE.setContract(LAUNCHPAD, launchpad);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.setNow(T0);
  invalidateStakePool(h.deps, 'BASE', MEMEMAN);
  chain = { position: null, pool: null, calls: [] };
  await h.deps.db.insert(tokens).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    name: 'Meme Man',
    creator: '0x00000000000000000000000000000000000000c1',
    mint: MEMEMAN,
    baseSymbol: 'WETH',
    baseMint: WETH_BASE,
    supply: 1_000_000_000,
    feeBps: 100,
    seed: 7,
    tokenDecimals: 18,
    baseDecimals: 18,
    curveTokensForSale: (800_000_000n * E18).toString(),
    // 100,000 tokens sold off the curve.
    curveRealToken: ((800_000_000n - 100_000n) * E18).toString(),
  });
});

async function authed(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return h.app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

const flex6182 = (): FakePosition => ({
  amount: 6182n * E18,
  weight: 0n,
  lockDays: 0,
  lockUntil: T0_S - 60n,
  pendingBase: 0n,
  pendingToken: 0n,
});

describe('GET /stake/:sym (indexer)', () => {
  it('requires a session', async () => {
    expect((await h.app.request('/stake/MEMEMAN')).status).toBe(401);
    expect((await h.app.request('/stake/MEMEMAN/chain')).status).toBe(401);
  });

  it('returns an empty position when nothing is indexed', async () => {
    const { token } = await h.login('BASE');
    const body = (await (
      await authed(`/stake/MEMEMAN?mint=${MEMEMAN}`, token)
    ).json()) as StakePositionView;
    expect(body).toMatchObject({
      amt: 0,
      days: 0,
      eligible: false,
      source: 'indexer',
      mint: MEMEMAN,
    });
  });

  it("finds a FLEX row whatever the wallet's casing, with FLEX's zero weight", async () => {
    const { token, address } = await h.login('BASE');
    await h.deps.db.insert(stakePositions).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MEMEMAN,
      wallet: address.toLowerCase(),
      amount: 6182,
      lockDays: 0,
      mult: 0,
      untilMs: T0 - 60_000,
    });
    const body = (await (await authed('/stake/MEMEMAN', token)).json()) as StakePositionView;
    expect(body).toMatchObject({
      amt: 6182,
      days: 0,
      mult: 0,
      weight: 0,
      eligible: false,
      source: 'indexer',
    });
  });
});

describe('GET /stake/:sym/chain', () => {
  it('reads the position on chain before the indexer has it', async () => {
    const { token } = await h.login('BASE');
    chain.position = flex6182();
    const res = await authed(`/stake/MEMEMAN/chain?mint=${MEMEMAN}`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StakePositionView;
    expect(body).toMatchObject({
      amt: 6182,
      days: 0,
      mult: 0,
      weight: 0,
      until: Number(T0_S - 60n) * 1000,
      rewBase: 0,
      baseSym: 'WETH',
      eligible: false,
      source: 'chain',
      amtAtoms: (6182n * E18).toString(),
    });
    expect(chain.calls).toEqual(expect.arrayContaining(['positionInfo', 'pendingStakeRewards']));
  });

  it('reports a lock, its weight and pending rewards in base and native', async () => {
    const { token } = await h.login('BASE');
    chain.position = {
      amount: 1000n * E18,
      weight: 1500n * E18,
      lockDays: 30,
      lockUntil: T0_S + 30n * 86_400n,
      pendingBase: E18 / 1000n,
      pendingToken: 2n * E18,
    };
    const body = (await (await authed('/stake/MEMEMAN/chain', token)).json()) as StakePositionView;
    expect(body).toMatchObject({
      amt: 1000,
      mult: 1.5,
      weight: 1500,
      days: 30,
      eligible: true,
      rewTok: 2,
    });
    expect(body.rewBase).toBeCloseTo(0.001, 12);
    // WETH is the native wrapper on BASE, so the native figure is exact.
    expect(body.rewSol).toBeCloseTo(0.001, 12);
  });

  it('falls back to the indexer row when the chain cannot answer', async () => {
    const { token, address } = await h.login('BASE');
    await h.deps.db.insert(stakePositions).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MEMEMAN,
      wallet: address,
      amount: 42,
      lockDays: 7,
      mult: 1.25,
      untilMs: T0 + 1,
    });
    chain.position = null; // launchpad answers `0x`
    const body = (await (await authed('/stake/MEMEMAN/chain', token)).json()) as StakePositionView;
    expect(body).toMatchObject({ amt: 42, source: 'indexer', mult: 1.25 });
  });
});

describe('POST /stake/unstake/prepare and /stake/claim/prepare', () => {
  it('refuses an unstake while the lock runs', async () => {
    const { token } = await h.login('BASE');
    chain.position = { ...flex6182(), lockDays: 7, weight: 1n, lockUntil: T0_S + 3600n };
    const res = await authed('/stake/unstake/prepare', token, {
      method: 'POST',
      body: JSON.stringify({ sym: 'MEMEMAN', mint: MEMEMAN, amount: 10 }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('still_locked');
  });

  it('builds an unstake-all for the exact on-chain atoms', async () => {
    const { token } = await h.login('BASE');
    chain.position = { ...flex6182(), amount: 6182n * E18 + 123n };
    const res = await authed('/stake/unstake/prepare', token, {
      method: 'POST',
      body: JSON.stringify({ sym: 'MEMEMAN', mint: MEMEMAN, amount: 6182 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { to: string; data: Hex };
    expect(body.to.toLowerCase()).toBe(LAUNCHPAD.toLowerCase());
    const call = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: body.data });
    expect(call.functionName).toBe('unstake');
    expect(call.args).toEqual([MEMEMAN, 6182n * E18 + 123n]);
  });

  it('refuses an unstake larger than the position', async () => {
    const { token } = await h.login('BASE');
    chain.position = flex6182();
    const res = await authed('/stake/unstake/prepare', token, {
      method: 'POST',
      body: JSON.stringify({ sym: 'MEMEMAN', mint: MEMEMAN, amount: 7000 }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('insufficient_stake');
  });

  it('refuses an empty claim and builds a real one', async () => {
    const { token } = await h.login('BASE');
    chain.position = flex6182();
    const empty = await authed('/stake/claim/prepare', token, {
      method: 'POST',
      body: JSON.stringify({ sym: 'MEMEMAN', mint: MEMEMAN }),
    });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { error: string }).error).toBe('nothing_to_claim');

    chain.position = { ...flex6182(), lockDays: 30, weight: 1n, pendingBase: 5n };
    const ok = await authed('/stake/claim/prepare', token, {
      method: 'POST',
      body: JSON.stringify({ sym: 'MEMEMAN', mint: MEMEMAN }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: Hex };
    const call = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: body.data });
    expect(call.functionName).toBe('claimStake');
    expect(call.args).toEqual([MEMEMAN]);
  });
});

describe('GET /tokens/:sym/staking and the Fees tab', () => {
  it('reads a fresh pool on chain when nothing is indexed yet', async () => {
    chain.pool = {
      eligibleStaked: 0n,
      flexStaked: 6182n * E18,
      totalWeight: 0n,
      stakerAccruedBase: 0n,
      tokensForSale: 800_000_000n * E18,
      realToken: (800_000_000n - 100_000n) * E18,
    };
    const res = await h.app.request(`/tokens/MEMEMAN/staking?net=BASE&mint=${MEMEMAN}`);
    expect(res.status).toBe(200);
    const pool = (await res.json()) as StakePoolSummary;
    expect(pool).toMatchObject({
      totalStaked: 6182,
      eligibleStaked: 0,
      flexStaked: 6182,
      stakers: 1,
      circulating: 100_000,
      bucketShare: 0,
      feeShare: 0,
      source: 'chain',
    });
    expect(pool.stakedFrac).toBeCloseTo(0.06182, 9);
  });

  it('sums an indexed pool and scales the bucket share by eligible stake', async () => {
    await h.deps.db.insert(stakePositions).values([
      {
        net: 'BASE',
        sym: 'MEMEMAN',
        mint: MEMEMAN,
        wallet: '0xA',
        amount: 10_000,
        lockDays: 30,
        mult: 1.5,
        updatedAt: new Date(T0 - 3_600_000),
      },
      {
        net: 'BASE',
        sym: 'MEMEMAN',
        mint: MEMEMAN,
        wallet: '0xB',
        amount: 6_182,
        lockDays: 0,
        mult: 0,
        updatedAt: new Date(T0 - 3_600_000),
      },
      {
        net: 'BASE',
        sym: 'MEMEMAN',
        mint: MEMEMAN,
        wallet: '0xC',
        amount: 0,
        lockDays: 7,
        mult: 1.25,
        updatedAt: new Date(T0 - 3_600_000),
      },
    ]);
    await h.deps.db.insert(creatorVaults).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MEMEMAN,
      creator: '0x00000000000000000000000000000000000000c1',
      stakerPoolNative: 0.25,
      lifetimeNative: 1,
    });
    const fees = (await (
      await h.app.request(`/tokens/MEMEMAN/fees?net=BASE&mint=${MEMEMAN}`)
    ).json()) as TokenFees;
    expect(fees.staking).toMatchObject({
      totalStaked: 16_182,
      eligibleStaked: 10_000,
      flexStaked: 6_182,
      totalWeight: 15_000,
      stakers: 2,
      circulating: 100_000,
      lifetimeNative: 0.25,
      source: 'indexer',
    });
    // 10,000 eligible of 100,000 circulating: 5% of the bucket, 3.45% of the fee.
    expect(fees.staking?.bucketShare).toBeCloseTo(0.05, 12);
    expect(fees.staking?.feeShare).toBeCloseTo(0.0345, 12);
    // Old indexed pool: no chain read spent on it.
    expect(chain.calls.filter((c) => c.startsWith('coins'))).toHaveLength(0);
  });

  it('prefers the chain for a pool that just changed, and caches it briefly', async () => {
    await h.deps.db.insert(stakePositions).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      mint: MEMEMAN,
      wallet: '0xA',
      amount: 1_000,
      lockDays: 30,
      mult: 1.5,
      updatedAt: new Date(T0 - 5_000),
    });
    chain.pool = {
      eligibleStaked: 3_000n * E18,
      flexStaked: 0n,
      totalWeight: 4_500n * E18,
      stakerAccruedBase: E18 / 100n,
      tokensForSale: 800_000_000n * E18,
      realToken: (800_000_000n - 100_000n) * E18,
    };
    const first = (await (
      await h.app.request(`/tokens/MEMEMAN/staking?net=BASE&mint=${MEMEMAN}`)
    ).json()) as StakePoolSummary;
    expect(first).toMatchObject({
      eligibleStaked: 3_000,
      totalWeight: 4_500,
      stakers: 1,
      source: 'chain',
    });
    expect(first.lifetimeBase).toBeCloseTo(0.01, 12);
    await h.app.request(`/tokens/MEMEMAN/staking?net=BASE&mint=${MEMEMAN}`);
    expect(chain.calls.filter((c) => c.startsWith('coins'))).toHaveLength(1);
  });
});
