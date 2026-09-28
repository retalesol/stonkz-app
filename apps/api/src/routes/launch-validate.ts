/**
 * Pure input hygiene for `POST /launch/prepare` — everything here is
 * deterministic string work so it can be unit-tested without an app.
 *
 * The on-chain programs are the hard limits this mirrors:
 * `programs/solana/.../create_token.rs` refuses a name over 32 **bytes** and
 * a uri over 200 bytes (`MetadataTooLong`), so a prepare that let either
 * through handed the wallet a transaction that could only fail on-chain.
 */

/** `create_token.rs` `MAX_NAME_LEN` — UTF-8 bytes, not characters. */
export const SOLANA_MAX_NAME_BYTES = 32;
/** EVM `createToken` has no length check; this is the API's own ceiling. */
export const EVM_MAX_NAME_CHARS = 64;
/** `create_token.rs` `MAX_URI_LEN` — applied on every net for one rule. */
export const MAX_URI_BYTES = 200;
export const MAX_DESCR_CHARS = 500;
export const MAX_WEBSITE_CHARS = 200;

const encoder = new TextEncoder();

export function utf8Length(s: string): number {
  return encoder.encode(s).byteLength;
}

/**
 * Controls, format characters (zero-width space/joiner, bidi overrides such
 * as U+202E, the BOM, soft hyphen) and line/paragraph separators. None of
 * them render as anything a reader can see, which is exactly what makes them
 * useful for spoofing a board card or dodging the name cooldown.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** NFKC, invisible characters stripped, whitespace collapsed, trimmed. */
export function sanitizeName(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

/** Same as {@link sanitizeName} but keeps single line breaks. */
export function sanitizeDescr(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => (ch === '\n' ? '\n' : ''))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Latin look-alikes for the Cyrillic/Greek letters most often used to clone
 * a name (`Реpe` for `Pepe`). Deliberately small: it only has to make the
 * 5-minute squat cooldown and the moderation stub see through the obvious
 * swaps, not implement Unicode TR39.
 */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ү: 'y',
  һ: 'h',
  ӏ: 'l',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ɡ: 'g',
  ı: 'i',
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ß: 'ss',
};

/**
 * Lowercase, accent-free, confusable-folded text. Keeps separators so a
 * caller can still split words.
 */
export function foldConfusables(raw: string): string {
  return sanitizeName(raw)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/./gu, (ch) => CONFUSABLES[ch] ?? ch);
}

/**
 * What two display names are compared on for the squat cooldown: folded,
 * then everything that is not a letter or digit dropped, so `Pepe`, `PEPE!`,
 * `P e p e`, `Pe\u200Bpe` and Cyrillic `Реpe` all collide.
 */
export function nameSkeleton(raw: string): string {
  return foldConfusables(raw).replace(/[^\p{L}\p{N}]/gu, '');
}

export type Checked<T> = { ok: true; value: T } | { ok: false; detail: string };

function hasInvisible(s: string): boolean {
  return /[\s\p{Cc}\p{Cf}]/u.test(s);
}

/**
 * The token `uri` (the image / metadata link written on-chain). Empty is
 * fine; otherwise `https://` or `ipfs://` only — `http:` would be mixed
 * content on ston.kz, and `javascript:`/`data:` never belong in a board card.
 */
export function checkUri(raw: string): Checked<string> {
  const uri = raw.trim();
  if (!uri) return { ok: true, value: '' };
  if (hasInvisible(uri)) return { ok: false, detail: 'uri must not contain whitespace' };
  if (utf8Length(uri) > MAX_URI_BYTES) {
    return { ok: false, detail: `uri must be at most ${MAX_URI_BYTES} bytes` };
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, detail: 'uri must be an https:// or ipfs:// URL' };
  }
  if (url.protocol === 'ipfs:') return { ok: true, value: uri };
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    return { ok: false, detail: 'uri must be an https:// or ipfs:// URL' };
  }
  return { ok: true, value: uri };
}

/** Board image for a checked uri: https as-is, `ipfs://CID/…` through the gateway. */
export function imageUrlFromUri(uri: string, gatewayHost: string): string | null {
  if (!uri) return null;
  if (/^https:\/\//i.test(uri)) return uri;
  const m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(uri);
  if (m?.[1] && gatewayHost) return `https://${gatewayHost.replace(/\/+$/, '')}/ipfs/${m[1]}`;
  return null;
}

/** X/Twitter handle: `@name`, `name` or an x.com / twitter.com profile link. */
export function checkXHandle(raw: string): Checked<string | null> {
  let v = raw.trim();
  if (!v) return { ok: true, value: null };
  const link =
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([^/?#]+)\/?(?:[?#].*)?$/i.exec(v);
  if (link?.[1]) v = link[1];
  v = v.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(v)) {
    return { ok: false, detail: 'x handle must be 1-15 letters, numbers or _' };
  }
  return { ok: true, value: v };
}

/**
 * Telegram, stored as a canonical `https://t.me/…` link (what the web client
 * sends and renders): a public username (`@name`, `name`, `t.me/name`,
 * `telegram.me/name`) or an invite link (`t.me/+…`, `t.me/joinchat/…`).
 * Any other host is refused — this is a Telegram field, not a free URL.
 */
export function checkTelegram(raw: string): Checked<string | null> {
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  const bad = { ok: false as const, detail: 'telegram must be a username or a t.me link' };
  if (v.length > MAX_WEBSITE_CHARS || /[\s\p{Cc}\p{Cf}]/u.test(v)) return bad;
  let path: string;
  const link =
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([^?#]+?)\/?(?:[?#].*)?$/i.exec(
      v,
    );
  if (link?.[1]) {
    path = link[1];
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.includes('/')) {
    return bad;
  } else {
    path = v.replace(/^@/, '');
  }
  const invite = /^(\+[A-Za-z0-9_-]{8,64}|joinchat\/[A-Za-z0-9_-]{8,64})$/.exec(path);
  if (invite) return { ok: true, value: `https://t.me/${invite[1]}` };
  const handle = path.replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(handle)) return bad;
  return { ok: true, value: `https://t.me/${handle}` };
}

/**
 * A clickable link another wallet will see: http(s) only, no credentials, no
 * whitespace. A bare `example.com` is read as https.
 */
export function checkWebsite(raw: string, max = MAX_WEBSITE_CHARS): Checked<string | null> {
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (hasInvisible(v)) return { ok: false, detail: 'website must not contain whitespace' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, detail: 'website must be an http(s) URL' };
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    !url.hostname.includes('.') ||
    url.username ||
    url.password
  ) {
    return { ok: false, detail: 'website must be an http(s) URL' };
  }
  const href = url.href;
  if (href.length > max) return { ok: false, detail: `website must be at most ${max} characters` };
  return { ok: true, value: href };
}
