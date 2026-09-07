import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { getAddress } from 'viem';
import { creatorVaults, tokens } from '../db/schema.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_TOKEN_MINT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const RH_TOKEN_MINT = getAddress(`0x${'fee5'.padStart(40, '0')}`);

async function seedToken(net: 'SOL' | 'RH', sym: string, mint: string, creator: string): Promise<void> {
  const baseDecimals = net === 'SOL' ? 9 : 18;
  const tokenDecimals = net === 'SOL' ? 6 : 18;
  // Native-unit USD price, matching `FakePriceOracle`'s defaults — the
  // graduation cap's virtual-reserve math is sized off this, and ETH's
  // ~$4,200 (vs. SOL's ~$214) is what keeps an 18-decimal RH curve's
  // `virtualBase` under `@stonkz/curve-sim`'s `MAX_VIRTUAL_BASE`.
  const basePrice1e6 = net === 'SOL' ? 214_080_000n : 4_200_000_000n;
  const derived = deriveCurveColumns(1_000_000_000n * 10n ** BigInt(tokenDecimals), basePrice1e6, baseDecimals, tokenDecimals);
  if (!derived) throw new Error('seedToken: curve derivation failed');
  await h.deps.db.insert(tokens).values({
    net,
    sym,
    name: sym,
    creator,
    mint,
    baseSymbol: net === 'SOL' ? 'SOL' : 'ETH',
    baseMint: net === 'SOL' ? SOL_MINT : '0x0000000000000000000000000000000000000000',
    supply: 1e9,
    feeBps: 250,
    mc: 1000,
    lane: 'new',
    seed: 1,
    launchedAt: new Date(h.now() - 600_000),
    ...derived.columns,
  });
}

interface FeesResponse {
  net?: string;
  nativeUnit?: string;
  vaults?: { sym: string; unclaimedNative: number; unclaimedTokens: number }[];
  error?: string;
}

interface ClaimResponse {
  net?: string;
  sym?: string;
  transaction?: string;
  to?: string;
  data?: string;
  value?: string;
  error?: string;
}

async function getFees(token: string): Promise<{ status: number; body: FeesResponse }> {
  const res = await h.app.request('/fees', { headers: authed(token) });
  return { status: res.status, body: (await res.json()) as FeesResponse };
}

async function claimPrepare(token: string, sym: string): Promise<{ status: number; body: ClaimResponse }> {
  const res = await h.app.request('/fees/claim/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify({ sym }),
  });
  return { status: res.status, body: (await res.json()) as ClaimResponse };
}

/** Plan step 92 — creator-vault-only fee reads and claims. */
describe('GET /fees + POST /fees/claim/prepare', () => {
  it('lists only vaults with an unclaimed balance for the caller', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'FEEZ', SOL_TOKEN_MINT, address);
    await h.deps.db.insert(creatorVaults).values([
      { net: 'SOL', sym: 'FEEZ', creator: address, unclaimedNative: 1.5, unclaimedTokens: 0 },
      { net: 'SOL', sym: 'EMPTY', creator: address, unclaimedNative: 0, unclaimedTokens: 0 },
    ]);

    const { status, body } = await getFees(token);
    expect(status).toBe(200);
    expect(body.nativeUnit).toBe('SOL');
    expect(body.vaults).toHaveLength(1);
    expect(body.vaults?.[0]).toMatchObject({ sym: 'FEEZ', unclaimedNative: 1.5 });
  });

  it('never surfaces another wallet\'s creator vault', async () => {
    const { token, address } = await h.login('SOL');
    const other = await h.login('SOL', solanaWallet('fees-other-wallet'));
    await seedToken('SOL', 'THEIRS', SOL_TOKEN_MINT, other.address);
    await h.deps.db.insert(creatorVaults).values({ net: 'SOL', sym: 'THEIRS', creator: other.address, unclaimedNative: 5 });

    const { body } = await getFees(token);
    expect(body.vaults).toHaveLength(0);
    void address;
  });

  it('builds an unsigned Solana claim_creator_fees transaction', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'CLAIMSOL', SOL_TOKEN_MINT, address);
    await h.deps.db.insert(creatorVaults).values({ net: 'SOL', sym: 'CLAIMSOL', creator: address, unclaimedNative: 2.5 });

    const { status, body } = await claimPrepare(token, 'CLAIMSOL');
    expect(status).toBe(200);
    expect(typeof body.transaction).toBe('string');
    expect(() => Buffer.from(body.transaction!, 'base64')).not.toThrow();
    // Sanity: it deserializes back into a legacy `Transaction` with one instruction.
    const { Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
    expect(tx.instructions).toHaveLength(1);
    expect(tx.feePayer?.equals(new PublicKey(address))).toBe(true);
  });

  it('builds claimCreatorFees calldata on Robinhood Chain', async () => {
    const { token, address } = await h.login('RH');
    await seedToken('RH', 'CLAIMRH', RH_TOKEN_MINT, address);
    await h.deps.db.insert(creatorVaults).values({ net: 'RH', sym: 'CLAIMRH', creator: address, unclaimedNative: 1 });

    const { status, body } = await claimPrepare(token, 'CLAIMRH');
    expect(status).toBe(200);
    expect(body.to).toBe(h.deps.env.rhLaunchpadAddress);
    expect(body.data).toMatch(/^0x/);
    expect(body.value).toBe('0');
  });

  it('refuses to claim when there is nothing unclaimed', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'DRY', SOL_TOKEN_MINT, address);
    await h.deps.db.insert(creatorVaults).values({ net: 'SOL', sym: 'DRY', creator: address, unclaimedNative: 0, unclaimedTokens: 0 });

    const { status, body } = await claimPrepare(token, 'DRY');
    expect(status).toBe(422);
    expect(body.error).toBe('nothing_to_claim');
  });

  it('refuses to claim a vault belonging to a different wallet', async () => {
    const { token } = await h.login('SOL');
    const other = await h.login('SOL', solanaWallet('fees-other-wallet-2'));
    await seedToken('SOL', 'NOTMINE', SOL_TOKEN_MINT, other.address);
    await h.deps.db.insert(creatorVaults).values({ net: 'SOL', sym: 'NOTMINE', creator: other.address, unclaimedNative: 3 });

    const { status, body } = await claimPrepare(token, 'NOTMINE');
    expect(status).toBe(422);
    expect(body.error).toBe('nothing_to_claim');
  });

  it('refuses a claim for a ticker with no creator vault row at all', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await claimPrepare(token, 'NOPE');
    expect(status).toBe(422);
    expect(body.error).toBe('nothing_to_claim');
  });
});
