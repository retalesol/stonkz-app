import { describe, expect, it } from 'vitest';
import { HttpJupiterClient } from './jupiter.js';

describe('HttpJupiterClient.quote route shape', () => {
  function client(urls: string[]) {
    return new HttpJupiterClient({
      baseUrl: 'https://jup.test/swap/v1',
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            inputMint: 'a',
            inAmount: '1',
            outputMint: 'b',
            outAmount: '2',
            otherAmountThreshold: '2',
            swapMode: 'ExactIn',
            slippageBps: 0,
            priceImpactPct: '0',
            platformFee: null,
            routePlan: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
  }
  const req = { inMint: 'a', outMint: 'b', inAmountAtoms: 1n, slippagePct: 1 };

  it('asks for a multi-hop route with no account cap by default', async () => {
    const urls: string[] = [];
    await client(urls).quote(req);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('onlyDirectRoutes')).toBe('false');
    expect(q.has('maxAccounts')).toBe(false);
  });

  it('passes maxAccounts and onlyDirectRoutes when a composer needs room', async () => {
    const urls: string[] = [];
    await client(urls).quote({ ...req, maxAccounts: 16, onlyDirectRoutes: true });
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('onlyDirectRoutes')).toBe('true');
    expect(q.get('maxAccounts')).toBe('16');
  });
});
