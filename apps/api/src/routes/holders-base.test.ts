import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { holdersSnapshot, tokens } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';

const BASE_LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const RH_LAUNCHPAD = '0xe308287C9A85E2B53F1027a1c589B5e3969928e8';
const MINT = '0x00000000000000000000000000000000000b45e1';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp({
    env: { BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD, RH_LAUNCHPAD_ADDRESS: RH_LAUNCHPAD },
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h.close();
});

describe('GET /tokens/:sym/holders on Base', () => {
  it("flags Base's own launchpad as the curve, not Robinhood's", async () => {
    // Explorer unreachable → the DB snapshot fallback.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    await h.deps.db.insert(tokens).values({
      net: 'BASE',
      sym: 'BHOLD',
      name: 'Base Hold',
      creator: '0x0000000000000000000000000000000000000001',
      mint: MINT,
      baseSymbol: 'ETH',
      baseMint: '0x4200000000000000000000000000000000000006',
      supply: 1_000_000_000,
      feeBps: 100,
      mc: 1,
      seed: 1,
    });
    await h.deps.db.insert(holdersSnapshot).values([
      {
        net: 'BASE',
        sym: 'BHOLD',
        mint: MINT,
        wallet: BASE_LAUNCHPAD,
        tokenAmount: 800_000_000,
        costNative: 0,
      },
      {
        net: 'BASE',
        sym: 'BHOLD',
        mint: MINT,
        wallet: '0x00000000000000000000000000000000000000aa',
        tokenAmount: 5,
        costNative: 0,
      },
    ]);
    const res = await h.app.request(`/tokens/BHOLD/holders?net=BASE&mint=${MINT}`);
    const body = (await res.json()) as {
      curveWallet: string;
      holderCount: number;
      holders: { wallet: string; curve?: boolean }[];
    };
    expect(body.curveWallet).toBe(BASE_LAUNCHPAD);
    expect(body.holders.find((x) => x.wallet === BASE_LAUNCHPAD)?.curve).toBe(true);
    expect(body.holderCount).toBe(1);
  });
});
