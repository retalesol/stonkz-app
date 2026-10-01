import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageV0,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import bs58 from 'bs58';
import { and, eq } from 'drizzle-orm';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
} from 'viem';
import { buyQuote, freshState } from '@stonkz/curve-sim';
import { launchIntents, tokens } from '../db/schema.js';
import { LAUNCHPAD_ABI, TOKEN_CREATED_EVENT_ABI } from '../router/evm-abi.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import { encodeSolanaBaseOracle, solanaOraclePda } from '../router/launch-preflight.js';
import {
  anchorDiscriminator,
  encodePythPriceUpdateV2,
  pinnedPythFeedId,
  pythPriceFeedAccount,
} from '../router/solana-idl.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';
import {
  encodeLookupTableAccount,
  syntheticJupiterRoute,
  syntheticLookupTable,
} from '../test/solana-alt-fixtures.js';
import { stonkzLaunchAltAddresses, wireMessageBase64 } from '../router/solana-alt.js';
import { evmWallet, solanaWallet } from '../test/wallets.js';
import { LAUNCH_CONFIRM_GRACE_MS } from './launch.js';

const BASE_LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const RH_WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';

/** A well-formed base58 Solana signature (64 bytes), distinct per seed. */
function solSig(seed: number): string {
  return bs58.encode(Buffer.alloc(64, seed));
}

/** A well-formed EVM tx hash, distinct per two-hex-char seed. */
function evmHash(seed: string): string {
  return `0x${seed.repeat(32)}`;
}

let h: TestApp;

