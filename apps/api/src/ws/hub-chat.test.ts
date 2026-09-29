import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Net } from '@stonkz/shared';
import { CHANNELS } from '../redis/channels.js';
import { blacklistToken } from '../redis/blacklist.js';
import { holdersSnapshot, tokens, trades } from '../db/schema.js';
import { ChatService, type ChainBalanceReader } from '../social/chat.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';
import { WsHub, holderLockMessage } from './hub.js';

/**
 * The WS half of the chat access rules: the $100 gate on `send_chat`, the
 * holders' room on `subscribe`, eviction on a sell, and that no room's frames
 * leak into another.
 */

let h: TestApp;
let server: Server;
let hub: WsHub;
let url: string;
const open: WebSocket[] = [];

const chainBalances = new Map<string, number>();
const fakeChain: ChainBalanceReader = async (net, mint, wallet) =>
  chainBalances.get(`${net}:${mint}:${wallet}`) ?? 0;

const MINT = 'WoJaKMint11111111111111111111111111111111111';

beforeAll(async () => {
  h = await createTestApp();
  h.deps.chat = new ChatService({
    db: h.deps.db,
    redis: h.redis,
    now: h.now,
    chainBalance: fakeChain,
  });
  server = createServer();
  hub = new WsHub({
    redis: h.redis,
    jwt: h.deps.jwt,
    logger: h.deps.logger,
    metrics: h.deps.metrics,
    chat: h.deps.chat,
    publisher: h.deps.publisher,
    db: h.deps.db,
    pingIntervalMs: 60_000,
  });
  await hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.close();
});

beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  chainBalances.clear();
  const keys = await h.redis.keys('chat:*');
  if (keys.length) await h.redis.del(...keys);
});

afterEach(async () => {
  for (const socket of open.splice(0)) socket.close();
  await settled(0);
});

async function settled(n: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hub.connectionCount !== n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Frame {
  type?: string;
  channel?: string;
  data?: Record<string, unknown>;
  ok?: boolean;
  error?: string;
  reason?: string;
  message?: string;
  access?: Record<string, unknown>;
}

async function connect(): Promise<{
  socket: WebSocket;
  next(): Promise<Frame>;
  send(payload: object): void;
  drain(): Frame[];
  idle(ms?: number): Promise<Frame[]>;
}> {
  const socket = new WebSocket(url);
  open.push(socket);
  const queue: Frame[] = [];
  const waiters: ((f: Frame) => void)[] = [];

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const client = {
    socket,
    next: () =>
      new Promise<Frame>((resolve, reject) => {
        const queued = queue.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 2_000);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      }),
    send: (payload: object) => socket.send(JSON.stringify(payload)),
    drain: () => queue.splice(0),
    /** Whatever arrives in a short quiet window — for asserting that nothing does. */
    idle: async (ms = 150) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return queue.splice(0);
    },
  };
  await client.next(); // hello
  return client;
}

type Client = Awaited<ReturnType<typeof connect>>;

async function seedToken(): Promise<void> {
  await h.deps.db.insert(tokens).values({
    net: 'SOL',
    sym: 'WOJAK',
    name: 'WOJAK',
    creator: 'creator',
    mint: MINT,
    baseSymbol: 'SOL',
    baseMint: 'base',
    supply: 1_000_000,
    feeBps: 100,
    mc: 1_000_000,
    seed: 7,
  });
}

let seq = 0;
async function seedVolume(net: Net, trader: string, usdValue: number): Promise<void> {
  seq++;
  await h.deps.db.insert(trades).values({
    net,
    sym: 'WOJAK',
    mint: MINT,
    txSig: `sig-${seq}`,
    side: 'buy',
    trader,
    nativeAmount: 1,
    baseAmount: 1,
    tokenAmount: usdValue,
    usdValue,
    mc: 1_000_000,
    price: 1,
    blockTime: new Date(h.now() - 3_600_000),
    chainPosition: seq,
  });
}

async function seedHolder(wallet: string, tokenAmount: number): Promise<void> {
  await h.deps.db.insert(holdersSnapshot).values({
    net: 'SOL',
    sym: 'WOJAK',
    mint: MINT,
    wallet,
    tokenAmount,
    updatedAt: new Date(h.now() - 3_600_000),
  });
}

async function authed(
  label: string,
  opts: { volume?: number; holding?: number } = {},
): Promise<{ client: Client; token: string; address: string }> {
  const { token, address } = await h.login('SOL', solanaWallet(label));
  if (opts.volume) await seedVolume('SOL', address, opts.volume);
  if (opts.holding) await seedHolder(address, opts.holding);
  const client = await connect();
  client.send({ type: 'auth', token });
  expect(await client.next()).toMatchObject({ type: 'auth', ok: true, wallet: address });
  return { client, token, address };
}

