import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokens } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
});

describe('GET /og/t/:sym', () => {
  it('embeds the token name and market cap in the OG tags', async () => {
    await h.deps.db.insert(tokens).values({
      net: 'SOL',
      sym: 'WOJAK',
      name: 'Wojak Coin',
      descr: 'the saddest coin',
      creator: 'CREATOR',
      baseSymbol: 'SOL',
      baseMint: 'So11111111111111111111111111111111111111112',
      supply: 1_000_000_000,
      feeBps: 100,
      mc: 12_345,
      seed: 1,
    });

    const res = await h.app.request('/og/t/WOJAK?net=SOL');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('WOJAK');
    expect(html).toContain('the saddest coin');
    expect(html).toContain('og:title');
  });

  it('degrades gracefully for a token that does not exist', async () => {
    const res = await h.app.request('/og/t/NOPE');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('NOPE');
  });
});
