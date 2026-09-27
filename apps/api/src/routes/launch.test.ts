import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address } from 'viem';
import { launchIntents, tokens } from '../db/schema.js';
import { TOKEN_CREATED_EVENT_ABI } from '../router/evm-abi.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';

let h: TestApp;

beforeAll(async () => {
  // The EVM prepare path now refuses a net with no launchpad pinned.
  h = await createTestApp({
    env: { RH_LAUNCHPAD_ADDRESS: '0x000000000000000000000000000000000000dec0' },
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.jupiter.reset();
  h.uniswap.reset();
});

interface LaunchPrepareResponse {
  net: string;
  intentId: string;
  ticker: string;
  predictedMint: string | null;
  transaction?: string;
  to?: string;
  data?: string;
  value?: string;
  lastValidBlockHeight?: number;
  devBuy: { native: number; atomic: boolean; note?: string } | null;
  expiresAt: number;
  error?: string;
  detail?: string;
  retryAfterMs?: number;
}

interface LaunchConfirmResponse {
  net?: string;
  sym?: string;
  mint?: string;
  mc?: number;
  error?: string;
}

async function prepare(
  token: string,
  body: Record<string, unknown>,
  app: TestApp = h,
): Promise<{ status: number; body: LaunchPrepareResponse }> {
  const res = await app.app.request('/launch/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as LaunchPrepareResponse };
}

async function confirm(
  token: string,
  intentId: string,
  signature: string,
): Promise<{ status: number; body: LaunchConfirmResponse }> {
  const res = await h.app.request('/launch/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify({ intentId, signature }),
  });
  return { status: res.status, body: (await res.json()) as LaunchConfirmResponse };
}

async function loadIntent(intentId: string) {
  const [intent] = await h.deps.db
    .select()
    .from(launchIntents)
    .where(eq(launchIntents.id, intentId))
    .limit(1);
  return intent!;
}

async function loadToken(net: 'SOL' | 'RH', sym: string) {
  const [row] = await h.deps.db
    .select()
    .from(tokens)
    .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
    .limit(1);
  return row;
}

/** Hand-builds a `TokenCreated` log — this viem version has no `encodeEventLog` helper. */
function tokenCreatedLog(args: {
  token: Address;
  baseToken: Address;
  creator: Address;
  ticker: string;
  supply: bigint;
  feeBps: number;
  cashback: boolean;
  cbStart: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  tokensForSale: bigint;
  lpReserve: bigint;
  gradMcapBase: bigint;
  basePrice1e6: bigint;
}) {
  const topics = encodeEventTopics({
    abi: TOKEN_CREATED_EVENT_ABI,
    eventName: 'TokenCreated',
    args: { token: args.token, baseToken: args.baseToken, creator: args.creator },
  });
  const nonIndexed = TOKEN_CREATED_EVENT_ABI[0].inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, [
    args.ticker,
    args.supply,
    args.feeBps,
    args.cashback,
    args.cbStart,
    args.virtualBase,
    args.virtualToken,
    args.tokensForSale,
    args.lpReserve,
    args.gradMcapBase,
    args.basePrice1e6,
  ]);
  return { topics, data };
}

const SOL_TICKER_BODY = {
  ticker: 'moon',
  name: 'Moon Coin',
  supply: 1e9,
  feePct: 2.5,
  cashback: false,
  baseSymbol: 'SOL',
};

/** Plan steps 90–91 — launch validation, curve derivation, and confirm verification. */
describe('POST /launch/prepare + /launch/confirm', () => {
  it('launches on Solana with a direct SOL base pair and no dev buy', async () => {
    const { token, address } = await h.login('SOL');
    const { status, body } = await prepare(token, SOL_TICKER_BODY);
    expect(status).toBe(200);
    expect(body.ticker).toBe('MOON');
    expect(body.predictedMint).toBeTruthy();
    expect(body.transaction).toBeTruthy();
    expect(body.devBuy).toBeNull();
    // The mint is the real PDA the on-chain program would derive — a stable base58 pubkey.
    expect(() => new PublicKey(body.predictedMint!)).not.toThrow();

    const intent = await loadIntent(body.intentId);
    expect(intent.unsignedPayload).toBeTruthy();

    const sig = 'sig-moon-1';
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    const confirmed = await confirm(token, body.intentId, sig);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.sym).toBe('MOON');
    expect(confirmed.body.mint).toBe(body.predictedMint);
    expect(confirmed.body.mc).toBeGreaterThan(0);

    const row = await loadToken('SOL', 'MOON');
    expect(row?.curveK).not.toBe('0');
    expect(row?.mint).toBe(body.predictedMint);
    expect(row?.creator).toBe(address);

    // Re-confirming the same intent is refused, not re-applied.
    const again = await confirm(token, body.intentId, sig);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_confirmed');
  });

  it('runs an atomic dev buy through Jupiter when the base is a priced non-native major (USDC)', async () => {
    // 284ae9a: SOLANA_CLUSTER defaults to devnet, where only SOL/WSOL carry a
    // base mint. The mainnet USDC mint (and its Jupiter route) needs mainnet-beta.
    const mainnet = await createTestApp({ env: { SOLANA_CLUSTER: 'mainnet-beta' } });
    try {
      const { token } = await mainnet.login('SOL');
      mainnet.jupiter.setRoute(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        {
          rate: 200, // Purely a fixture rate — only the atomicity/shape of the response matters here.
        },
      );
      const { status, body } = await prepare(
        token,
        { ...SOL_TICKER_BODY, ticker: 'usdcbuy', baseSymbol: 'USDC', devBuyNative: 0.05 },
        mainnet,
      );
      expect(status).toBe(200);
      expect(body.devBuy).toMatchObject({ native: 0.05, atomic: true });
      expect(body.transaction).toBeTruthy();
    } finally {
      await mainnet.close();
    }
  });

  it('refuses a mainnet-only major on devnet, where it has no base mint', async () => {
    // Same 284ae9a rule from the other side: the default (devnet) app knows
    // USDC as a major but has no mint address for it, so prepare fails closed.
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'devusdc',
      baseSymbol: 'USDC',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('base_mint_not_allowed');
    expect(body.detail).toMatch(/no configured mint address/);
  });

  it('rejects an in-flight prepare for the same ticker from another wallet', async () => {
    const a = await h.login('SOL', solanaWallet('in-flight-a'));
    const b = await h.login('SOL', solanaWallet('in-flight-b'));
    const first = await prepare(a.token, { ...SOL_TICKER_BODY, ticker: 'dupe' });
    expect(first.status).toBe(200);

    const second = await prepare(b.token, { ...SOL_TICKER_BODY, ticker: 'dupe' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('ticker_taken');
  });

  it('rejects a confirmed ticker within the 5-minute cooldown', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'taken' });
    const intent = await loadIntent(p.body.intentId);
    const sig = 'sig-taken';
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    await confirm(token, p.body.intentId, sig);

    const again = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'taken',
      name: 'Different Name',
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('name_or_ticker_cooldown');
    expect(typeof again.body.retryAfterMs).toBe('number');
  });

  it('rejects a display name within the 5-minute cooldown', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'nmone', name: 'Shared Name' });
    const intent = await loadIntent(p.body.intentId);
    const sig = 'sig-name-cd';
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    await confirm(token, p.body.intentId, sig);

    const again = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'nmtwo',
      name: 'shared name',
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('name_or_ticker_cooldown');
  });

  it('allows the same ticker after the 5-minute cooldown', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'reuse' });
    const intent = await loadIntent(p.body.intentId);
    const sig = 'sig-reuse';
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    await confirm(token, p.body.intentId, sig);

    h.advance(5 * 60 * 1000 + 1);
    const again = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'reuse', name: 'Reuse Two' });
    expect(again.status).toBe(200);
    expect(again.body.predictedMint).toBeTruthy();
    expect(again.body.predictedMint).not.toBe(p.body.predictedMint);
  });

  it('rejects cashback combined with a nonzero dev buy', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'cbdb',
      cashback: true,
      devBuyNative: 1,
    });
    expect(status).toBe(422);
    expect(body.error).toBe('cashback_dev_buy_conflict');
  });

  it('rejects an out-of-range supply', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'badsup',
      supply: 42,
    });
    expect(status).toBe(422);
    expect(body.error).toBe('invalid_supply');
  });

  it('rejects an out-of-range fee', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'badfee',
      feePct: 9,
    });
    expect(status).toBe(422);
    expect(body.error).toBe('invalid_fee');
  });

  it('rejects a base symbol with no priced source on this net yet', async () => {
    // BONK only has a mint on mainnet-beta (284ae9a devnet table is SOL/WSOL),
    // and the mint check runs before the price check — so go through mainnet
    // to reach the price gate this test is about.
    const mainnet = await createTestApp({ env: { SOLANA_CLUSTER: 'mainnet-beta' } });
    try {
      const { token } = await mainnet.login('SOL');
      const { status, body } = await prepare(
        token,
        { ...SOL_TICKER_BODY, ticker: 'badbase', baseSymbol: 'BONK' },
        mainnet,
      );
      expect(status).toBe(422);
      expect(body.error).toBe('base_price_unavailable');
    } finally {
      await mainnet.close();
    }
  });

  it('rejects a base symbol entirely outside the major/stock allow-list', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'badbase2',
      baseSymbol: 'DOGE',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('base_mint_not_allowed');
  });

  it('rejects a name/ticker/description that trips the moderation stub', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'mod1',
      name: 'fuck coin',
    });
    expect(status).toBe(422);
    expect(body.error).toBe('moderation_rejected');
  });

  it('launches on Robinhood Chain and confirms off the TokenCreated event', async () => {
    const { token, address } = await h.login('RH');
    const { status, body } = await prepare(token, {
      ticker: 'rhmoon',
      name: 'RH Moon',
      supply: 1e9,
      feePct: 3,
      cashback: false,
      baseSymbol: 'ETH',
    });
    expect(status).toBe(200);
    expect(body.predictedMint).toBeNull();
    expect(body.to).toBe(h.deps.env.rhLaunchpadAddress);
    expect(body.data).toBeTruthy();

    const tokenAddr = getAddress(`0x${'c0ffee'.padStart(40, '0')}`);
    const log = tokenCreatedLog({
      token: tokenAddr,
      baseToken: '0x0000000000000000000000000000000000000000',
      creator: address as Address,
      ticker: 'RHMOON',
      supply: 1_000_000_000n,
      feeBps: 300,
      cashback: false,
      cbStart: 0n,
      virtualBase: 1_000_000_000_000_000_000n,
      virtualToken: 800_000_000_000_000_000_000_000_000n,
      tokensForSale: 800_000_000_000_000_000_000_000_000n,
      lpReserve: 200_000_000_000_000_000_000_000_000n,
      gradMcapBase: 69_000_000_000_000_000_000n,
      basePrice1e6: 4_200_000_000n,
    });

    const sig = '0xdeadbeef';
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: address,
      to: h.deps.env.rhLaunchpadAddress,
      input: body.data!,
      logs: [
        { address: h.deps.env.rhLaunchpadAddress, topics: log.topics as string[], data: log.data },
      ],
    });

    const confirmed = await confirm(token, body.intentId, sig);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.sym).toBe('RHMOON');
    expect(confirmed.body.mint?.toLowerCase()).toBe(tokenAddr.toLowerCase());

    const row = await loadToken('RH', 'RHMOON');
    expect(row?.mint.toLowerCase()).toBe(tokenAddr.toLowerCase());
  });

  it('refuses to confirm a Robinhood transaction another wallet sent', async () => {
    // Once an intent expires anyone can rebuild the same calldata; the
    // receipt's sender is what ties a confirmation to the signed-in wallet.
    const { token } = await h.login('RH');
    const { status, body } = await prepare(token, {
      ticker: 'rhthief',
      name: 'RH Thief',
      supply: 1e9,
      feePct: 3,
      cashback: false,
      baseSymbol: 'ETH',
    });
    expect(status).toBe(200);
    const sig = '0xfeedface';
    h.rpcs.RH.setEvmReceipt(sig, {
      status: 'success',
      from: '0x000000000000000000000000000000000000dEaD',
      to: h.deps.env.rhLaunchpadAddress,
      input: body.data!,
      logs: [],
    });
    const confirmed = await confirm(token, body.intentId, sig);
    expect(confirmed.status).toBe(403);
    expect(confirmed.body.error).toBe('tx_sender_mismatch');
  });

  it('refuses to confirm a transaction whose payload does not match what was prepared', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'mismatch' });
    const sig = 'sig-mismatch';
    h.rpcs.SOL.setSolanaTransactionMessage(sig, 'not-the-real-message');
    const confirmed = await confirm(token, p.body.intentId, sig);
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error).toBe('signature_mismatch');
  });

  it('refuses to confirm once the intent has expired', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'expired' });
    const intent = await loadIntent(p.body.intentId);
    const sig = 'sig-expired';
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);

    h.advance((h.deps.env.launchIntentTtlSeconds + 5) * 1000);
    const confirmed = await confirm(token, p.body.intentId, sig);
    expect(confirmed.status).toBe(410);
    expect(confirmed.body.error).toBe('intent_expired');
  });
});
