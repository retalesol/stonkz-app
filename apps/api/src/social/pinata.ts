/**
 * Pinata IPFS uploads (avatars + launch token images).
 *
 * JWT stays server-side (`PINATA_JWT`). The public gateway host is
 * `PINATA_GATEWAY` (no scheme). Uploads go to the v3 files endpoint with
 * `network=public`.
 *
 * The browser-declared `Content-Type` is only half the check: the bytes'
 * own magic number has to be a PNG/JPEG/WebP/GIF too, and the type sent on
 * to Pinata (which the gateway later serves) is the sniffed one. That keeps
 * an HTML or SVG payload labelled `image/png` — script on the gateway's
 * origin, a tracking pixel, a polyglot — out of launch art and avatars.
 */

const UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class PinataError extends Error {
  constructor(
    readonly code: 'not_configured' | 'bad_type' | 'too_large' | 'upload_failed',
    detail: string,
    /** Upstream response text — for the server log only, never a browser. */
    readonly upstream?: string,
  ) {
    super(detail);
    this.name = 'PinataError';
  }
}

export interface PinataUploadResult {
  cid: string;
  url: string;
  mimeType: string;
  size: number;
}

/** The image type the bytes themselves say they are, or `null`. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number): number => bytes[i] ?? -1;
  const ascii = (from: number, s: string): boolean =>
    [...s].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  if (
    at(0) === 0x89 &&
    ascii(1, 'PNG') &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return 'image/png';
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/** A filename safe to hand to Pinata's metadata: no paths, no markup. */
function safeFilename(name: string, mimeType: string): string {
  const ext = mimeType.split('/')[1] ?? 'img';
  const base = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'upload'}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

export async function uploadToPinata(opts: {
  jwt: string | undefined;
  gateway: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** Object name prefix in Pinata (default stonkz-upload). */
  name?: string;
  /** Injected in tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}): Promise<PinataUploadResult> {
  const declared = opts.mimeType.toLowerCase().split(';')[0]!.trim();
  if (!ALLOWED.has(declared)) {
    throw new PinataError('bad_type', 'image must be jpeg, png, webp or gif');
  }
  if (opts.bytes.byteLength === 0 || opts.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new PinataError('too_large', `image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
  }
  const sniffed = sniffImageType(opts.bytes);
  if (!sniffed || !ALLOWED.has(sniffed)) {
    throw new PinataError('bad_type', 'file content is not a jpeg, png, webp or gif image');
  }
  if (!opts.jwt) throw new PinataError('not_configured', 'image uploads are not configured');

  const filename = safeFilename(opts.filename, sniffed);
  const form = new FormData();
  const blob = new Blob(
    [
      opts.bytes.buffer.slice(
        opts.bytes.byteOffset,
        opts.bytes.byteOffset + opts.bytes.byteLength,
      ) as ArrayBuffer,
    ],
    { type: sniffed },
  );
  form.append('file', blob, filename);
  form.append('network', 'public');
  form.append('name', opts.name || filename);

  const res = await (opts.fetchImpl ?? fetch)(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.jwt}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PinataError(
      'upload_failed',
      'the image host rejected the upload; try again',
      `pinata ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { data?: { cid?: string; mime_type?: string; size?: number } };
  const cid = body.data?.cid;
  if (!cid) {
    throw new PinataError(
      'upload_failed',
      'the image host returned no content id; try again',
      'pinata response missing cid',
    );
  }

  const host = opts.gateway.replace(/\/+$/, '');
  return {
    cid,
    url: `https://${host}/ipfs/${cid}`,
    mimeType: sniffed,
    size: body.data?.size ?? opts.bytes.byteLength,
  };
}

/**
 * Pins a small JSON document (Solana token metadata) and returns its gateway
 * URL. The bytes are serialised here, so identical documents pin to the same
 * CID — a retried prepare does not grow the pin set.
 */
export async function uploadJsonToPinata(opts: {
  jwt: string | undefined;
  gateway: string;
  json: unknown;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ cid: string; url: string }> {
  if (!opts.jwt) throw new PinataError('not_configured', 'metadata uploads are not configured');
  const text = JSON.stringify(opts.json);
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'application/json' }), 'metadata.json');
  form.append('network', 'public');
  form.append('name', opts.name);
  const res = await (opts.fetchImpl ?? fetch)(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.jwt}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PinataError(
      'upload_failed',
      'the metadata host rejected the upload',
      `pinata ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { data?: { cid?: string } };
  const cid = body.data?.cid;
  if (!cid) {
    throw new PinataError('upload_failed', 'the metadata host returned no content id');
  }
  return { cid, url: `https://${opts.gateway.replace(/\/+$/, '')}/ipfs/${cid}` };
}

/** @deprecated Prefer `uploadToPinata` — same implementation. */
export const uploadAvatarToPinata = uploadToPinata;