beforeAll(async () => {
  // The EVM prepare path now refuses a net with no launchpad pinned.
  h = await createTestApp({
    env: {
      RH_LAUNCHPAD_ADDRESS: '0x000000000000000000000000000000000000dec0',
      BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD,
    },
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
  for (const rpc of [h.rpcs.SOL, h.rpcs.RH, h.rpcs.BASE]) {
    rpc.setFailing(false);
    rpc.setSimulationFailing(false);
    rpc.setSimulation({ ok: true });
  }
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
  already?: boolean;
  error?: string;
  detail?: string;
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

async function loadToken(net: 'SOL' | 'RH' | 'BASE', sym: string) {
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

    const sig = solSig(1);
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

    // A retried confirm (lost response, double click) with the same
    // signature answers idempotently; it does not re-apply anything.
    const again = await confirm(token, body.intentId, sig);
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    expect(again.body.mint).toBe(body.predictedMint);

    // A *different* signature on a consumed intent is still refused.
    const other = await confirm(token, body.intentId, solSig(99));
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('already_confirmed');
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

  it('composes a Jupiter dev buy as v0 against Jupiter + operator lookup tables, and confirm verifies it', async () => {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
    const stonkzAlt = syntheticLookupTable(
      stonkzLaunchAltAddresses(programId, [NATIVE_MINT, new PublicKey(USDC_MINT)]),
    );
    const mainnet = await createTestApp({
      env: {
        SOLANA_CLUSTER: 'mainnet-beta',
        SOLANA_LAUNCHPAD_PROGRAM_ID: programId.toBase58(),
        SOLANA_LAUNCH_ALT: stonkzAlt.key.toBase58(),
      },
    });
    try {
      const { token, address } = await mainnet.login('SOL');
      mainnet.jupiter.setRoute(NATIVE_MINT.toBase58(), USDC_MINT, { rate: 200 });
      const route = syntheticJupiterRoute({
        user: new PublicKey(address),
        baseMint: new PublicKey(USDC_MINT),
        poolAccounts: 14,
        tableCount: 1,
      });
      mainnet.jupiter.setSwapInstructions(route.response);
      for (const t of [stonkzAlt, ...route.tables]) {
        mainnet.rpcs.SOL.setAccountData(
          t.key.toBase58(),
          encodeLookupTableAccount(t.state.addresses).toString('base64'),
        );
      }
      const simulated: string[] = [];
      mainnet.rpcs.SOL.setSimulation(({ data }) => {
        simulated.push(data);
        return { ok: true };
      });

      const { status, body } = await prepare(
        token,
        { ...SOL_TICKER_BODY, ticker: 'usdcvzero', baseSymbol: 'USDC', devBuyNative: 0.05 },
        mainnet,
      );
      expect(status).toBe(200);
      const wire = Buffer.from(body.transaction!, 'base64');
      expect(wire.length).toBeLessThanOrEqual(1232);
      const vtx = VersionedTransaction.deserialize(wire);
      expect(vtx.version).toBe(0);
      // Both the operator table and Jupiter's are referenced.
      expect(vtx.message.addressTableLookups.map((l) => l.accountKey.toBase58()).sort()).toEqual(
        [stonkzAlt.key.toBase58(), route.tables[0]!.key.toBase58()].sort(),
      );
      // The preflight simulated exactly the v0 wire transaction.
      expect(simulated).toEqual([body.transaction]);
      // The mint prediction is unchanged by the message version.
      const ixs = TransactionMessage.decompile(vtx.message, {
        addressLookupTableAccounts: [stonkzAlt, ...route.tables],
      }).instructions;
      const create = ixs.find((ix) => ix.programId.equals(programId) && ix.keys.length === 18)!;
      expect(create.keys[1]!.pubkey.toBase58()).toBe(body.predictedMint);

      const [intent] = await mainnet.deps.db
        .select()
        .from(launchIntents)
        .where(eq(launchIntents.id, body.intentId))
        .limit(1);
      // The stored message is the v0 message verbatim (version prefix 0x80).
      expect(Buffer.from(intent!.unsignedPayload, 'base64')[0]).toBe(0x80);
      expect(wireMessageBase64(wire)).toBe(intent!.unsignedPayload);

      const confirmOn = async (signature: string) => {
        const res = await mainnet.app.request('/launch/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authed(token) },
          body: JSON.stringify({ intentId: body.intentId, signature }),
        });
        return { status: res.status, body: (await res.json()) as LaunchConfirmResponse };
      };

      // Same message, different lookup table: refused.
      const tampered = new VersionedTransaction(
        new MessageV0({
          header: vtx.message.header,
          staticAccountKeys: vtx.message.staticAccountKeys,
          recentBlockhash: vtx.message.recentBlockhash,
          compiledInstructions: vtx.message.compiledInstructions,
          addressTableLookups: vtx.message.addressTableLookups.map((l, i) =>
            i === 0 ? { ...l, accountKey: PublicKey.unique() } : l,
          ),
        }),
      );
      mainnet.rpcs.SOL.setSolanaTransactionMessage(
        solSig(41),
        wireMessageBase64(tampered.serialize()),
      );
      const bad = await confirmOn(solSig(41));
      expect(bad.status).toBe(409);
      expect(bad.body.error).toBe('signature_mismatch');

      // What the node returns for the submitted transaction re-derives to the stored message.
      mainnet.rpcs.SOL.setSolanaTransactionMessage(solSig(42), wireMessageBase64(wire));
      const ok = await confirmOn(solSig(42));
      expect(ok.status).toBe(200);
      expect(ok.body.mint).toBe(body.predictedMint);
    } finally {
      await mainnet.close();
    }
  });

  it('re-quotes a dev-buy route that overflows as a narrower direct route, which fits', async () => {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
    const stonkzAlt = syntheticLookupTable(
      stonkzLaunchAltAddresses(programId, [NATIVE_MINT, new PublicKey(USDC_MINT)]),
    );
    const mainnet = await createTestApp({
      env: {
        SOLANA_CLUSTER: 'mainnet-beta',
        SOLANA_LAUNCHPAD_PROGRAM_ID: programId.toBase58(),
        SOLANA_LAUNCH_ALT: stonkzAlt.key.toBase58(),
      },
    });
    try {
      const { token, address } = await mainnet.login('SOL');
      mainnet.jupiter.setRoute(NATIVE_MINT.toBase58(), USDC_MINT, { rate: 200 });
      const user = new PublicKey(address);
      const baseMint = new PublicKey(USDC_MINT);
      // The first (multi-hop) route spans three Jupiter tables and 30 accounts
      // and cannot fit; the direct one uses one table and 14 accounts.
      const wide = syntheticJupiterRoute({ user, baseMint, poolAccounts: 21, tableCount: 3 });
      const direct = syntheticJupiterRoute({ user, baseMint, poolAccounts: 5, tableCount: 1 });
      mainnet.jupiter.setSwapInstructions((quote) =>
        (quote as unknown as { onlyDirectRoutes: boolean }).onlyDirectRoutes
          ? direct.response
          : wide.response,
      );
      for (const t of [stonkzAlt, ...wide.tables, ...direct.tables]) {
        mainnet.rpcs.SOL.setAccountData(
          t.key.toBase58(),
          encodeLookupTableAccount(t.state.addresses).toString('base64'),
        );
      }
      const { status, body } = await prepare(
        token,
        {
          ...SOL_TICKER_BODY,
          ticker: 'usdcretry',
          baseSymbol: 'USDC',
          devBuyNative: 0.05,
          // As long as the default pinned-metadata URL (pinning is off in tests).
          uri: `https://example.com/${'u'.repeat(93)}`,
        },
        mainnet,
      );
      expect([status, body.error, body.detail]).toEqual([200, undefined, undefined]);
      expect(mainnet.jupiter.quoteRequests.map((q) => q.onlyDirectRoutes ?? false)).toEqual([
        false,
        true,
      ]);
      expect(mainnet.jupiter.quoteRequests.map((q) => q.maxAccounts)).toEqual([24, 16]);
      const vtx = VersionedTransaction.deserialize(Buffer.from(body.transaction!, 'base64'));
      expect(vtx.message.addressTableLookups.map((l) => l.accountKey.toBase58()).sort()).toEqual(
        [stonkzAlt.key.toBase58(), direct.tables[0]!.key.toBase58()].sort(),
      );
    } finally {
      await mainnet.close();
    }
  });

  it('refuses a Jupiter dev buy whose route cannot fit one packet, with a structured error', async () => {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const mainnet = await createTestApp({ env: { SOLANA_CLUSTER: 'mainnet-beta' } });
    try {
      const { token, address } = await mainnet.login('SOL');
      mainnet.jupiter.setRoute(NATIVE_MINT.toBase58(), USDC_MINT, { rate: 200 });
      // No tables served: every route account is a static key.
      mainnet.jupiter.setSwapInstructions(
        syntheticJupiterRoute({
          user: new PublicKey(address),
          baseMint: new PublicKey(USDC_MINT),
          poolAccounts: 20,
        }).response,
      );
      const { status, body } = await prepare(
        token,
        { ...SOL_TICKER_BODY, ticker: 'usdcbig', baseSymbol: 'USDC', devBuyNative: 0.05 },
        mainnet,
      );
      expect(status).toBe(422);
      expect(body.error).toBe('solana_tx_too_large');
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
    const sig = solSig(2);
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
    const sig = solSig(3);
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
    const sig = solSig(4);
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
    // Native ETH is a WETH curve on-chain: 0x0 would revert `createToken`.
    const call = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: body.data as `0x${string}` });
    expect(call.functionName).toBe('createToken');
    expect(String(call.args?.[4]).toLowerCase()).toBe(RH_WETH.toLowerCase());

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

    const sig = evmHash('de');
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
    const sig = evmHash('fe');
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
    const sig = solSig(5);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, 'not-the-real-message');
    const confirmed = await confirm(token, p.body.intentId, sig);
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error).toBe('signature_mismatch');
  });

  it('still confirms a launch that landed just after the prepare TTL', async () => {
    // A slow wallet prompt plus the client's confirm polling outlives the
    // 2-minute TTL; the token exists on-chain, so it must still register.
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'latecnf' });
    const intent = await loadIntent(p.body.intentId);
    const sig = solSig(6);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);

    h.advance((h.deps.env.launchIntentTtlSeconds + 5) * 1000);
    const confirmed = await confirm(token, p.body.intentId, sig);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.mint).toBe(p.body.predictedMint);
  });

  it('refuses to confirm once the intent is past the confirm grace', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'expired' });
    const intent = await loadIntent(p.body.intentId);
    const sig = solSig(7);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);

    h.advance(h.deps.env.launchIntentTtlSeconds * 1000 + LAUNCH_CONFIRM_GRACE_MS + 1000);
    // The access token has long expired by now; the same wallet signs in again.
    const fresh = await h.login('SOL');
    const confirmed = await confirm(fresh.token, p.body.intentId, sig);
    expect(confirmed.status).toBe(410);
    expect(confirmed.body.error).toBe('intent_expired');
  });
});