const PRIVATE = CHANNELS.chat('SOL', 'WOJAK:PRIVATE');
const PUBLIC = CHANNELS.chat('SOL', 'WOJAK');

describe('send_chat and the $100 gate', () => {
  it('refuses an unauthenticated socket', async () => {
    const client = await connect();
    client.send({ type: 'send_chat', net: 'SOL', room: 'GLOBAL', text: 'hi' });
    expect(await client.next()).toMatchObject({ type: 'error', error: 'unauthorized' });
  });

  it('refuses a wallet under $100 with its progress and delivers nothing', async () => {
    const { client } = await authed('poor', { volume: 30 });
    const watcher = await connect();
    watcher.send({ type: 'subscribe', channel: CHANNELS.chat('SOL', 'GLOBAL') });
    await watcher.next();

    client.send({ type: 'send_chat', net: 'SOL', room: 'GLOBAL', text: 'hello?' });
    const reply = await client.next();
    expect(reply).toMatchObject({ type: 'send_chat', ok: false, error: 'volume_required' });
    expect(reply.access).toMatchObject({ volumeUsd: 30, volumeRequiredUsd: 100 });
    expect(await watcher.idle()).toEqual([]);
  });

  it('lets a $100 trader post, and fans the frame out to the room', async () => {
    const { client, address } = await authed('rich', { volume: 100 });
    const watcher = await connect();
    watcher.send({ type: 'subscribe', channel: CHANNELS.chat('SOL', 'GLOBAL') });
    await watcher.next();

    client.send({ type: 'send_chat', net: 'SOL', room: 'GLOBAL', text: 'gm' });
    expect(await client.next()).toMatchObject({ type: 'send_chat', ok: true });
    const frame = await watcher.next();
    expect(frame.channel).toBe(CHANNELS.chat('SOL', 'GLOBAL'));
    expect(frame.data).toMatchObject({ type: 'message', wallet: address, text: 'gm' });
  });

  it('unlocks as soon as a fill for the wallet crosses the tape', async () => {
    const { client, address } = await authed('climber', { volume: 60 });
    client.send({ type: 'send_chat', net: 'SOL', room: 'GLOBAL', text: 'not yet' });
    expect(await client.next()).toMatchObject({ ok: false, error: 'volume_required' });

    await seedVolume('SOL', address, 40);
    // The indexer publishes the fill after writing the trade; the hub drops the cache on it.
    await h.deps.publisher.fill('SOL', 'WOJAK', { w: address, buy: true, v: 40 }, MINT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.send({ type: 'send_chat', net: 'SOL', room: 'GLOBAL', text: 'now' });
    expect(await client.next()).toMatchObject({ type: 'send_chat', ok: true });
  });

  it('stops a socket whose token was logged out after it authenticated', async () => {
    const { client, token } = await authed('logout', { volume: 100 });
    const claims = await h.deps.jwt.verify(token, 'access');
    await blacklistToken(h.redis, claims.jti, 3_600);
    client.send({ type: 'send_chat', net: 'SOL', room: 'GLOBAL', text: 'ghost' });
    expect(await client.next()).toMatchObject({ ok: false, error: 'unauthorized' });
  });
});

describe('the holders room over WS', () => {
  it('refuses a subscribe before auth, and a non-holder after it, with the lock line', async () => {
    await seedToken();
    const guest = await connect();
    guest.send({ type: 'subscribe', channel: PRIVATE });
    expect(await guest.next()).toMatchObject({
      type: 'error',
      error: 'unauthorized',
      channel: PRIVATE,
    });

    const { client } = await authed('nonholder', { volume: 100 });
    client.send({ type: 'subscribe', channel: PRIVATE });
    const refused = await client.next();
    expect(refused).toMatchObject({
      type: 'error',
      error: 'holder_required',
      channel: PRIVATE,
      message: 'HOLD $5 OF $WOJAK TO ENTER',
    });
    expect(refused.access).toMatchObject({ holdingUsd: 0, holdingRequiredUsd: 5 });
  });

  it('admits a holder found on-chain even when the indexer has no row', async () => {
    await seedToken();
    const { client, address } = await authed('freshbuyer', { volume: 100 });
    chainBalances.set(`SOL:${MINT}:${address}`, 9);
    client.send({ type: 'subscribe', channel: PRIVATE });
    expect(await client.next()).toMatchObject({ type: 'subscribed', channel: PRIVATE });
  });

  it('keeps private frames out of the public room and vice versa', async () => {
    await seedToken();
    const { client: holder } = await authed('holder', { volume: 100, holding: 50 });
    holder.send({ type: 'subscribe', channel: PRIVATE });
    expect(await holder.next()).toMatchObject({ type: 'subscribed', channel: PRIVATE });

    const publicWatcher = await connect();
    publicWatcher.send({ type: 'subscribe', channel: PUBLIC });
    await publicWatcher.next();

    holder.send({ type: 'send_chat', net: 'SOL', room: 'WOJAK:PRIVATE', text: 'secret' });
    expect(await holder.next()).toMatchObject({ type: 'send_chat', ok: true });
    const echo = await holder.next();
    expect(echo.channel).toBe(PRIVATE);
    expect(echo.data).toMatchObject({ room: 'WOJAK:PRIVATE', text: 'secret' });
    expect(await publicWatcher.idle()).toEqual([]);

    holder.send({ type: 'send_chat', net: 'SOL', room: 'WOJAK', text: 'public' });
    expect(await holder.next()).toMatchObject({ type: 'send_chat', ok: true });
    const pub = await publicWatcher.next();
    expect(pub.data).toMatchObject({ room: 'WOJAK', text: 'public' });
    // The holder is not subscribed to the public room, so its own public line never comes back here.
    expect(await holder.idle()).toEqual([]);
  });

  it('evicts a holder who sells below $5 the moment the fill crosses the tape', async () => {
    await seedToken();
    const { client, address } = await authed('seller', { volume: 100 });
    chainBalances.set(`SOL:${MINT}:${address}`, 20);
    client.send({ type: 'subscribe', channel: PRIVATE });
    expect(await client.next()).toMatchObject({ type: 'subscribed', channel: PRIVATE });

    chainBalances.set(`SOL:${MINT}:${address}`, 1);
    await h.deps.publisher.fill('SOL', 'WOJAK', { w: address, buy: false, v: 19 }, MINT);
    expect(await client.next()).toMatchObject({
      type: 'unsubscribed',
      channel: PRIVATE,
      reason: 'holder_required',
      message: holderLockMessage('WOJAK'),
    });

    // Nothing from the room reaches the evicted socket any more…
    await h.deps.publisher.chat('SOL', 'WOJAK:PRIVATE', {
      type: 'message',
      net: 'SOL',
      room: 'WOJAK:PRIVATE',
      id: 1,
      wallet: 'someone',
      text: 'after',
      createdAtMs: h.now(),
    });
    expect(await client.idle()).toEqual([]);
    // …and posting is refused too.
    client.send({ type: 'send_chat', net: 'SOL', room: 'WOJAK:PRIVATE', text: 'still here?' });
    expect(await client.next()).toMatchObject({ ok: false, error: 'holder_required' });
  });

  it('a buy on the tape leaves a holder seated', async () => {
    await seedToken();
    const { client, address } = await authed('buyer', { volume: 100, holding: 50 });
    client.send({ type: 'subscribe', channel: PRIVATE });
    await client.next();
    await h.deps.publisher.fill('SOL', 'WOJAK', { w: address, buy: true, v: 5 }, MINT);
    expect(await client.idle()).toEqual([]);
  });

  it('evicts on a post once the position is gone, even without a tape event', async () => {
    await seedToken();
    const { client, address } = await authed('quietseller', { volume: 100 });
    chainBalances.set(`SOL:${MINT}:${address}`, 20);
    client.send({ type: 'subscribe', channel: PRIVATE });
    await client.next();

    chainBalances.set(`SOL:${MINT}:${address}`, 0);
    await h.deps.chat.invalidateHolding('SOL', 'WOJAK', address);
    client.send({ type: 'send_chat', net: 'SOL', room: 'WOJAK:PRIVATE', text: 'hm' });
    expect(await client.next()).toMatchObject({ ok: false, error: 'holder_required' });
    expect(await client.next()).toMatchObject({
      type: 'unsubscribed',
      channel: PRIVATE,
      reason: 'holder_required',
    });
  });

  it('handles auth followed immediately by a private subscribe, in order', async () => {
    await seedToken();
    const { token } = await h.login('SOL', solanaWallet('fast'));
    const claims = await h.deps.jwt.verify(token, 'access');
    await seedHolder(claims.sub, 50);
    const client = await connect();
    client.send({ type: 'auth', token });
    client.send({ type: 'subscribe', channel: PRIVATE });
    expect(await client.next()).toMatchObject({ type: 'auth', ok: true });
    expect(await client.next()).toMatchObject({ type: 'subscribed', channel: PRIVATE });
  });
});
