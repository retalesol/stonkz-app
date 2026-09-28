import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CHANNELS } from '../redis/channels.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';
import { MAX_CHANNELS_PER_SOCKET, WsHub } from './hub.js';
import { blacklistToken } from '../redis/blacklist.js';

let h: TestApp;
let server: Server;
let hub: WsHub;
let url: string;
const open: WebSocket[] = [];

beforeAll(async () => {
  h = await createTestApp();
  server = createServer();
  hub = new WsHub({
    redis: h.redis,
    jwt: h.deps.jwt,
    logger: h.deps.logger,
    metrics: h.deps.metrics,
    // Long enough that the heartbeat never interferes with an assertion.
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
});

afterEach(async () => {
  for (const socket of open.splice(0)) socket.close();
  // The hub's own close handler runs on a later turn, so connection counts are
  // only trustworthy once it has drained.
  await settled(0);
});

/** Waits for the hub's connection count to reach `n`. */
async function settled(n: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hub.connectionCount !== n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Frame {
  type?: string;
  channel?: string;
  data?: unknown;
  ok?: boolean;
  error?: string;
}

/** A client that queues frames, so a test can await the next one without racing. */
async function connect(path = url): Promise<{
  socket: WebSocket;
  next(): Promise<Frame>;
  send(payload: object): void;
  drain(): Frame[];
}> {
  const socket = new WebSocket(path);
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

  return {
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
    send: (payload) => socket.send(JSON.stringify(payload)),
    drain: () => queue.splice(0),
  };
}

async function subscribe(
  client: Awaited<ReturnType<typeof connect>>,
  channel: string,
): Promise<Frame> {
  client.send({ type: 'subscribe', channel });
  return client.next();
}

describe('handshake', () => {
  it('greets a new socket with the channels it can ask for', async () => {
    const client = await connect();
    const hello = await client.next();
    expect(hello.type).toBe('hello');
    expect(hello).toMatchObject({
      channels: ['board', 'tape', 'token:{sym}', 'user:{net}:{addr}', 'chat:{net}:{room}'],
    });
  });

  it('answers an application-level ping', async () => {
    const client = await connect();
    await client.next();
    client.send({ type: 'ping' });
    expect((await client.next()).type).toBe('pong');
  });

  it('rejects malformed json and unknown message types without dropping the socket', async () => {
    const client = await connect();
    await client.next();

    client.socket.send('not json');
    expect(await client.next()).toMatchObject({ type: 'error', error: 'bad_json' });

    client.send({ type: 'nonsense' });
    expect(await client.next()).toMatchObject({ type: 'error', error: 'unknown_type' });

    // Still usable afterwards.
    client.send({ type: 'ping' });
    expect((await client.next()).type).toBe('pong');
  });

  it('refuses an upgrade on the wrong path', async () => {
    await expect(connect(url.replace('/ws', '/nope'))).rejects.toThrow();
  });
});

/** Plan step 58 — `board` and `token:{sym}`, tagged with net. */
describe('public channels', () => {
  it('delivers board events published by the indexer', async () => {
    const client = await connect();
    await client.next();
    expect(await subscribe(client, 'board')).toMatchObject({
      type: 'subscribed',
      channel: 'board',
    });

    await h.deps.publisher.board({ type: 'koth', net: 'SOL', sym: 'MOONER', mc: 45_000 });
    const frame = await client.next();
    expect(frame.channel).toBe('board');
    // The net rides in the payload, since both chains share the board channel.
    expect(frame.data).toMatchObject({ type: 'koth', net: 'SOL', sym: 'MOONER' });
  });

  it('delivers per-token events only to that token’s room', async () => {
    const client = await connect();
    await client.next();
    await subscribe(client, CHANNELS.token('DOGE2'));

    await h.deps.publisher.token('OTHER', { type: 'graduated', net: 'SOL', sym: 'OTHER' });
    await h.deps.publisher.token('DOGE2', {
      type: 'curve',
      net: 'SOL',
      sym: 'DOGE2',
      mc: 12_345,
      price: 0.0001,
      lane: 'new',
    });

    const frame = await client.next();
    expect(frame.channel).toBe(CHANNELS.token('DOGE2'));
    expect(frame.data).toMatchObject({ sym: 'DOGE2', mc: 12_345 });
    // The OTHER event was never delivered here.
    expect(client.drain()).toEqual([]);
  });

  it('delivers the global tape feed', async () => {
    const client = await connect();
    await client.next();
    await subscribe(client, 'tape');
    await h.deps.publisher.tape({ type: 'fill', net: 'RH', sym: 'RHDOG', payload: { sol: 0.25 } });
    expect((await client.next()).channel).toBe('tape');
  });

  it('stops delivering after unsubscribe', async () => {
    const client = await connect();
    await client.next();
    await subscribe(client, 'board');

    client.send({ type: 'unsubscribe', channel: 'board' });
    expect(await client.next()).toMatchObject({ type: 'unsubscribed', channel: 'board' });

    await h.deps.publisher.board({ type: 'graduated', net: 'SOL', sym: 'X' });
    client.send({ type: 'ping' });
    // The pong arrives, and nothing precedes it.
    expect((await client.next()).type).toBe('pong');
  });

  it('is idempotent on a repeated subscribe', async () => {
    const client = await connect();
    await client.next();
    await subscribe(client, 'board');
    client.send({ type: 'subscribe', channel: 'board' });

    await h.deps.publisher.board({ type: 'graduated', net: 'SOL', sym: 'X' });
    expect((await client.next()).channel).toBe('board');
    // Exactly one copy, not two.
    client.send({ type: 'ping' });
    expect((await client.next()).type).toBe('pong');
  });

  it('fans one publish out to every subscriber', async () => {
    const a = await connect();
    const b = await connect();
    await a.next();
    await b.next();
    await subscribe(a, 'board');
    await subscribe(b, 'board');

    await h.deps.publisher.board({ type: 'graduated', net: 'SOL', sym: 'BOTH' });
    expect((await a.next()).data).toMatchObject({ sym: 'BOTH' });
    expect((await b.next()).data).toMatchObject({ sym: 'BOTH' });
  });

  it('refuses a channel that is not a real lane', async () => {
    const client = await connect();
    await client.next();
    for (const channel of ['', 'token:', 'admin', 'internal:secrets']) {
      client.send({ type: 'subscribe', channel });
      expect(await client.next()).toMatchObject({ type: 'error', error: 'forbidden' });
    }
  });
});

/** Plan step 121 — `user:{addr}` carries the seven reward events. */
describe('user channel', () => {
  it('refuses a user channel before the socket authenticates', async () => {
    const client = await connect();
    await client.next();
    client.send({ type: 'subscribe', channel: CHANNELS.user('SOL', 'anyone') });
    expect(await client.next()).toMatchObject({ type: 'error', error: 'forbidden' });
  });

  it('authenticates with an access token and admits its own channel', async () => {
    const wallet = solanaWallet('ws-own');
    const { token, address } = await h.login('SOL', wallet);
    const client = await connect();
    await client.next();

    client.send({ type: 'auth', token });
    expect(await client.next()).toMatchObject({
      type: 'auth',
      ok: true,
      net: 'SOL',
      wallet: address,
    });
    expect(await subscribe(client, CHANNELS.user('SOL', address))).toMatchObject({
      type: 'subscribed',
    });
  });

  it('will not let an authenticated wallet watch another wallet’s rewards', async () => {
    const { token } = await h.login('SOL', solanaWallet('ws-nosy'));
    const victim = solanaWallet('ws-victim');
    const client = await connect();
    await client.next();
    client.send({ type: 'auth', token });
    await client.next();

    // The whole point of the gate: XP, SP, $STONKZ credits and RWA are private.
    client.send({ type: 'subscribe', channel: CHANNELS.user('SOL', victim.address) });
    expect(await client.next()).toMatchObject({ type: 'error', error: 'forbidden' });
  });

  it('will not let a wallet watch its own address on the other chain', async () => {
    const wallet = solanaWallet('ws-crossnet');
    const { token, address } = await h.login('SOL', wallet);
    const client = await connect();
    await client.next();
    client.send({ type: 'auth', token });
    await client.next();

    client.send({ type: 'subscribe', channel: CHANNELS.user('RH', address) });
    expect(await client.next()).toMatchObject({ type: 'error', error: 'forbidden' });
  });

  it('rejects a garbage token and leaves the socket unauthenticated', async () => {
    const client = await connect();
    await client.next();
    client.send({ type: 'auth', token: 'not-a-jwt' });
    expect(await client.next()).toMatchObject({ type: 'auth', ok: false });

    client.send({ type: 'subscribe', channel: CHANNELS.user('SOL', 'whoever') });
    expect(await client.next()).toMatchObject({ type: 'error', error: 'forbidden' });
  });

  it('rejects a refresh token presented as an access token', async () => {
    const { refreshToken } = await h.login('SOL', solanaWallet('ws-refresh'));
    const client = await connect();
    await client.next();
    client.send({ type: 'auth', token: refreshToken });
    expect(await client.next()).toMatchObject({ type: 'auth', ok: false });
  });

  it('carries every reward event the ceremonies listen for', async () => {
    const wallet = solanaWallet('ws-events');
    const { token, address } = await h.login('SOL', wallet);
    const client = await connect();
    await client.next();
    client.send({ type: 'auth', token });
    await client.next();
    await subscribe(client, CHANNELS.user('SOL', address));

    const events = [
      {
        type: 'xp' as const,
        net: 'SOL' as const,
        wallet: address,
        amount: 10,
        total: 10,
        reason: 'trade',
      },
      {
        type: 'rank_up' as const,
        net: 'SOL' as const,
        wallet: address,
        rankIndex: 1,
        name: 'BAG HOLDER',
      },
      { type: 'sp' as const, net: 'SOL' as const, wallet: address, delta: 5, total: 5 },
      { type: 'stonkz' as const, net: 'SOL' as const, wallet: address, delta: 250, total: 250 },
      {
        type: 'rwa' as const,
        net: 'SOL' as const,
        wallet: address,
        asset: 'PAXG',
        units: 0.005,
        total: 0.005,
      },
      { type: 'achievement' as const, net: 'SOL' as const, wallet: address, key: 'first', xp: 100 },
      { type: 'streak' as const, net: 'SOL' as const, wallet: address, count: 3, mult: 1.2 },
      { type: 'crate_ready' as const, net: 'SOL' as const, wallet: address, tier: 'BRONZE' },
    ];

    const seen: string[] = [];
    for (const event of events) {
      await h.deps.publisher.user('SOL', address, event);
      const frame = await client.next();
      expect(frame.channel).toBe(CHANNELS.user('SOL', address));
      seen.push((frame.data as { type: string }).type);
    }
    expect(seen).toEqual(events.map((e) => e.type));
  });
});

describe('lifecycle', () => {
  it('tracks connection counts and releases them on close', async () => {
    expect(hub.connectionCount).toBe(0);
    const client = await connect();
    await client.next();
    expect(hub.connectionCount).toBe(1);

    client.socket.close();
    await settled(0);
    expect(hub.connectionCount).toBe(0);
  });

  it('keeps delivering to healthy clients after one disconnects mid-room', async () => {
    const doomed = await connect();
    const survivor = await connect();
    await doomed.next();
    await survivor.next();
    await subscribe(doomed, 'board');
    await subscribe(survivor, 'board');

    doomed.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await h.deps.publisher.board({ type: 'graduated', net: 'SOL', sym: 'STILLHERE' });
    expect((await survivor.next()).data).toMatchObject({ sym: 'STILLHERE' });
  });

  it('counts messages it sent in the metrics snapshot', async () => {
    const before = h.deps.metrics.snapshot().ws.messagesSent;
    const client = await connect();
    await client.next();
    expect(h.deps.metrics.snapshot().ws.messagesSent).toBeGreaterThan(before);
  });
});

describe('hardening', () => {
  it('refuses an access token that was logged out, like the HTTP routes do', async () => {
    const wallet = solanaWallet('ws-revoked');
    const { token } = await h.login('SOL', wallet);
    const claims = await h.deps.jwt.verify(token, 'access');
    await blacklistToken(h.redis, claims.jti, 60);

    const client = await connect();
    await client.next();
    client.send({ type: 'auth', token });
    expect(await client.next()).toMatchObject({ type: 'auth', ok: false });
  });

  it('caps the channels one socket may hold, and frees a slot on unsubscribe', async () => {
    const client = await connect();
    await client.next();
    for (let i = 0; i < MAX_CHANNELS_PER_SOCKET; i++) {
      expect(await subscribe(client, `token:CAP${i}`)).toMatchObject({ type: 'subscribed' });
    }
    expect(await subscribe(client, 'token:ONEMORE')).toMatchObject({
      type: 'error',
      error: 'too_many_channels',
    });
    client.send({ type: 'unsubscribe', channel: 'token:CAP0' });
    expect(await client.next()).toMatchObject({ type: 'unsubscribed' });
    expect(await subscribe(client, 'token:ONEMORE')).toMatchObject({ type: 'subscribed' });
  });
});
