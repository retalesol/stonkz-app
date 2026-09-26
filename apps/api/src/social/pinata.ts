/**
 * Pinata IPFS uploads (avatars + launch token images).
 *
 * JWT stays server-side (`PINATA_JWT`). The public gateway host is
 * `PINATA_GATEWAY` (no scheme). Uploads go to the v3 files endpoint with
 * `network=public`.
 */

const UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class PinataError extends Error {
  constructor(
    readonly code: 'not_configured' | 'bad_type' | 'too_large' | 'upload_failed',
    detail: string,
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

export async function uploadToPinata(opts: {
  jwt: string | undefined;
  gateway: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** Object name prefix in Pinata (default stonkz-upload). */
  name?: string;
}): Promise<PinataUploadResult> {
  if (!opts.jwt) throw new PinataError('not_configured', 'PINATA_JWT is not set');
  if (!ALLOWED.has(opts.mimeType)) {
    throw new PinataError('bad_type', 'image must be jpeg, png, webp or gif');
  }
  if (opts.bytes.byteLength === 0 || opts.bytes.byteLength > MAX_BYTES) {
    throw new PinataError('too_large', `image must be between 1 byte and ${MAX_BYTES} bytes`);
  }

  const form = new FormData();
  const blob = new Blob(
    [
      opts.bytes.buffer.slice(
        opts.bytes.byteOffset,
        opts.bytes.byteOffset + opts.bytes.byteLength,
      ) as ArrayBuffer,
    ],
    { type: opts.mimeType },
  );
  form.append('file', blob, opts.filename || 'upload.png');
  form.append('network', 'public');
  form.append('name', opts.name || opts.filename || 'stonkz-upload');

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.jwt}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PinataError('upload_failed', `pinata ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { data?: { cid?: string; mime_type?: string; size?: number } };
  const cid = body.data?.cid;
  if (!cid) throw new PinataError('upload_failed', 'pinata response missing cid');

  const host = opts.gateway.replace(/\/+$/, '');
  return {
    cid,
    url: `https://${host}/ipfs/${cid}`,
    mimeType: body.data?.mime_type ?? opts.mimeType,
    size: body.data?.size ?? opts.bytes.byteLength,
  };
}

/** @deprecated Prefer `uploadToPinata` — same implementation. */
export const uploadAvatarToPinata = uploadToPinata;
