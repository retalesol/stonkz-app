/**
 * One error type for every wallet and RPC failure, with a `kind` the UI can
 * switch on.
 *
 * The simulated signer this replaces could only ever fail one way (it never
 * failed at all), so every write path in the app funnelled into a single
 * "SIGNING FAILED" toast. A real wallet fails in ways a trader has to be able
 * to tell apart — declining the prompt is not the same event as being short
 * on gas, and neither is a slippage revert — so the mapping from a provider's
 * error to one of those states lives here, in one place, unit-tested against
 * the shapes the providers actually emit.
 */

export type WalletErrorKind =
  /** Nothing is installed / nothing usable was detected for this chain. */
  | 'no_wallet'
  /** The user declined in the wallet. EIP-1193 `4001`, or a wallet's own "User rejected" text. */
  | 'rejected'
  /** Connected, but on the wrong chain, and the switch was declined or unavailable. */
  | 'wrong_chain'
  /** The wallet does not know chain 4663 and could not add it. */
  | 'chain_unsupported'
  /** Not enough native balance to cover value + gas. */
  | 'insufficient_funds'
  /** The transaction reverted on chain for a reason that is not slippage. */
  | 'reverted'
  /** A revert that is specifically a min-out / slippage floor being missed. */
  | 'slippage'
  /** No wallet is connected for the net being written to. */
  | 'not_connected'
  /** The wallet cannot perform the requested RPC method at all. */
  | 'unsupported_method'
  /** Broadcast succeeded; the confirmation never arrived inside the window. */
  | 'timeout'
  /** Transport-level failure talking to the RPC or the relay. */
  | 'network'
  /** A required operator credential (e.g. the WalletConnect project id) is unset. */
  | 'unconfigured'
  | 'unknown';

export class WalletError extends Error {
  constructor(
    readonly kind: WalletErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WalletError';
  }
}

/** True for the one failure that is a deliberate user action, not a fault. */
export function isRejection(err: unknown): boolean {
  return err instanceof WalletError && err.kind === 'rejected';
}

export function walletErrorKind(err: unknown): WalletErrorKind | null {
  return err instanceof WalletError ? err.kind : null;
}

/* -------------------------------------------------------------------------- */
/* Provider error shapes                                                       */
/* -------------------------------------------------------------------------- */

interface ProviderErrorish {
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  reason?: unknown;
  data?: { message?: unknown; originalError?: { message?: unknown } } | unknown;
  cause?: unknown;
}

/**
 * Collect every string a provider might have buried its reason in. viem nests
 * `cause` chains, MetaMask nests `data.originalError.message`, and WalletConnect
 * relays the wallet's own text verbatim — so match against all of them rather
 * than only `err.message`.
 */
function errorText(err: unknown, depth = 0): string {
  if (depth > 6 || err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);
  const e = err as ProviderErrorish;
  const parts: string[] = [];
  for (const v of [e.message, e.shortMessage, e.details, e.reason]) {
    if (typeof v === 'string') parts.push(v);
  }
  const data = e.data;
  if (data && typeof data === 'object') {
    const d = data as { message?: unknown; originalError?: { message?: unknown } };
    if (typeof d.message === 'string') parts.push(d.message);
    if (typeof d.originalError?.message === 'string') parts.push(d.originalError.message);
  } else if (typeof data === 'string') {
    parts.push(data);
  }
  if (e.cause !== undefined && e.cause !== err) parts.push(errorText(e.cause, depth + 1));
  return parts.join(' \u00b7 ');
}

function numericCode(err: unknown, depth = 0): number | null {
  if (depth > 6 || err === null || typeof err !== 'object') return null;
  const e = err as ProviderErrorish;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.code === 'string' && /^-?\d+$/.test(e.code)) return Number(e.code);
  if (e.cause !== undefined && e.cause !== err) return numericCode(e.cause, depth + 1);
  return null;
}

/** Text the caller can show verbatim; falls back to the kind's own copy. */
function trim(text: string, fallback: string): string {
  const first = text.split(' \u00b7 ')[0]?.trim() ?? '';
  return first === '' ? fallback : first;
}

const REJECT_PATTERNS = [
  'user rejected',
  'user denied',
  'user canceled',
  'user cancelled',
  'rejected the request',
  'request rejected',
  'declined',
  'cancelled by user',
  'canceled by user',
  'user disapproved',
  'transaction was rejected',
];

const INSUFFICIENT_PATTERNS = [
  'insufficient funds',
  'insufficient balance',
  'insufficient lamports',
  'insufficient sol',
  // The Solana runtime's phrasing for "this account has never held anything".
  'attempt to debit an account but found no record of a prior credit',
  'exceeds the balance',
  'not enough',
];

const SLIPPAGE_PATTERNS = [
  'slippage',
  'too little received',
  'too much requested',
  'insufficient_output_amount',
  'insufficient output amount',
  'min_out',
  'minimum output',
  'aggregatorshortfall',
  'v3toolittlereceived',
  'price impact too high',
  // Anchor's `SlippageExceeded` and Jupiter's own slippage code, as they land
  // in a simulation log line.
  '0x1771',
];

