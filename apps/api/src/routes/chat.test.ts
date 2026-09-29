import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Net } from '@stonkz/shared';
import { createTestApp, authed, type TestApp } from '../test/app.js';
import { evmWallet, solanaWallet, type TestWallet } from '../test/wallets.js';
import { holdersSnapshot, tokens, trades } from '../db/schema.js';
import {
  CHAT_HOLDER_GATE_USD,
  CHAT_VOLUME_GATE_USD,
  ChatService,
  parseChatChannel,
  parseRoom,
  type ChatAccess,
  type ChainBalanceReader,
} from '../social/chat.js';

let h: TestApp;

/** On-chain balances the fallback reader answers with, keyed `net:mint:wallet`. */
const chainBalances = new Map<string, number>();
let chainReads = 0;
const fakeChain: ChainBalanceReader = async (net, mint, wallet) => {
  chainReads++;
  return chainBalances.get(`${net}:${mint}:${wallet}`) ?? 0;
};

beforeAll(async () => {
  h = await createTestApp();
  // Swap in a chat service whose chain reads are scripted; everything else is the real wiring.
  h.deps.chat = new ChatService({
    db: h.deps.db,
    redis: h.redis,
    now: h.now,
    chainBalance: fakeChain,
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  chainBalances.clear();
  chainReads = 0;
  // Drop the gate caches so a seed in one test never leaks into the next.
  const keys = await h.redis.keys('chat:*');
  if (keys.length) await h.redis.del(...keys);
});

const MINT = 'WoJaKMint11111111111111111111111111111111111';
const BASE_MINT = '0x00000000000000000000000000000000000b45e2';

/** A token priced at exactly $1 (mc / supply), so tokens == dollars in assertions. */
async function seedToken(net: Net = 'SOL', sym = 'WOJAK', mint = MINT): Promise<void> {
  await h.deps.db.insert(tokens).values({
    net,
    sym,
    name: sym,
    creator: 'creator',
    mint,
    baseSymbol: net === 'SOL' ? 'SOL' : 'ETH',
    baseMint: 'base',
    supply: 1_000_000,
    feeBps: 100,
    mc: 1_000_000,
    seed: 7,
  });
}

let tradeSeq = 0;
async function seedTrade(
  net: Net,
  trader: string,
  usdValue: number,
  opts: { sym?: string; mint?: string | null; side?: 'buy' | 'sell'; atMs?: number } = {},
): Promise<void> {
  tradeSeq++;
  await h.deps.db.insert(trades).values({
    net,
    sym: opts.sym ?? 'WOJAK',
    mint: opts.mint === undefined ? MINT : opts.mint,
    txSig: `sig-${tradeSeq}`,
    logIndex: 0,
    side: opts.side ?? 'buy',
    trader,
    nativeAmount: usdValue / 200,
    baseAmount: usdValue / 200,
    tokenAmount: usdValue,
    usdValue,
    mc: 1_000_000,
    price: 1,
    blockTime: new Date(opts.atMs ?? h.now() - 3_600_000),
    chainPosition: tradeSeq,
  });
}

async function seedHolder(
  net: Net,
  wallet: string,
  tokenAmount: number,
  opts: { mint?: string; sym?: string; updatedAtMs?: number } = {},
): Promise<void> {
  await h.deps.db.insert(holdersSnapshot).values({
    net,
    sym: opts.sym ?? 'WOJAK',
    mint: opts.mint ?? MINT,
    wallet,
    tokenAmount,
    updatedAt: new Date(opts.updatedAtMs ?? h.now() - 3_600_000),
  });
}

/** A wallet with enough lifetime volume to post in the public rooms. */
async function trader(
  net: Net = 'SOL',
  w?: TestWallet,
): Promise<{ token: string; address: string }> {
  const login = await h.login(net, w);
  await seedTrade(net, login.address, CHAT_VOLUME_GATE_USD);
  return login;
}

async function post(net: Net, room: string, token: string, text: string): Promise<Response> {
  return h.app.request(`/chat/${net}/${encodeURIComponent(room)}`, {
    method: 'POST',
    headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function access(net: Net, room: string, token?: string): Promise<ChatAccess> {
  const res = await h.app.request(
    `/chat/${net}/${encodeURIComponent(room)}/access`,
    token ? { headers: authed(token) } : undefined,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ChatAccess;
}

describe('room keys', () => {
  it('parses GLOBAL, a token room and the holders room, with or without the $', () => {
    expect(parseRoom('GLOBAL')).toEqual({ kind: 'global', key: 'GLOBAL' });
    expect(parseRoom('$wojak')).toEqual({ kind: 'token', key: 'WOJAK', sym: 'WOJAK' });
    expect(parseRoom('$WOJAK:private')).toEqual({
      kind: 'private',
      key: 'WOJAK:PRIVATE',
      sym: 'WOJAK',
    });
    expect(parseChatChannel('chat:SOL:WOJAK:PRIVATE')).toEqual({
      net: 'SOL',
      room: { kind: 'private', key: 'WOJAK:PRIVATE', sym: 'WOJAK' },
    });
    expect(parseChatChannel('token:WOJAK')).toBeNull();
    expect(parseChatChannel('chat:SOL:')).toBeNull();
  });
});

describe('POST /chat/:net/:room', () => {
  it('persists a message and it shows up in history', async () => {
    const { token } = await trader();
    const res = await post('SOL', 'GLOBAL', token, 'gm degens');
    expect(res.status).toBe(200);

    const history = await h.app.request('/chat/SOL/GLOBAL/history');
    const body = (await history.json()) as { messages: { text: string }[] };
    expect(body.messages.map((m) => m.text)).toContain('gm degens');
  });

  it('normalises a token room whether or not it is prefixed with $', async () => {
    const { token } = await trader();
    await post('SOL', '$WOJAK', token, 'nice chart');
    const history = await h.app.request('/chat/SOL/WOJAK/history');
    const body = (await history.json()) as { messages: { text: string }[]; room: string };
    expect(body.room).toBe('WOJAK');
    expect(body.messages.map((m) => m.text)).toContain('nice chart');
  });

  it('rejects a message over 140 chars', async () => {
    const { token } = await trader();
    const res = await post('SOL', 'GLOBAL', token, 'x'.repeat(141));
    expect(res.status).toBe(400);
  });

  it('flags a moderated message and keeps it out of the public history', async () => {
    const { token } = await trader();
    const res = await post('SOL', 'GLOBAL', token, 'you are a fucking idiot');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { flagged: boolean } };
    expect(body.message.flagged).toBe(true);

    const history = await h.app.request('/chat/SOL/GLOBAL/history');
    const historyBody = (await history.json()) as { messages: { text: string }[] };
    expect(historyBody.messages).toHaveLength(0);
  });

  it('rate-limits a wallet sending too many messages too fast', async () => {
    const { token } = await trader();
    let lastStatus = 200;
    for (let i = 0; i < 25; i++) {
      lastStatus = (await post('SOL', 'GLOBAL', token, `msg ${i}`)).status;
    }
    expect(lastStatus).toBe(429);
  });

  it('shares one rate-limit bucket across every room, so the private room is no escape hatch', async () => {
    const { token, address } = await trader();
    await seedToken();
    await seedHolder('SOL', address, 50);
    for (let i = 0; i < 20; i++)
      expect((await post('SOL', 'GLOBAL', token, `m${i}`)).status).toBe(200);
    expect((await post('SOL', 'WOJAK:PRIVATE', token, 'still me')).status).toBe(429);
    expect((await post('SOL', 'WOJAK', token, 'still me')).status).toBe(429);
  });
});

describe('the $100 lifetime-volume gate', () => {
  it('reports a guest as read-only with the gate numbers', async () => {
    const a = await access('SOL', 'GLOBAL');
    expect(a).toMatchObject({
      signedIn: false,
      canRead: true,
      canPost: false,
      reason: 'unauthorized',
      volumeUsd: null,
      volumeRequiredUsd: CHAT_VOLUME_GATE_USD,
    });
  });

  it('refuses a signed-in wallet under $100 with its progress, in GLOBAL and the token room', async () => {
    const { token, address } = await h.login('SOL');
    await seedTrade('SOL', address, 42.5);

    for (const room of ['GLOBAL', 'WOJAK']) {
      const res = await post('SOL', room, token, 'let me in');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; access: ChatAccess };
      expect(body.error).toBe('volume_required');
      expect(body.access.volumeUsd).toBeCloseTo(42.5);
      expect(body.access.canRead).toBe(true);
    }
    const history = await h.app.request('/chat/SOL/GLOBAL/history');
    expect(((await history.json()) as { messages: unknown[] }).messages).toHaveLength(0);

    const a = await access('SOL', 'GLOBAL', token);
    expect(a).toMatchObject({ signedIn: true, canPost: false, reason: 'volume_required' });
    expect(a.volumeUsd).toBeCloseTo(42.5);
  });

  it('sums buys and sells across every net for the same wallet', async () => {
    const w = evmWallet('multi-net');
    const { token, address } = await h.login('RH', w);
    await seedTrade('RH', address, 40, { side: 'buy', mint: null, sym: 'RHDOG' });
    await seedTrade('BASE', address, 35, { side: 'sell', mint: null, sym: 'BDOG' });
    expect((await post('RH', 'GLOBAL', token, 'not yet')).status).toBe(403);

    await seedTrade('ARC', address, 25, { side: 'buy', mint: null, sym: 'ADOG' });
    await h.deps.chat.invalidateVolume(address);
    const res = await post('RH', 'GLOBAL', token, 'exactly 100');
    expect(res.status).toBe(200);
  });

  it('caches the volume briefly and refreshes after the cache window', async () => {
    const { token, address } = await h.login('SOL');
    await seedTrade('SOL', address, 10);
    expect((await access('SOL', 'GLOBAL', token)).volumeUsd).toBeCloseTo(10);

    await seedTrade('SOL', address, 200);
    // Still the cached figure inside the window…
    expect((await access('SOL', 'GLOBAL', token)).volumeUsd).toBeCloseTo(10);
    // …and the fresh sum once it lapses.
    h.advance(31_000);
    expect((await access('SOL', 'GLOBAL', token)).volumeUsd).toBeCloseTo(210);
    expect((await post('SOL', 'GLOBAL', token, 'unlocked')).status).toBe(200);
  });

  it('ignores volume that belongs to a different wallet', async () => {
    const other = await h.login('SOL', solanaWallet('other'));
    await seedTrade('SOL', other.address, 5_000);
    const { token } = await h.login('SOL', solanaWallet('me'));
    expect((await post('SOL', 'GLOBAL', token, 'hi')).status).toBe(403);
  });
});

describe('the $5 holders room', () => {
  it('is invisible to guests and to a signed-in non-holder, with the lock reason', async () => {
    await seedToken();
    const guest = await h.app.request('/chat/SOL/WOJAK:PRIVATE/history');
    expect(guest.status).toBe(401);

    const { token } = await trader();
    const res = await h.app.request('/chat/SOL/WOJAK:PRIVATE/history', { headers: authed(token) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; access: ChatAccess };
    expect(body.error).toBe('holder_required');
    expect(body.access).toMatchObject({
      kind: 'private',
      sym: 'WOJAK',
      canRead: false,
      canPost: false,
      holdingUsd: 0,
      holdingRequiredUsd: CHAT_HOLDER_GATE_USD,
    });
    expect((await post('SOL', 'WOJAK:PRIVATE', token, 'sneaking in')).status).toBe(403);
  });

  it('admits a holder the indexer already knows about, without touching the chain', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 12);

    const a = await access('SOL', '$WOJAK:PRIVATE', token);
    expect(a).toMatchObject({ canRead: true, canPost: true, reason: null });
    expect(a.holdingUsd).toBeCloseTo(12);
    expect(chainReads).toBe(0);

    expect((await post('SOL', 'WOJAK:PRIVATE', token, 'holders only')).status).toBe(200);
    const history = await h.app.request('/chat/SOL/WOJAK:PRIVATE/history', {
      headers: authed(token),
    });
    expect(history.status).toBe(200);
    const body = (await history.json()) as { room: string; messages: { text: string }[] };
    expect(body.room).toBe('WOJAK:PRIVATE');
    expect(body.messages.map((m) => m.text)).toEqual(['holders only']);
  });

  it('falls back to the chain when the indexer row is missing, so a fresh buyer gets in', async () => {
    await seedToken();
    const { token, address } = await trader();
    chainBalances.set(`SOL:${MINT}:${address}`, 8);

    const a = await access('SOL', 'WOJAK:PRIVATE', token);
    expect(a.canRead).toBe(true);
    expect(a.holdingUsd).toBeCloseTo(8);
    expect(chainReads).toBe(1);
  });

  it('falls back to the chain when the indexer row is below the gate', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 1);
    chainBalances.set(`SOL:${MINT}:${address}`, 30);
    expect((await access('SOL', 'WOJAK:PRIVATE', token)).canRead).toBe(true);
    expect(chainReads).toBe(1);
  });

  it('distrusts an indexer row that a trade inside the last minute has outdated', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 50, { updatedAtMs: h.now() - 120_000 });
    // Sold 20 seconds ago; the snapshot has not caught up, the chain says 0.
    await seedTrade('SOL', address, 50, { side: 'sell', atMs: h.now() - 20_000 });
    chainBalances.set(`SOL:${MINT}:${address}`, 0);

    const a = await access('SOL', 'WOJAK:PRIVATE', token);
    expect(a.canRead).toBe(false);
    expect(a.reason).toBe('holder_required');
    expect(chainReads).toBe(1);
  });

  it('keeps the indexer row when the RPC is down', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 1);
    h.deps.chat = new ChatService({
      db: h.deps.db,
      redis: h.redis,
      now: h.now,
      chainBalance: async () => {
        throw new Error('rpc down');
      },
    });
    try {
      const a = await access('SOL', 'WOJAK:PRIVATE', token);
      expect(a.canRead).toBe(false);
      expect(a.holdingUsd).toBeCloseTo(1);
    } finally {
      h.deps.chat = new ChatService({
        db: h.deps.db,
        redis: h.redis,
        now: h.now,
        chainBalance: fakeChain,
      });
    }
  });

  it('locks the room again once a holder sells below $5', async () => {
    await seedToken();
    const { token, address } = await trader();
    chainBalances.set(`SOL:${MINT}:${address}`, 20);
    expect((await post('SOL', 'WOJAK:PRIVATE', token, 'in')).status).toBe(200);

    chainBalances.set(`SOL:${MINT}:${address}`, 2);
    await h.deps.chat.invalidateHolding('SOL', 'WOJAK', address);
    const res = await post('SOL', 'WOJAK:PRIVATE', token, 'still in?');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('holder_required');
    const history = await h.app.request('/chat/SOL/WOJAK:PRIVATE/history', {
      headers: authed(token),
    });
    expect(history.status).toBe(403);
  });

  it('prices the position with the API token price, and on EVM through balanceOf decimals', async () => {
    await seedToken('RH', 'RHDOG', BASE_MINT);
    const { token, address } = await trader('RH', evmWallet('holder'));
    // 4 tokens at $1 each is under the gate; 6 clears it.
    chainBalances.set(`RH:${BASE_MINT}:${address}`, 4);
    expect((await access('RH', 'RHDOG:PRIVATE', token)).canRead).toBe(false);
    await h.deps.chat.invalidateHolding('RH', 'RHDOG', address);
    chainBalances.set(`RH:${BASE_MINT}:${address}`, 6);
    expect((await access('RH', 'RHDOG:PRIVATE', token)).canRead).toBe(true);
  });

  it('reports an unknown token rather than admitting anyone', async () => {
    const { token } = await trader();
    const a = await access('SOL', 'NOPE:PRIVATE', token);
    expect(a).toMatchObject({ canRead: false, canPost: false, reason: 'unknown_token' });
    expect((await post('SOL', 'NOPE:PRIVATE', token, 'hello?')).status).toBe(404);
  });

  it('still runs the flagged-word filter inside the holders room', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 50);
    const res = await post('SOL', 'WOJAK:PRIVATE', token, 'kys');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: { flagged: boolean } }).message.flagged).toBe(true);
    const history = await h.app.request('/chat/SOL/WOJAK:PRIVATE/history', {
      headers: authed(token),
    });
    expect(((await history.json()) as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

describe('room isolation', () => {
  it('keeps GLOBAL, the token room and the holders room apart in history', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 50);
    await post('SOL', 'GLOBAL', token, 'in global');
    await post('SOL', 'WOJAK', token, 'in public wojak');
    await post('SOL', 'WOJAK:PRIVATE', token, 'in private wojak');

    const texts = async (room: string): Promise<string[]> => {
      const res = await h.app.request(`/chat/SOL/${room}/history`, { headers: authed(token) });
      return ((await res.json()) as { messages: { text: string }[] }).messages.map((m) => m.text);
    };
    expect(await texts('GLOBAL')).toEqual(['in global']);
    expect(await texts('WOJAK')).toEqual(['in public wojak']);
    expect(await texts('WOJAK:PRIVATE')).toEqual(['in private wojak']);
  });

  it('publishes each message on its own room channel only', async () => {
    await seedToken();
    const { token, address } = await trader();
    await seedHolder('SOL', address, 50);
    const seen: string[] = [];
    const un = await h.redis.psubscribe('chat:*', (_m, channel) => {
      seen.push(channel);
    });
    try {
      await post('SOL', 'WOJAK:PRIVATE', token, 'private');
      await post('SOL', 'WOJAK', token, 'public');
      expect(seen).toEqual(['chat:SOL:WOJAK:PRIVATE', 'chat:SOL:WOJAK']);
    } finally {
      await un();
    }
  });
});
