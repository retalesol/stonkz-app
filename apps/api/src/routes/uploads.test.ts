import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, sniffImageType } from '../social/pinata.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp({ env: { PINATA_JWT: 'test-pinata-jwt', PINATA_GATEWAY: 'gw.example' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00');
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode('WEBPVP8 '),
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');

async function upload(
  token: string,
  bytes: Uint8Array,
  type: string,
  path = '/uploads/image',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type }), 'art.png');
  const res = await h.app.request(path, { method: 'POST', headers: authed(token), body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('sniffImageType', () => {
  it('recognises the four allowed formats by magic number and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('POST /uploads/image', () => {
  it('requires a session', async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([PNG.slice().buffer as ArrayBuffer], { type: 'image/png' }),
      'a.png',
    );
    const res = await h.app.request('/uploads/image', { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });

  it('refuses SVG outright', async () => {
    const { token } = await h.login('SOL');
    const res = await upload(token, SVG, 'image/svg+xml');
    expect(res.status).toBe(415);
    expect(res.body['error']).toBe('bad_type');
  });

  it('refuses markup that claims to be a PNG', async () => {
    const { token } = await h.login('SOL');
    for (const bytes of [HTML, SVG]) {
      const res = await upload(token, bytes, 'image/png');
      expect(res.status).toBe(415);
      expect(res.body['error']).toBe('bad_type');
    }
  });

  it('refuses a body over 5 MB before buffering it', async () => {
    const { token } = await h.login('SOL');
    const big = new Uint8Array(MAX_IMAGE_BYTES + 128 * 1024);
    big.set(PNG);
    const res = await upload(token, big, 'image/png');
    expect(res.status).toBe(413);
    expect(res.body['error']).toBe('too_large');
  });

  it('uploads a real image with its sniffed type and returns the gateway URL', async () => {
    const { token } = await h.login('SOL');
    let sentType = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const file = (init.body as FormData).get('file') as File;
        sentType = file.type;
        return new Response(JSON.stringify({ data: { cid: 'bafytest', size: 12 } }), {
          status: 200,
        });
      }),
    );
    // Declared as PNG, actually a WebP: allowed, and forwarded as what it is.
    const res = await upload(token, WEBP, 'image/png');
    expect(res.status).toBe(200);
    expect(res.body['url']).toBe('https://gw.example/ipfs/bafytest');
    expect(sentType).toBe('image/webp');
  });

  it('does not leak the upstream error body to the browser', async () => {
    const { token } = await h.login('SOL');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('internal: key sk_live_123 over quota', { status: 500 })),
    );
    const res = await upload(token, PNG, 'image/png');
    expect(res.status).toBe(502);
    expect(res.body['error']).toBe('upload_failed');
    expect(JSON.stringify(res.body)).not.toContain('sk_live_123');
  });
});

describe('PATCH /me links', () => {
  async function patchMe(token: string, body: Record<string, unknown>) {
    const res = await h.app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authed(token) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('refuses script and data URLs for website and avatar', async () => {
    const { token } = await h.login('SOL');
    expect((await patchMe(token, { website: 'javascript:alert(1)' })).status).toBe(400);
    expect((await patchMe(token, { avatarUrl: 'data:image/svg+xml,<svg/>' })).status).toBe(400);
    expect((await patchMe(token, { avatarUrl: 'http://img.example/a.png' })).status).toBe(400);
  });

  it('normalises a bare domain website and still allows clearing it', async () => {
    const { token } = await h.login('SOL');
    const set = await patchMe(token, { website: 'stonkz.xyz' });
    expect(set.status).toBe(200);
    expect((set.body['profile'] as Record<string, unknown>)['website']).toBe('https://stonkz.xyz/');
    const cleared = await patchMe(token, { website: '' });
    expect((cleared.body['profile'] as Record<string, unknown>)['website']).toBeNull();
  });
});
