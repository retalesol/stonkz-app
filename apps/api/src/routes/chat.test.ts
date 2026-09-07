import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, authed, type TestApp } from '../test/app.js';

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

describe('POST /chat/:net/:room', () => {
  it('persists a message and it shows up in history', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/chat/SOL/GLOBAL', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'gm degens' }),
    });
    expect(res.status).toBe(200);

    const history = await h.app.request('/chat/SOL/GLOBAL/history');
    const body = (await history.json()) as { messages: { text: string }[] };
    expect(body.messages.map((m) => m.text)).toContain('gm degens');
  });

  it('normalises a token room whether or not it is prefixed with $', async () => {
    const { token } = await h.login('SOL');
    await h.app.request('/chat/SOL/$WOJAK', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'nice chart' }),
    });
    const history = await h.app.request('/chat/SOL/WOJAK/history');
    const body = (await history.json()) as { messages: { text: string }[]; room: string };
    expect(body.room).toBe('WOJAK');
    expect(body.messages.map((m) => m.text)).toContain('nice chart');
  });

  it('rejects a message over 140 chars', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/chat/SOL/GLOBAL', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(141) }),
    });
    expect(res.status).toBe(400);
  });

  it('flags a moderated message and keeps it out of the public history', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/chat/SOL/GLOBAL', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'you are a fucking idiot' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { flagged: boolean } };
    expect(body.message.flagged).toBe(true);

    const history = await h.app.request('/chat/SOL/GLOBAL/history');
    const historyBody = (await history.json()) as { messages: { text: string }[] };
    expect(historyBody.messages).toHaveLength(0);
  });

  it('rate-limits a wallet sending too many messages too fast', async () => {
    const { token } = await h.login('SOL');
    let lastStatus = 200;
    for (let i = 0; i < 25; i++) {
      const res = await h.app.request('/chat/SOL/GLOBAL', {
        method: 'POST',
        headers: { ...authed(token), 'content-type': 'application/json' },
        body: JSON.stringify({ text: `msg ${i}` }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
