import { type NativeUnit, normalizeTicker } from '@stonkz/shared';
import { WalletError, describeWalletError } from '../wallet/errors.js';

/**
 * The launch stepper's rules, without the DOM: field normalisation that
 * mirrors (and is never looser than) `apps/api/src/routes/launch.ts`, the
 * image checks run before anything is uploaded, and the copy for every way a
 * launch can fail. Pure so it is unit-tested (`launch-rules.test.ts`).
 */

/** Client caps. Each is at or under the server's own slice/validation. */
export const LAUNCH_LIMITS = {
  /** Server slices at 64; the terminal's cards are sized for 28. */
  name: 28,
  /** Server slices at 500; 140 is what the board card can show. */
  desc: 140,
  web: 200,
  /** X handles are 1-15 of `[A-Za-z0-9_]`. */
  x: 15,
  tg: 64,
  imageBytes: 5 * 1024 * 1024,
} as const;

export const IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export type FieldCheck = { ok: true; value: string } | { ok: false; error: string };

const ok = (value: string): FieldCheck => ({ ok: true, value });
const bad = (error: string): FieldCheck => ({ ok: false, error });

/** Control characters never belong in a coin name or description. */
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export function checkName(raw: string): FieldCheck {
  const v = stripControls(raw).replace(/\s+/g, ' ').trim();
  if (!v) return bad('PICK A NAME FIRST');
  if (v.length > LAUNCH_LIMITS.name) return bad(`NAME IS ${LAUNCH_LIMITS.name} CHARACTERS MAX`);
  // Solana's Metaplex name field is 32 bytes: emoji and accents cost 2-4.
  if (new TextEncoder().encode(v).length > 32) return bad('NAME IS TOO LONG · EMOJI COUNT DOUBLE');
  return ok(v);
}

export function checkTicker(raw: string): FieldCheck {
  const v = normalizeTicker(raw);
  return v ? ok(v) : bad('PICK A TICKER FIRST · LETTERS AND NUMBERS ONLY');
}

export function checkDesc(raw: string): FieldCheck {
  const v = stripControls(raw.replace(/\r\n?/g, '\n'))
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (v.length > LAUNCH_LIMITS.desc)
    return bad(`DESCRIPTION IS ${LAUNCH_LIMITS.desc} CHARACTERS MAX`);
  return ok(v);
}

/**
 * Website: http(s) only, a real-looking host, no embedded credentials. A bare
 * `example.com` gets `https://`. Returns the normalised `href`, so what is
 * stored is exactly what was checked.
 */
export function checkWebsite(raw: string): FieldCheck {
  const t = raw.trim();
  if (!t) return ok('');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return bad('WEBSITE MUST BE A VALID HTTPS:// LINK');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return bad('WEBSITE MUST START WITH HTTPS://');
  if (u.username || u.password) return bad('WEBSITE CANNOT CONTAIN A LOGIN');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) && !/^xn--/i.test(u.hostname))
    return bad('WEBSITE NEEDS A DOMAIN LIKE EXAMPLE.COM');
  if (u.href.length > LAUNCH_LIMITS.web)
    return bad(`WEBSITE IS ${LAUNCH_LIMITS.web} CHARACTERS MAX`);
  return ok(u.href);
}

/** X account: `@name`, `name` or an x.com / twitter.com profile link, stored as `@name`. */
export function checkXHandle(raw: string): FieldCheck {
  let t = raw.trim();
  if (!t) return ok('');
  const link = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(t);
  if (link?.[1]) t = link[1];
  t = t.replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(t)) return bad('X ACCOUNT IS 1-15 LETTERS, NUMBERS OR _');
  return ok('@' + t);
}

/**
 * Telegram: `@name`, `name`, `t.me/name`, an invite (`t.me/+code`,
 * `t.me/joinchat/code`) or `telegram.me/…`, stored as a `https://t.me/…` link.
 */
