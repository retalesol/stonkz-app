import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { tokens } from '../db/schema.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import { FEE_LOCKER_ABI } from '../chain/pool-fees.js';
import { createTestApp, type TestApp } from '../test/app.js';

/**
 * The token page's post-graduation fee surface on EVM: `GET /tokens/:sym`
 * carries `poolFees` for a coin whose liquidity is in the `FeeLocker`, and
 * `POST /tokens/:sym/pool-fees/claim/prepare` hands the wallet the
 * permissionless `claimFees(token)` call. The locker is discovered from the
 * chain (`launchpad.migrator()` → `migrator.locker()`), so a v2 graduation
 * (a migrator with no `locker()`) shows nothing and cannot be "claimed".
 */

const LAUNCHPAD = getAddress('0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35');
const MIGRATOR = getAddress(`0x${'a1'.padStart(40, '0')}`);
const LOCKER = getAddress(`0x${'10c'.padStart(40, '0')}`);
const POOL = getAddress(`0x${'b00'.padStart(40, '0')}`);
const MINT = getAddress(`0x${'6ad'.padStart(40, '0')}`);
const V2_MINT = getAddress(`0x${'6ae'.padStart(40, '0')}`);
const CREATOR = getAddress(`0x${'c4ea7'.padStart(40, '0')}`);
const WETH = '0x4200000000000000000000000000000000000006';

const SEL_MIGRATOR = toFunctionSelector('function migrator()');
const SEL_LOCKER = toFunctionSelector('function locker()');

const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp({ env: { BASE_LAUNCHPAD_ADDRESS: LAUNCHPAD } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
});

async function seed(sym: string, mint: string, poolAddress: string | null): Promise<void> {
  const derived = deriveCurveColumns(1_000_000_000n * 10n ** 18n, 4_200_000_000n, 18, 18);
  if (!derived) throw new Error('seed: curve derivation failed');
  await h.deps.db.insert(tokens).values({
    net: 'BASE',
    sym,
    name: sym,
    creator: CREATOR,
    mint,
    baseSymbol: 'ETH',
    baseMint: WETH,
    supply: 1e9,
    feeBps: 250,
    mc: 69_000,
    lane: 'grad',
    seed: 1,
    launchedAt: new Date(h.now() - 3_600_000),
    graduatedAt: new Date(h.now() - 600_000),
    poolAddress,
    ...derived.columns,
    curveRealToken: '0',
  });
}

/** A launchpad → v3 migrator → locker chain, with `pending` uncollected. */
function wireLocker(pending: { base: bigint; tokens: bigint }): void {
  const rpc = h.rpcs.BASE;
  rpc.setContract(LAUNCHPAD, (data) => (data.startsWith(SEL_MIGRATOR) ? word(MIGRATOR) : '0x'));
  rpc.setContract(MIGRATOR, (data) => (data.startsWith(SEL_LOCKER) ? word(LOCKER) : '0x'));
  rpc.setContract(LOCKER, (data) => {
    const { functionName, args } = decodeFunctionData({ abi: FEE_LOCKER_ABI, data: data as Hex });
    const token = (args as readonly [string])[0].toLowerCase();
    if (functionName === 'lockOf') {
      const locked = token === MINT.toLowerCase();
      return encodeAbiParameters(FEE_LOCKER_ABI[0].outputs, [
        {
          pool: locked ? POOL : '0x0000000000000000000000000000000000000000',
          baseToken: locked ? WETH : '0x0000000000000000000000000000000000000000',
          tickLower: -887_200,
          tickUpper: 887_200,
          tokenIs0: true,
          liquidity: locked ? 123_456_789n : 0n,
        },
      ]);
    }
    if (functionName === 'pendingFees') {
      return encodeAbiParameters(FEE_LOCKER_ABI[1].outputs, [pending.base, pending.tokens]);
    }
    return '0x';
  });
}

describe('post-graduation pool fees', () => {
  it('GET /tokens/:sym reports the locked position and its uncollected fees', async () => {
    await seed('LOCKED', MINT, POOL);
    wireLocker({ base: 250_000_000_000_000_000n, tokens: 1_500n * 10n ** 18n });
    const res = await h.app.request('/tokens/LOCKED?net=BASE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { poolFees?: Record<string, unknown> };
    expect(body.poolFees).toEqual({
      locker: LOCKER,
      pool: POOL,
      pendingBase: 0.25,
      baseSym: 'ETH',
      pendingTokens: 1500,
    });
  });

  it('shows nothing for a v2 graduation (a migrator without a locker)', async () => {
    await seed('BURNED', V2_MINT, POOL);
    h.rpcs.BASE.setContract(LAUNCHPAD, (data) =>
      data.startsWith(SEL_MIGRATOR) ? word(MIGRATOR) : '0x',
    );
    h.rpcs.BASE.setContract(MIGRATOR, () => '0x');
    const res = await h.app.request('/tokens/BURNED?net=BASE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { poolFees?: unknown };
    expect(body.poolFees).toBeUndefined();

    const prep = await h.app.request('/tokens/BURNED/pool-fees/claim/prepare?net=BASE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(prep.status).toBe(422);
    expect(((await prep.json()) as { error: string }).error).toBe('no_locked_position');
  });

  it('prepares the permissionless claimFees call for the locker', async () => {
    await seed('LOCKED', MINT, POOL);
    wireLocker({ base: 1n, tokens: 0n });
    const res = await h.app.request('/tokens/LOCKED/pool-fees/claim/prepare?net=BASE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mint: MINT }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { to: string; data: Hex; value: string; net: string };
    expect(body.net).toBe('BASE');
    expect(body.to).toBe(LOCKER);
    expect(body.value).toBe('0');
    const call = decodeFunctionData({ abi: FEE_LOCKER_ABI, data: body.data });
    expect(call.functionName).toBe('claimFees');
    expect((call.args as readonly [string])[0]).toBe(MINT);
  });

  it('refuses when nothing is uncollected, and before migration', async () => {
    await seed('LOCKED', MINT, POOL);
    wireLocker({ base: 0n, tokens: 0n });
    const empty = await h.app.request('/tokens/LOCKED/pool-fees/claim/prepare?net=BASE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { error: string }).error).toBe('nothing_to_claim');

    await seed('PENDING', V2_MINT, null);
    const early = await h.app.request('/tokens/PENDING/pool-fees/claim/prepare?net=BASE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe('not_graduated');
  });

  it('is EVM-only', async () => {
    const res = await h.app.request('/tokens/ANY/pool-fees/claim/prepare?net=SOL', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