/** Prepare + a verified on-chain confirm, against any test app. */
async function launchOnce(app: TestApp, token: string, ticker: string, seed: number) {
  const p = await prepare(token, { ...SOL_TICKER_BODY, ticker, name: `${ticker} coin` }, app);
  expect(p.status).toBe(200);
  const [intent] = await app.deps.db
    .select()
    .from(launchIntents)
    .where(eq(launchIntents.id, p.body.intentId))
    .limit(1);
  const sig = solSig(seed);
  app.rpcs.SOL.setSolanaTransactionMessage(sig, intent!.unsignedPayload);
  const res = await app.app.request('/launch/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify({ intentId: p.body.intentId, signature: sig }),
  });
  expect(res.status).toBe(200);
}

describe('per-wallet launch quota', () => {
  it('does not spend the quota on prepares that fail', async () => {
    const app = await createTestApp({ env: { LAUNCH_RATE_LIMIT_PER_WALLET: '2' } });
    try {
      const { token } = await app.login('SOL');
      // Five refused prepares (bad fee) cost nothing...
      for (let i = 0; i < 5; i++) {
        const bad = await prepare(token, { ...SOL_TICKER_BODY, ticker: `bad${i}`, feePct: 9 }, app);
        expect(bad.status).toBeGreaterThanOrEqual(400);
        expect(bad.status).not.toBe(429);
      }
      // ...so both successful launches still fit, and only then is the wallet capped.
      await launchOnce(app, token, 'okone', 21);
      await launchOnce(app, token, 'oktwo', 22);
      const capped = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'okthree' }, app);
      expect(capped.status).toBe(429);
      expect(capped.body.error).toBe('rate_limited');
      expect(capped.body.detail).toMatch(/launch limit/);
    } finally {
      await app.close();
    }
  });

  it('does not spend the quota on prepares abandoned in the wallet', async () => {
    const app = await createTestApp({ env: { LAUNCH_RATE_LIMIT_PER_WALLET: '1' } });
    try {
      const { token } = await app.login('SOL');
      // Cancelled MetaMask/Phantom prompts: prepared, never confirmed.
      for (const ticker of ['gone1', 'gone2', 'gone1']) {
        expect((await prepare(token, { ...SOL_TICKER_BODY, ticker }, app)).status).toBe(200);
      }
      // The one launch the quota allows is the one that actually lands...
      await launchOnce(app, token, 'lands', 23);
      // ...and only after it does is the wallet capped.
      const capped = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'after' }, app);
      expect(capped.status).toBe(429);
    } finally {
      await app.close();
    }
  });
});