export function checkTelegram(raw: string): FieldCheck {
  let t = raw.trim();
  if (!t) return ok('');
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i.exec(t);
  if (link?.[1]) t = link[1].replace(/[?#].*$/, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return bad('TELEGRAM MUST BE A T.ME LINK OR @HANDLE');
  t = t.replace(/^@+/, '').replace(/\/+$/, '');
  const valid =
    /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(t) ||
    /^\+[A-Za-z0-9_-]{5,64}$/.test(t) ||
    /^joinchat\/[A-Za-z0-9_-]{5,64}$/.test(t);
  if (!valid) return bad('TELEGRAM MUST BE A T.ME LINK OR @HANDLE');
  const out = 'https://t.me/' + t;
  if (out.length > LAUNCH_LIMITS.tg) return bad('TELEGRAM LINK IS TOO LONG');
  return ok(out);
}

/** `null` when the file can go up; otherwise the toast copy. */
export function checkImageFile(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'PICK A PNG, JPEG, WEBP OR GIF';
  if (file.size <= 0) return 'THAT IMAGE FILE IS EMPTY';
  if (file.size > LAUNCH_LIMITS.imageBytes) return 'IMAGE MUST BE UNDER 5 MB';
  return null;
}

/**
 * Parse the dev-buy box. `null` for anything that is not a finite,
 * non-negative number (so `1e999`, `-1` and `abc` never reach the API).
 */
export function parseDevBuy(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return 0;
  if (!/^\d*\.?\d*$/.test(t)) return null;
  // A lone `.` is a half-typed `.5`, not an error.
  const v = t === '.' ? 0 : Number(t);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Quick-pick dev buys that make sense in each gas unit (5 ETH is not "a small buy"). */
export function devBuyPresets(unit: NativeUnit): readonly number[] {
  if (unit === 'ETH') return [0, 0.005, 0.01, 0.05, 0.1];
  if (unit === 'USDC') return [0, 5, 10, 25, 50];
  return [0, 0.1, 0.5, 1, 2];
}

/**
 * Whether an EVM dev buy on this base rides in the launch transaction itself
 * (`StonkzRouter.createAndBuyWithEth`, WETH curves only — native ETH launches
 * as a WETH curve). Any other EVM base still takes a second transaction. The
 * API's `devBuy.atomic` is the final word; this only drives the dialog copy.
 */
export function evmDevBuyIsAtomic(base: string): boolean {
  const b = base.trim().toUpperCase();
  return b === 'ETH' || b === 'WETH';
}

/** A number in the box's own format: no float noise, no forced two decimals. */
export function fmtBuy(v: number): string {
  if (!(v > 0)) return '';
  return String(Math.round(v * 1e6) / 1e6);
}

/** `42S`, `3 MIN`, `2 H` — a retry wait from a `retryAfterMs`. */
export function fmtWait(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return 'A MOMENT';
  const s = Math.ceil(ms / 1000);
  if (s < 90) return s + 'S';
  const m = Math.ceil(s / 60);
  if (m < 120) return m + ' MIN';
  return Math.ceil(m / 60) + ' H';
}

/* -------------------------------------------------------------------------- */
/* Failure copy                                                                */
/* -------------------------------------------------------------------------- */

export interface LaunchFailure {
  msg: string;
  /** `red` for faults; a user's own cancel is not one. */
  tone: 'red' | 'plain';
  /** The step whose inputs caused it, so the dialog can send the user there. */
  step?: 0 | 1 | 2;
}

export interface LaunchErrorContext {
  unit: NativeUnit;
  netName: string;
  base: string;
  buy: number;
}

/** `LiveApiError`'s shape, duck-typed so this module stays transport-free. */
interface ApiErrorish {
  name: string;
  code: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

function asApiError(err: unknown): ApiErrorish | null {
  if (!(err instanceof Error) || err.name !== 'LiveApiError') return null;
  const e = err as Error & { code?: unknown };
  return typeof e.code === 'string' ? (err as unknown as ApiErrorish) : null;
}

function clip(s: string, n = 140): string {
  const u = s.trim().toUpperCase();
  return u.length > n ? u.slice(0, n - 1) + '…' : u;
}

/**
 * Toast copy for every way `/launch/prepare`, the wallet, or
 * `/launch/confirm` can refuse a launch. Every message says whether anything
 * was created and what to do next; the draft is always kept.
 */
export function launchErrorCopy(err: unknown, ctx: LaunchErrorContext): LaunchFailure {
  const api = asApiError(err);
  if (api) {
    const detail = api.message && api.message !== api.code ? clip(api.message, 100) : '';
    switch (api.code) {
      case 'rate_limited':
        return {
          msg: `LAUNCH LIMIT REACHED FOR THIS WALLET · TRY AGAIN IN ${fmtWait(api.retryAfterMs)}`,
          tone: 'red',
        };
      case 'name_or_ticker_cooldown':
        return {
          msg: `A COIN WITH THIS NAME OR TICKER LAUNCHED IN THE LAST 5 MIN · PICK ANOTHER OR TRY AGAIN IN ${fmtWait(api.retryAfterMs)}`,
          tone: 'red',
          step: 0,
        };
      case 'ticker_taken':
        return {
          msg: 'SOMEONE ELSE IS LAUNCHING THIS TICKER RIGHT NOW · PICK ANOTHER OR WAIT A FEW MINUTES',
          tone: 'red',
          step: 0,
        };
      case 'moderation_rejected':
        return {
          msg: 'THE CONTENT FILTER BLOCKED THE NAME, TICKER OR DESCRIPTION · EDIT IT AND TRY AGAIN',
          tone: 'red',
          step: 0,
        };
      case 'bad_request':
        return { msg: detail || 'CHECK THE NAME AND TICKER', tone: 'red', step: 0 };
      case 'invalid_supply':
      case 'invalid_fee':
        return { msg: detail || 'CHECK SUPPLY AND FEE', tone: 'red', step: 1 };
      case 'base_mint_not_allowed':
      case 'base_price_unavailable':
        return {
          msg: `${ctx.base} CAN'T BE A BASE ON ${ctx.netName} RIGHT NOW · PICK ANOTHER BASE TOKEN`,
          tone: 'red',
          step: 1,
        };
      case 'invalid_curve_params':
        return {
          msg: `THAT SUPPLY CAN'T BE REPRESENTED ON-CHAIN AGAINST ${ctx.base} · PICK ANOTHER SUPPLY OR BASE`,
          tone: 'red',
          step: 1,
        };
      case 'cashback_dev_buy_conflict':
        return {
          msg: 'A CASHBACK LAUNCH CANNOT CARRY A DEV BUY · SET THE DEV BUY TO 0',
          tone: 'red',
          step: 2,
        };
      case 'dev_buy_failed':
        return {
          msg: 'THE DEV BUY COULD NOT BE FILLED ON A FRESH CURVE · LOWER IT AND TRY AGAIN · NOTHING WAS CREATED',
          tone: 'red',
          step: 2,
        };
      case 'solana_tx_too_large':
        return {
          msg: `THE ${ctx.base} DEV-BUY ROUTE WON'T FIT ONE TRANSACTION RIGHT NOW · LOWER THE DEV BUY, SET IT TO 0, OR TRY AGAIN · NOTHING WAS SENT`,
          tone: 'red',
          step: 2,
        };
      case 'launchpad_not_configured':
        return {
          msg: `LAUNCHES AREN'T LIVE ON ${ctx.netName} IN THIS ENVIRONMENT YET`,
          tone: 'red',
        };
      case 'transaction_reverted':
      case 'transaction_failed':
        return { msg: 'LAUNCH REVERTED ON CHAIN · NOTHING WAS CREATED · TRY AGAIN', tone: 'red' };
      // Pre-sign simulation refusals: nothing was signed, nothing was spent.
      case 'oracle_stale':
        return {
          msg: `THE ${ctx.netName} PRICE FEED IS UPDATING · NOTHING WAS SENT · TRY AGAIN IN ${fmtWait(api.retryAfterMs)}`,
          tone: 'red',
        };
      case 'launch_paused':
        return {
          msg: `LAUNCHES ARE PAUSED ON ${ctx.netName} RIGHT NOW · NOTHING WAS SENT`,
          tone: 'red',
        };
      case 'invalid_ticker':
        return {
          msg: detail || 'THAT TICKER IS NOT ALLOWED · USE LETTERS AND NUMBERS',
          tone: 'red',
          step: 0,
        };
      case 'name_too_long':
      case 'metadata_too_long':
        return {
          msg: 'NAME IS TOO LONG FOR THE CHAIN (MAX 32 BYTES · EMOJI COUNT DOUBLE) · SHORTEN IT',
          tone: 'red',
          step: 0,
        };
      case 'invalid_uri':
        return {
          msg: 'THE IMAGE LINK IS TOO LONG OR INVALID · RE-UPLOAD THE IMAGE',
          tone: 'red',
          step: 0,
        };
      case 'invalid_social':
        return { msg: detail || 'CHECK THE WEBSITE, X AND TELEGRAM LINKS', tone: 'red', step: 0 };
      case 'insufficient_funds':
        return {
          msg: `NOT ENOUGH ${ctx.unit} FOR ${ctx.buy > 0 ? 'THE DEV BUY PLUS ' : ''}FEES AND RENT · TOP UP OR LOWER THE DEV BUY`,
          tone: 'red',
          ...(ctx.buy > 0 ? { step: 2 as const } : {}),
        };
      case 'dev_buy_too_large':
        return {
          msg: detail || `THE DEV BUY IS ABOVE THE ${ctx.netName} LIMIT · LOWER IT`,
          tone: 'red',
          step: 2,
        };
      case 'oracle_fee_changed':
        return {
          msg: 'THE PRICE-UPDATE FEE CHANGED · NOTHING WAS SENT · PRESS LAUNCH AGAIN',
          tone: 'red',
        };
      case 'oracle_update_unavailable':
        return {
          msg: `LIVE PRICES ARE UNAVAILABLE ON ${ctx.netName} RIGHT NOW · NOTHING WAS SENT · TRY AGAIN IN ${fmtWait(api.retryAfterMs)}`,
          tone: 'red',
        };
      case 'launch_expired':
        return {
          msg: 'THE PREPARED LAUNCH EXPIRED BEFORE IT WAS SENT · NOTHING WAS CREATED · PRESS LAUNCH AGAIN',
          tone: 'red',
        };
      case 'dev_buy_slippage':
        return {
          msg: 'THE DEV BUY PRICE MOVED · LOWER IT OR TRY AGAIN · NOTHING WAS SENT',
          tone: 'red',
          step: 2,
        };
      case 'base_not_supported':
        return {
          msg: `${ctx.base} CAN'T BE A BASE ON ${ctx.netName} RIGHT NOW · PICK ANOTHER BASE TOKEN`,
          tone: 'red',
          step: 1,
        };
      case 'simulation_failed':
        return {
          msg:
            'THIS LAUNCH WOULD FAIL ON CHAIN · NOTHING WAS SENT · ' +
            (detail || 'CHECK THE DETAILS AND TRY AGAIN'),
          tone: 'red',
        };
      case 'chain_unavailable':
        return {
          msg: `${ctx.netName} RPC IS UNAVAILABLE · YOUR DRAFT IS SAVED · TRY AGAIN IN ${fmtWait(api.retryAfterMs)}`,
          tone: 'red',
        };
      case 'unauthorized':
        return { msg: 'SIGN-IN EXPIRED · PRESS LAUNCH TO SIGN IN AGAIN', tone: 'red' };
      default:
        if ((api.status ?? 0) >= 500 || api.code === 'request_failed') {
          return {
            msg: 'THE STONKZ API HIT AN ERROR · YOUR DRAFT IS SAVED · TRY AGAIN',
            tone: 'red',
          };
        }
        return { msg: detail || clip(api.code.replace(/_/g, ' ')), tone: 'red' };
    }
  }

  if (err instanceof WalletError) {
    switch (err.kind) {
      case 'rejected':
        if (/already waiting/i.test(err.message)) {
          return {
            msg: 'A REQUEST IS ALREADY OPEN IN YOUR WALLET · FINISH OR CLOSE IT, THEN PRESS LAUNCH',
            tone: 'red',
          };
        }
        return { msg: 'LAUNCH CANCELLED IN WALLET · NOTHING WAS CREATED', tone: 'plain' };
      case 'insufficient_funds':
        return {
          msg: `NOT ENOUGH ${ctx.unit} FOR ${ctx.buy > 0 ? 'THE DEV BUY PLUS ' : ''}GAS · TOP UP OR LOWER THE DEV BUY`,
          tone: 'red',
          ...(ctx.buy > 0 ? { step: 2 as const } : {}),
        };
      case 'reverted':
      case 'slippage':
        return {
          msg: 'LAUNCH REVERTED ON CHAIN · NOTHING WAS CREATED · ' + clip(err.message, 80),
          tone: 'red',
        };
      case 'timeout':
        return {
          msg: 'THE TRANSACTION EXPIRED BEFORE IT LANDED · NOTHING WAS CREATED · TRY AGAIN',
          tone: 'red',
        };
      case 'network':
        return {
          msg: 'COULD NOT REACH THE NETWORK · CHECK YOUR CONNECTION AND TRY AGAIN',
          tone: 'red',
        };
      case 'not_connected':
        return {
          msg: `CONNECT A ${ctx.netName} WALLET TO LAUNCH ON ${ctx.netName}`,
          tone: 'red',
        };
      default:
        return { msg: clip(describeWalletError(err)), tone: 'red' };
    }
  }

  // `fetch` itself failing: offline, CORS, DNS.
  if (err instanceof TypeError) {
    return {
      msg: 'COULD NOT REACH THE STONKZ API · CHECK YOUR CONNECTION AND TRY AGAIN',
      tone: 'red',
    };
  }
  return {
    msg: clip(err instanceof Error && err.message ? err.message : 'LAUNCH FAILED'),
    tone: 'red',
  };
}
