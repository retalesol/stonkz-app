import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP on `node:crypto`, no third-party dependency.
 *
 * HMAC-SHA1, 30-second step, 6 digits — what Google Authenticator, 1Password
 * and Authy all default to, so the otpauth URI enrols anywhere. Verification
 * accepts ±1 step of drift, and the caller pins the last accepted counter so
 * a code can never be replayed inside its own window.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** 20 random bytes (160 bits), the RFC 4226 recommended minimum. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP. */
export function hotp(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const key = Buffer.from(base32Decode(secretBase32));
  const msg = Buffer.alloc(8);
  // Counters fit in 53 bits; write the high word then the low word.
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const code =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpCounter(nowMs: number, step = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / step);
}

export function totp(secretBase32: string, nowMs: number): string {
  return hotp(secretBase32, totpCounter(nowMs));
}

export interface TotpVerdict {
  ok: boolean;
  /** The step the code matched, so the caller can refuse a replay of the same step. */
  counter: number | null;
}

/**
 * Accepts the current step and one either side. `lastCounter` is the step of
 * the previously accepted code: anything at or before it is refused, which is
 * what turns "valid for 90 seconds" into "valid once".
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastCounter: number | null = null,
  window = 1,
): TotpVerdict {
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, counter: null };
  const centre = totpCounter(nowMs);
  for (let delta = -window; delta <= window; delta++) {
    const counter = centre + delta;
    if (lastCounter !== null && counter <= lastCounter) continue;
    if (timingSafeEqualString(hotp(secretBase32, counter), cleaned)) return { ok: true, counter };
  }
  return { ok: false, counter: null };
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'Stonkz Admin'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/* -------------------------------------------------------- secret at rest */

function sealKey(secret: string): Buffer {
  return createHash('sha256').update(`stonkz-totp-seal:${secret}`).digest();
}

/** AES-256-GCM under a key derived from the admin secret: `iv.tag.ciphertext`, base64url. */
export function sealSecret(plain: string, adminSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(adminSecret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((b) => b.toString('base64url')).join('.');
}

export function openSecret(sealed: string, adminSecret: string): string {
  const [ivB, tagB, bodyB] = sealed.split('.');
  if (!ivB || !tagB || !bodyB) throw new Error('malformed sealed secret');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    sealKey(adminSecret),
    Buffer.from(ivB, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