/** A successful `createToken` receipt as `wallet`, carrying a `TokenCreated` log. */
function evmLaunchReceipt(opts: {
  wallet: string;
  launchpad: string;
  data: string;
  token: Address;
  ticker: string;
  baseToken?: Address;
}) {
  const log = tokenCreatedLog({
    token: opts.token,
    baseToken: opts.baseToken ?? (BASE_WETH as Address),
    creator: opts.wallet as Address,
    ticker: opts.ticker,
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
  return {
    status: 'success' as const,
    from: opts.wallet,
    to: opts.launchpad,
    input: opts.data,
    logs: [{ address: opts.launchpad, topics: log.topics as string[], data: log.data }],
  };
}

const EVM_BODY = {
  name: 'Base Moon',
  supply: 1e9,
  feePct: 3,
  cashback: false,
  baseSymbol: 'ETH',
};

describe('launch across chains', () => {
  it('launches on Base Sepolia with native ETH encoded as WETH, then confirms', async () => {
    const { token, address } = await h.login('BASE');
    const { status, body } = await prepare(token, { ...EVM_BODY, ticker: 'bmoon' });
    expect(status).toBe(200);
    expect(body.to).toBe(BASE_LAUNCHPAD);
    const call = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: body.data as `0x${string}` });
    expect(String(call.args?.[4]).toLowerCase()).toBe(BASE_WETH.toLowerCase());
    const intent = await loadIntent(body.intentId);
    expect(intent.baseMint.toLowerCase()).toBe(BASE_WETH.toLowerCase());

    const tokenAddr = getAddress(`0x${'b0b0'.padStart(40, '0')}`);
    const sig = evmHash('b1');
    h.rpcs.BASE.setEvmReceipt(
      sig,
      evmLaunchReceipt({
        wallet: address,
        launchpad: BASE_LAUNCHPAD,
        data: body.data!,
        token: tokenAddr,
        ticker: 'BMOON',
      }),
    );
    const confirmed = await confirm(token, body.intentId, sig);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.mint).toBe(tokenAddr);
    const row = await loadToken('BASE', 'BMOON');
    expect(row?.baseMint.toLowerCase()).toBe(BASE_WETH.toLowerCase());
    expect(row?.creator).toBe(address);
  });

  it('refuses Arc cleanly while nothing is deployed there', async () => {
    const arc = await createTestApp({ env: { EVM_ALLOWED_CHAIN_IDS: '46630,84532,5042' } });
    try {
      const { token } = await arc.login('ARC');
      const { status, body } = await prepare(
        token,
        { ...EVM_BODY, ticker: 'arcx', baseSymbol: 'USDC' },
        arc,
      );
      expect(status).toBe(422);
      expect(body.error).toBe('launchpad_not_configured');
      expect(body.detail).toBeTruthy();
    } finally {
      await arc.close();
    }
  });

  it('refuses to register a Solana launch that landed but failed on-chain', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'failed' });
    const intent = await loadIntent(p.body.intentId);
    const sig = solSig(8);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload, { failed: true });
    const confirmed = await confirm(token, p.body.intentId, sig);
    expect(confirmed.status).toBe(422);
    expect(confirmed.body.error).toBe('transaction_failed');
    expect(await loadToken('SOL', 'FAILED')).toBeUndefined();
    // Nothing was consumed: a later successful retry could still use it.
    expect((await loadIntent(p.body.intentId)).consumedAt).toBeNull();
  });

  it('refuses to replay one transaction onto a second intent', async () => {
    const { token, address } = await h.login('RH');
    const body = { ...EVM_BODY, ticker: 'replay', name: 'Replay' };
    const first = await prepare(token, body);
    const tokenAddr = getAddress(`0x${'4e9'.padStart(40, '0')}`);
    const sig = evmHash('a1');
    h.rpcs.RH.setEvmReceipt(
      sig,
      evmLaunchReceipt({
        wallet: address,
        launchpad: h.deps.env.rhLaunchpadAddress,
        data: first.body.data!,
        token: tokenAddr,
        ticker: 'REPLAY',
        baseToken: RH_WETH as Address,
      }),
    );
    expect((await confirm(token, first.body.intentId, sig)).status).toBe(200);

    // Identical params → identical calldata; after the cooldown a new
    // intent must not be satisfiable by the old transaction.
    h.advance(5 * 60 * 1000 + 1);
    const second = await prepare(token, body);
    expect(second.status).toBe(200);
    expect(second.body.data).toBe(first.body.data);
    const replay = await confirm(token, second.body.intentId, sig);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('signature_already_used');
  });

  it('refuses a TokenCreated event naming another creator', async () => {
    const { token, address } = await h.login('RH');
    const p = await prepare(token, { ...EVM_BODY, ticker: 'otherc', name: 'Other C' });
    const sig = evmHash('c3');
    const receipt = evmLaunchReceipt({
      wallet: '0x000000000000000000000000000000000000bEEF',
      launchpad: h.deps.env.rhLaunchpadAddress,
      data: p.body.data!,
      token: getAddress(`0x${'c3c3'.padStart(40, '0')}`),
      ticker: 'OTHERC',
    });
    h.rpcs.RH.setEvmReceipt(sig, { ...receipt, from: address });
    const confirmed = await confirm(token, p.body.intentId, sig);
    expect(confirmed.status).toBe(422);
    expect(confirmed.body.error).toBe('token_created_event_missing');
  });

  it('validates confirm inputs instead of 500ing on them', async () => {
    const { token } = await h.login('SOL');
    const badId = await confirm(token, 'not-a-uuid', solSig(9));
    expect(badId.status).toBe(400);
    expect(badId.body.error).toBe('bad_request');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'badsig' });
    const badSig = await confirm(token, p.body.intentId, 'sig-not-base58-0OIl');
    expect(badSig.status).toBe(400);
    const unknown = await confirm(token, '00000000-0000-4000-8000-000000000000', solSig(9));
    expect(unknown.status).toBe(404);
  });

  it('answers a confirm during an RPC outage with a retryable 503, not a 500', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'rpcdown' });
    h.rpcs.SOL.setFailing(true);
    const confirmed = await confirm(token, p.body.intentId, solSig(10));
    expect(confirmed.status).toBe(503);
    expect(confirmed.body.error).toBe('chain_unavailable');
  });

  it('fills description, image and socials into a row the indexer registered first', async () => {
    const { token, address } = await h.login('SOL');
    const p = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'idxfirst',
      descr: 'first on the board',
      uri: 'https://gw.example/ipfs/bafyimage',
      x: '@idxfirst',
      web: 'idxfirst.xyz',
      tg: 't.me/idxfirst',
    });
    expect(p.status).toBe(200);
    const intent = await loadIntent(p.body.intentId);
    // What `apps/indexer`'s onTokenCreated writes: chain facts, no socials.
    await h.deps.db.insert(tokens).values({
      net: 'SOL',
      sym: 'IDXFIRST',
      name: 'Moon Coin',
      descr: '',
      creator: address,
      mint: p.body.predictedMint!,
      baseSymbol: 'SOL',
      baseMint: intent.baseMint,
      supply: 1e9,
      feeBps: 250,
      cashback: false,
      mc: 1,
      lastMc: 1,
      lane: 'new',
      seed: 1,
      launchedAt: new Date(h.now()),
    });
    const sig = solSig(11);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    expect((await confirm(token, p.body.intentId, sig)).status).toBe(200);
    const row = await loadToken('SOL', 'IDXFIRST');
    expect(row?.descr).toBe('first on the board');
    expect(row?.imageUrl).toBe('https://gw.example/ipfs/bafyimage');
    expect(row?.xHandle).toBe('idxfirst');
    expect(row?.website).toBe('https://idxfirst.xyz/');
    expect(row?.telegram).toBe('https://t.me/idxfirst');
  });

  it('replaces the indexer placeholder name on an EVM row, but never chain columns', async () => {
    const { token, address } = await h.login('BASE');
    const p = await prepare(token, {
      ...EVM_BODY,
      ticker: 'bph',
      name: 'Base Placeholder',
      descr: 'real words',
    });
    const tokenAddr = getAddress(`0x${'b9b9'.padStart(40, '0')}`);
    // `TokenCreated` on EVM has no name: the indexer writes `name = sym`.
    await h.deps.db.insert(tokens).values({
      net: 'BASE',
      sym: 'BPH',
      name: 'BPH',
      descr: '',
      creator: address,
      mint: tokenAddr,
      baseSymbol: 'WETH',
      baseMint: BASE_WETH,
      supply: 1e9,
      feeBps: 300,
      cashback: false,
      mc: 1,
      lastMc: 1,
      lane: 'new',
      seed: 1,
      launchedAt: new Date(h.now()),
      curveK: '12345',
    });
    const sig = evmHash('b2');
    h.rpcs.BASE.setEvmReceipt(
      sig,
      evmLaunchReceipt({
        wallet: address,
        launchpad: BASE_LAUNCHPAD,
        data: p.body.data!,
        token: tokenAddr,
        ticker: 'BPH',
      }),
    );
    expect((await confirm(token, p.body.intentId, sig)).status).toBe(200);
    const row = await loadToken('BASE', 'BPH');
    expect(row?.name).toBe('Base Placeholder');
    expect(row?.descr).toBe('real words');
    expect(row?.curveK).toBe('12345');
    expect(row?.baseSymbol).toBe('WETH');
  });

  it('leaves a row alone once it no longer holds placeholder metadata', async () => {
    const { token, address } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'kept', descr: 'from intent' });
    const intent = await loadIntent(p.body.intentId);
    await h.deps.db.insert(tokens).values({
      net: 'SOL',
      sym: 'KEPT',
      name: 'Moon Coin',
      descr: 'already curated',
      creator: address,
      mint: p.body.predictedMint!,
      baseSymbol: 'SOL',
      baseMint: intent.baseMint,
      supply: 1e9,
      feeBps: 250,
      cashback: false,
      mc: 1,
      lastMc: 1,
      lane: 'new',
      seed: 1,
      launchedAt: new Date(h.now()),
    });
    const sig = solSig(13);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    expect((await confirm(token, p.body.intentId, sig)).status).toBe(200);
    expect((await loadToken('SOL', 'KEPT'))?.descr).toBe('already curated');
  });

  it('puts the confirmed coin on the live board immediately', async () => {
    const events: Record<string, unknown>[] = [];
    const unsubscribe = await h.redis.subscribe('board', (message) => {
      events.push(JSON.parse(message) as Record<string, unknown>);
    });
    try {
      const { token, address } = await h.login('SOL');
      const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'live' });
      const intent = await loadIntent(p.body.intentId);
      const sig = solSig(14);
      h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
      expect((await confirm(token, p.body.intentId, sig)).status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'token_created',
        net: 'SOL',
        sym: 'LIVE',
        payload: { mint: p.body.predictedMint, name: 'Moon Coin', creator: address, lane: 'new' },
      });
      // An idempotent re-confirm does not re-announce.
      await confirm(token, p.body.intentId, sig);
      expect(events).toHaveLength(1);
    } finally {
      await unsubscribe();
    }
  });
});