const REVERT_PATTERNS = [
  'execution reverted',
  'reverted',
  'transaction failed',
  'custom program error',
  'program failed to complete',
  'instructionerror',
];

const NETWORK_PATTERNS = [
  'failed to fetch',
  'network error',
  'networkerror',
  'fetch failed',
  'load failed',
  'connection closed',
  'websocket',
  'socket hang up',
  'relayer',
  'blockhash not found',
  'blockhashnotfound',
  'rate limit',
  '429',
  'econnrefused',
  'request timed out',
];

function matches(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Map anything an EIP-1193 provider, viem, or an RPC threw into a
 * `WalletError`. Already-mapped errors pass straight through so a caller can
 * wrap without flattening a precise kind into `unknown`.
 */
export function mapWalletError(err: unknown, fallbackMessage = 'The wallet could not complete this request.'): WalletError {
  if (err instanceof WalletError) return err;

  const text = errorText(err);
  const lower = text.toLowerCase();
  const code = numericCode(err);

  // EIP-1193 / EIP-1474 codes first: they are unambiguous where present.
  switch (code) {
    case 4001:
      return new WalletError('rejected', trim(text, 'You declined the request in your wallet.'), { cause: err });
    case 4100:
      return new WalletError('not_connected', trim(text, 'The wallet has not authorised this site yet.'), { cause: err });
    case 4200:
      return new WalletError('unsupported_method', trim(text, 'This wallet does not support that request.'), { cause: err });
    case 4900:
      return new WalletError('network', trim(text, 'The wallet is disconnected.'), { cause: err });
    case 4901:
      return new WalletError('wrong_chain', trim(text, 'The wallet is not connected to this chain.'), { cause: err });
    case 4902:
      return new WalletError('chain_unsupported', trim(text, 'The wallet does not know this chain yet.'), { cause: err });
    case 5000:
      // WalletConnect/CAIP-25: the wallet refused the request outright.
      return new WalletError('rejected', trim(text, 'Your wallet rejected the request.'), { cause: err });
    default:
      break;
  }

  // Order matters: a rejection often also mentions "transaction", and a
  // slippage revert always also mentions "reverted".
  if (matches(lower, REJECT_PATTERNS)) {
    return new WalletError('rejected', trim(text, 'You declined the request in your wallet.'), { cause: err });
  }
  if (matches(lower, INSUFFICIENT_PATTERNS)) {
    return new WalletError('insufficient_funds', trim(text, 'Not enough balance to cover this transaction and its gas.'), {
      cause: err,
    });
  }
  if (matches(lower, SLIPPAGE_PATTERNS)) {
    return new WalletError('slippage', trim(text, 'The price moved past your slippage limit before this landed.'), {
      cause: err,
    });
  }
  if (lower.includes('unrecognized chain') || lower.includes('unrecognised chain') || lower.includes('add this network')) {
    return new WalletError('chain_unsupported', trim(text, 'The wallet does not know this chain yet.'), { cause: err });
  }
  if (lower.includes('chain mismatch') || lower.includes('wrong chain') || lower.includes('chain id')) {
    return new WalletError('wrong_chain', trim(text, 'The wallet is on the wrong chain.'), { cause: err });
  }
  if (matches(lower, REVERT_PATTERNS)) {
    return new WalletError('reverted', trim(text, 'The transaction reverted on chain.'), { cause: err });
  }
  if (matches(lower, NETWORK_PATTERNS)) {
    return new WalletError('network', trim(text, 'Could not reach the network.'), { cause: err });
  }
  if (code === -32002) {
    return new WalletError('rejected', 'A request is already waiting in your wallet. Open it and finish that one first.', {
      cause: err,
    });
  }
  return new WalletError('unknown', trim(text, fallbackMessage), { cause: err });
}

/* -------------------------------------------------------------------------- */
/* User-facing copy                                                            */
/* -------------------------------------------------------------------------- */

const HEADLINE: Record<WalletErrorKind, string> = {
  no_wallet: 'NO WALLET DETECTED',
  rejected: 'REJECTED IN WALLET',
  wrong_chain: 'WRONG CHAIN',
  chain_unsupported: 'CHAIN NOT ADDED',
  insufficient_funds: 'INSUFFICIENT FUNDS',
  reverted: 'REVERTED ON CHAIN',
  slippage: 'SLIPPAGE EXCEEDED',
  not_connected: 'WALLET NOT CONNECTED',
  unsupported_method: 'WALLET CANNOT DO THAT',
  timeout: 'CONFIRMATION TIMED OUT',
  network: 'NETWORK UNREACHABLE',
  unconfigured: 'NOT CONFIGURED',
  unknown: 'WALLET ERROR',
};

/** The terminal-cased headline for a toast. */
export function walletErrorHeadline(err: unknown): string {
  const kind = walletErrorKind(err);
  return kind ? HEADLINE[kind] : HEADLINE.unknown;
}

/** Headline plus the provider's own reason, for a toast or a modal line. */
export function describeWalletError(err: unknown): string {
  const headline = walletErrorHeadline(err);
  const detail = err instanceof Error ? err.message.trim() : '';
  return detail === '' ? headline : headline + ' \u00b7 ' + detail.toUpperCase();
}