describe('launch input validation', () => {
  it('refuses a name over the Solana program 32-byte limit instead of building a failing tx', async () => {
    const { token } = await h.login('SOL');
    // 12 characters, 36 bytes: the old 64-character slice let this through.
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'longname',
      name: '月月月月月月月月月月月月',
    });
    expect(status).toBe(422);
    expect(body.error).toBe('name_too_long');
  });

  it('strips invisible characters from the name before it goes on-chain', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'zwsp',
      name: '\u202EZw\u200Bsp\u0000 Coin ',
    });
    expect(status).toBe(200);
    expect((await loadIntent(body.intentId)).name).toBe('Zwsp Coin');
  });

  it('only accepts https:// or ipfs:// image links', async () => {
    const { token } = await h.login('SOL');
    for (const uri of [
      'javascript:alert(1)',
      'http://img.example/a.png',
      'data:image/png;base64,AA',
    ]) {
      const { status, body } = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'baduri', uri });
      expect(status).toBe(422);
      expect(body.error).toBe('invalid_uri');
    }
  });

  it('refuses malformed socials with an actionable code', async () => {
    const { token } = await h.login('SOL');
    const x = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'badx', x: 'not a handle!' });
    expect(x.status).toBe(422);
    expect(x.body.error).toBe('invalid_social');
    const web = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'badweb',
      web: 'javascript:alert(1)',
    });
    expect(web.status).toBe(422);
    expect(web.body.error).toBe('invalid_social');
  });

  it('refuses a dev buy beyond the per-net cap', async () => {
    const { token } = await h.login('SOL');
    const { status, body } = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'whale',
      devBuyNative: 1e9,
    });
    expect(status).toBe(422);
    expect(body.error).toBe('dev_buy_too_large');
  });

  it('holds the name cooldown against a Cyrillic look-alike', async () => {
    const { token } = await h.login('SOL');
    const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'pepe', name: 'Pepe' });
    const intent = await loadIntent(p.body.intentId);
    const sig = solSig(12);
    h.rpcs.SOL.setSolanaTransactionMessage(sig, intent.unsignedPayload);
    expect((await confirm(token, p.body.intentId, sig)).status).toBe(200);

    const b = await h.login('SOL', solanaWallet('homoglyph-squatter'));
    const clone = await prepare(b.token, { ...SOL_TICKER_BODY, ticker: 'pepe2', name: 'Реpe' });
    expect(clone.status).toBe(409);
    expect(clone.body.error).toBe('name_or_ticker_cooldown');
  });

  it('no longer rejects ordinary words that merely contain a blocked substring', async () => {
    const { token } = await h.login('SOL');
    const ok = await prepare(token, {
      ...SOL_TICKER_BODY,
      ticker: 'spicy',
      name: 'Spicy Grape',
      descr: 'skyscraper therapeutic flame retardant',
    });
    expect(ok.status).toBe(200);
  });
});

describe('pre-sign preflight simulation', () => {
  it('maps an EVM "stale oracle" revert to a retryable oracle_stale and records nothing', async () => {
    const { token } = await h.login('BASE');
    h.rpcs.BASE.setSimulation({ ok: false, reason: 'execution reverted: stale oracle' });
    const { status, body } = await prepare(token, { ...EVM_BODY, ticker: 'stale' });
    expect(status).toBe(503);
    expect(body.error).toBe('oracle_stale');
    expect(body.detail).toMatch(/try again/);
    expect((body as { retryAfter?: number }).retryAfter).toBe(60);
    const rows = await h.deps.db
      .select()
      .from(launchIntents)
      .where(eq(launchIntents.ticker, 'STALE'));
    expect(rows).toHaveLength(0);
  });

  it('simulates as the creator, against the launchpad, with the exact calldata', async () => {
    const { token, address } = await h.login('BASE');
    let seen: { from?: string; to?: string; data: string } | null = null;
    h.rpcs.BASE.setSimulation((payload) => {
      seen = payload;
      return { ok: true };
    });
    const { status, body } = await prepare(token, { ...EVM_BODY, ticker: 'simok' });
    expect(status).toBe(200);
    expect(seen).toEqual({ from: address, to: BASE_LAUNCHPAD, data: body.data });
  });

  it.each([
    ['execution reverted: launch paused', 503, 'launch_paused'],
    ['execution reverted: ticker', 422, 'invalid_ticker'],
    ['execution reverted: something internal 0xdeadbeef', 422, 'simulation_failed'],
  ])('maps EVM revert %j to %i %s', async (reason, status, code) => {
    const { token } = await h.login('RH');
    h.rpcs.RH.setSimulation({ ok: false, reason });
    const res = await prepare(token, { ...EVM_BODY, ticker: 'revmap' });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    expect(res.body.detail).not.toContain('0xdeadbeef');
  });

  it('maps Solana program errors (Anchor logs) to actionable codes', async () => {
    const { token } = await h.login('SOL');
    h.rpcs.SOL.setSimulation({
      ok: false,
      reason:
        '{"InstructionError":[0,{"Custom":6008}]}\nProgram log: AnchorError occurred. Error Code: OracleStale. Error Number: 6008. Error Message: Oracle price is stale.',
    });
    const stale = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'solstale' });
    expect(stale.status).toBe(503);
    expect(stale.body.error).toBe('oracle_stale');

    h.rpcs.SOL.setSimulation({ ok: false, reason: '"InsufficientFundsForFee"\n' });
    const broke = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'solbroke' });
    expect(broke.status).toBe(422);
    expect(broke.body.error).toBe('insufficient_funds');
    expect(broke.body.detail).toMatch(/SOL/);
  });

  it('lets the prepare through when the simulation RPC itself is down', async () => {
    const { token } = await h.login('SOL');
    h.rpcs.SOL.setSimulationFailing(true);
    const { status } = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'simdown' });
    expect(status).toBe(200);
  });

  it('does not charge the wallet quota for a preflight refusal', async () => {
    const app = await createTestApp({
      env: {
        LAUNCH_RATE_LIMIT_PER_WALLET: '1',
        BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD,
      },
    });
    try {
      const { token } = await app.login('BASE', evmWallet('quota-preflight'));
      app.rpcs.BASE.setSimulation({ ok: false, reason: 'execution reverted: stale oracle' });
      expect((await prepare(token, { ...EVM_BODY, ticker: 'qpa' }, app)).status).toBe(503);
      app.rpcs.BASE.setSimulation({ ok: true });
      expect((await prepare(token, { ...EVM_BODY, ticker: 'qpa' }, app)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('Solana dev buy pricing', () => {
  it('sizes minOut off the on-chain BaseOracle price with a 1% tolerance', async () => {
    const { token } = await h.login('SOL');
    const programId = new PublicKey(h.deps.env.solanaLaunchpadProgramId);
    const wsol = new PublicKey('So11111111111111111111111111111111111111112');
    const pda = solanaOraclePda(programId, wsol).toBase58();
    // On-chain SOL at $150 while the off-chain oracle says $214.08.
    h.rpcs.SOL.setAccountData(
      pda,
      encodeSolanaBaseOracle(wsol, { price1e6: 150_000_000n, baseDecimals: 9 }).toString('base64'),
    );
    try {
      const { status, body } = await prepare(token, {
        ...SOL_TICKER_BODY,
        ticker: 'devbuy',
        devBuyNative: 0.5,
      });
      expect(status).toBe(200);
      const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
      const buy = tx.instructions[tx.instructions.length - 1]!;
      expect(buy.programId.equals(programId)).toBe(true);
      const amountIn = buy.data.readBigUInt64LE(8);
      const minOut = buy.data.readBigUInt64LE(16);
      expect(amountIn).toBe(500_000_000n);

      const curve = deriveCurveColumns(1_000_000_000n * 10n ** 6n, 150_000_000n, 9, 6, 'SOL')!;
      const exact = buyQuote(freshState(curve.params), 250, amountIn)!.tokensOut;
      expect(minOut).toBe((exact * 9_900n) / 10_000n);
      // No Pyth feed account on this RPC: no sync is bundled.
      expect(tx.instructions.some((ix) => ix.data.subarray(0, 8).equals(SYNC_DISC))).toBe(false);
    } finally {
      h.rpcs.SOL.setAccountData(pda, null);
    }
  });

  describe('with the Pyth SOL/USD push feed', () => {
    const programId = () => new PublicKey(h.deps.env.solanaLaunchpadProgramId);
    const wsol = new PublicKey('So11111111111111111111111111111111111111112');
    const feedId = pinnedPythFeedId(wsol)!;
    const feed = pythPriceFeedAccount(feedId).toBase58();
    const oraclePda = () => solanaOraclePda(programId(), wsol).toBase58();
    /** SOL at $118.61091823 (1e-8), published at t = 1_800. */
    const pythUpdate = (o: { publishTime?: number; partialSignatures?: number } = {}) =>
      encodePythPriceUpdateV2({
        feedId,
        price: 11_861_091_823n,
        conf: 5_000_000n,
        exponent: -8,
        publishTime: o.publishTime ?? 1_800,
        ...(o.partialSignatures !== undefined ? { partialSignatures: o.partialSignatures } : {}),
      }).toString('base64');

    async function devBuy(ticker: string) {
      const { token } = await h.login('SOL');
      const { status, body } = await prepare(token, {
        ...SOL_TICKER_BODY,
        ticker,
        devBuyNative: 0.5,
      });
      expect(status).toBe(200);
      const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
      const buy = tx.instructions[tx.instructions.length - 1]!;
      return { tx, minOut: buy.data.readBigUInt64LE(16), amountIn: buy.data.readBigUInt64LE(8) };
    }

    function expectedMinOut(price1e6: bigint, amountIn: bigint): bigint {
      const curve = deriveCurveColumns(1_000_000_000n * 10n ** 6n, price1e6, 9, 6, 'SOL')!;
      const exact = buyQuote(freshState(curve.params), 250, amountIn)!.tokensOut;
      return (exact * 9_900n) / 10_000n;
    }

    afterEach(() => {
      h.rpcs.SOL.setAccountData(feed, null);
      h.rpcs.SOL.setAccountData(oraclePda(), null);
    });

    it('bundles the sync first and sizes minOut off Pyth when the BaseOracle was never pushed', async () => {
      h.rpcs.SOL.setAccountData(feed, pythUpdate());
      const { tx, minOut, amountIn } = await devBuy('pythnew');
      // The sync opens the transaction (no compute-limit ix on this path).
      const sync = tx.instructions[0]!;
      expect(sync.programId.equals(programId())).toBe(true);
      expect(sync.data.equals(SYNC_DISC)).toBe(true);
      expect(sync.keys[1]!.pubkey.toBase58()).toBe(oraclePda());
      expect(sync.keys[3]!.pubkey.toBase58()).toBe(feed);
      expect(sync.keys[4]!.isSigner).toBe(true);
      expect(tx.instructions.filter((ix) => ix.data.equals(SYNC_DISC))).toHaveLength(1);
      // $118.610918 at 1e6, not the off-chain $214.08.
      expect(minOut).toBe(expectedMinOut(118_610_918n, amountIn));
    });

    it('prices off Pyth when it is newer than the stored BaseOracle, off the BaseOracle otherwise', async () => {
      h.rpcs.SOL.setAccountData(feed, pythUpdate({ publishTime: 1_800 }));
      h.rpcs.SOL.setAccountData(
        oraclePda(),
        encodeSolanaBaseOracle(wsol, {
          price1e6: 150_000_000n,
          baseDecimals: 9,
          publishTime: 1_700,
        }).toString('base64'),
      );
      const newer = await devBuy('pythwin');
      expect(newer.minOut).toBe(expectedMinOut(118_610_918n, newer.amountIn));

      // A pushed price at/after Pyth's publish time wins: the sync will no-op.
      h.rpcs.SOL.setAccountData(
        oraclePda(),
        encodeSolanaBaseOracle(wsol, {
          price1e6: 150_000_000n,
          baseDecimals: 9,
          publishTime: 1_800,
        }).toString('base64'),
      );
      const older = await devBuy('pushwin');
      expect(older.minOut).toBe(expectedMinOut(150_000_000n, older.amountIn));
      // Still bundled — it is harmless when it no-ops.
      expect(older.tx.instructions[0]!.data.equals(SYNC_DISC)).toBe(true);
    });

    it('does not bundle a partially verified update', async () => {
      h.rpcs.SOL.setAccountData(feed, pythUpdate({ partialSignatures: 3 }));
      const { tx } = await devBuy('pythpart');
      expect(tx.instructions.some((ix) => ix.data.subarray(0, 8).equals(SYNC_DISC))).toBe(false);
    });

    it('drops the sync (and prices off the BaseOracle) when it would push a legacy launch over the packet', async () => {
      h.rpcs.SOL.setAccountData(feed, pythUpdate({ publishTime: 1_800 }));
      h.rpcs.SOL.setAccountData(
        oraclePda(),
        encodeSolanaBaseOracle(wsol, {
          price1e6: 150_000_000n,
          baseDecimals: 9,
          publishTime: 1_700,
        }).toString('base64'),
      );
      const { token } = await h.login('SOL');
      // No PINATA_JWT and no SOLANA_LAUNCH_ALT here: a 170-byte image URL goes
      // on-chain as-is, and name + ticker + uri (212 bytes) leave the sync no
      // room while still fitting legacy without it (1229 of 1232 bytes; the
      // params PDA appended to create_token/buy took 34 bytes off the old
      // 200-byte uri headroom — a maximal uri now needs SOLANA_LAUNCH_ALT).
      const { status, body } = await prepare(token, {
        ...SOL_TICKER_BODY,
        ticker: 'LONGESTTKR',
        name: 'N'.repeat(32),
        uri: `https://img.example/${'a'.repeat(170 - 20)}`,
        devBuyNative: 0.5,
      });
      expect(status).toBe(200);
      const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
      expect(tx.instructions.some((ix) => ix.data.subarray(0, 8).equals(SYNC_DISC))).toBe(false);
      const buy = tx.instructions[tx.instructions.length - 1]!;
      expect(buy.data.readBigUInt64LE(16)).toBe(
        expectedMinOut(150_000_000n, buy.data.readBigUInt64LE(8)),
      );
    });

    it('bundles the sync on a launch without a dev buy too', async () => {
      h.rpcs.SOL.setAccountData(feed, pythUpdate());
      const { token } = await h.login('SOL');
      const { status, body } = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'pythonly' });
      expect(status).toBe(200);
      const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
      expect(tx.instructions.map((ix) => ix.data.subarray(0, 8).equals(SYNC_DISC))).toEqual([
        true,
        false,
      ]);
    });
  });
});

const SYNC_DISC = anchorDiscriminator('sync_price_from_pyth');

describe('Solana Metaplex metadata JSON', () => {
  it('pins the metadata JSON and puts its URL on-chain, keeping the image for display', async () => {
    const app = await createTestApp({
      env: { PINATA_JWT: 'test-pinata-jwt', PINATA_GATEWAY: 'gw.example' },
    });
    const pinned: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const file = (init.body as FormData).get('file') as File;
        pinned.push(JSON.parse(await file.text()));
        return new Response(JSON.stringify({ data: { cid: 'bafymetadatajson' } }), {
          status: 200,
        });
      }),
    );
    try {
      const { token } = await app.login('SOL');
      const image = 'https://gw.example/ipfs/bafyimage/art.png';
      const p = await prepare(
        token,
        {
          ...SOL_TICKER_BODY,
          ticker: 'meta',
          descr: 'with metadata',
          uri: image,
          xHandle: 'metacoin',
          website: 'https://meta.example',
          telegram: 'https://t.me/metacoin',
        },
        app,
      );
      expect(p.status).toBe(200);
      expect(pinned).toEqual([
        {
          name: 'Moon Coin',
          symbol: 'META',
          description: 'with metadata',
          image,
          external_url: 'https://meta.example/',
          extensions: {
            website: 'https://meta.example/',
            twitter: 'https://x.com/metacoin',
            telegram: 'https://t.me/metacoin',
          },
          properties: { category: 'image', files: [{ uri: image, type: 'image/png' }] },
        },
      ]);
      const jsonUrl = 'https://gw.example/ipfs/bafymetadatajson';
      const wire = Buffer.from(p.body.transaction!, 'base64');
      expect(wire.includes(Buffer.from(jsonUrl))).toBe(true);
      expect(wire.includes(Buffer.from(image))).toBe(false);

      const [intent] = await app.deps.db
        .select()
        .from(launchIntents)
        .where(eq(launchIntents.id, p.body.intentId))
        .limit(1);
      expect(intent!.uri).toBe(image);
      expect(intent!.metadataUri).toBe(jsonUrl);

      const sig = solSig(30);
      app.rpcs.SOL.setSolanaTransactionMessage(sig, intent!.unsignedPayload);
      const res = await app.app.request('/launch/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authed(token) },
        body: JSON.stringify({ intentId: p.body.intentId, signature: sig }),
      });
      expect(res.status).toBe(200);
      const [row] = await app.deps.db
        .select()
        .from(tokens)
        .where(and(eq(tokens.net, 'SOL'), eq(tokens.sym, 'META')))
        .limit(1);
      expect(row?.imageUrl).toBe(image);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('falls back to the image URL on-chain when the pin fails, without blocking the launch', async () => {
    const app = await createTestApp({ env: { PINATA_JWT: 'test-pinata-jwt' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    try {
      const { token } = await app.login('SOL');
      const image = 'https://gw.example/ipfs/bafyimage';
      const p = await prepare(token, { ...SOL_TICKER_BODY, ticker: 'nometa', uri: image }, app);
      expect(p.status).toBe(200);
      expect(Buffer.from(p.body.transaction!, 'base64').includes(Buffer.from(image))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('leaves the EVM uri as the image URL', async () => {
    const { token } = await h.login('BASE');
    const image = 'https://gw.example/ipfs/bafyevm';
    const p = await prepare(token, { ...EVM_BODY, ticker: 'evmuri', uri: image });
    const call = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: p.body.data as `0x${string}` });
    expect(call.args?.[2]).toBe(image);
  });
});
