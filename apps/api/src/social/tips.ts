import { isEvm, isValidTip, minTip, nativeUnit, type Net } from '@stonkz/shared';
import type { NativeTransferSource } from '../chain/types.js';
import type { ChainRpc } from '../chain/types.js';

/**
 * Plan step 147: "tip tx sig required; min 0.001 SOL / 0.0001 ETH; recipient
 * + recency + one post per signature. 100% to recipient (plain transfer)."
 *
 * This is the one function in the whole social layer that guards against a
 * client asserting a tip happened. `routes/social.ts`'s `POST /wall` calls
 * this before it ever touches `wall_posts`; the row's `tip_native` column is
 * always this function's verified `amount`, never the amount the request
 * body claimed.
 */

export type TipRejectionReason =
  | 'unsupported_chain'
  | 'not_found'
  | 'failed_tx'
  | 'wrong_sender'
  | 'wrong_recipient'
  | 'below_minimum'
  | 'too_old'
  | 'unknown_age';

export interface TipVerification {
  ok: boolean;
  reason?: TipRejectionReason;
  amountNative?: number;
}

export interface VerifyTipInput {
  rpc: ChainRpc;
  net: Net;
  signature: string;
  /** The authenticated caller — the tip must have moved native funds from exactly this address. */
  fromWallet: string;
  toWallet: string;
  /** Epoch ms "now"; a tip older than this window is refused as stale evidence, not a live payment. */
  nowMs: number;
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function hasNativeTransfer(rpc: ChainRpc): rpc is ChainRpc & NativeTransferSource {
  return typeof (rpc as Partial<NativeTransferSource>).getNativeTransfer === 'function';
}

function sameAddress(a: string | null, b: string, net: Net): boolean {
  if (!a || !b) return false;
  // EVM addresses (RH, Base, Arc) are case-insensitive — sessions store the
  // checksummed form, RPCs return lowercase; Solana base58 addresses are exact.
  return isEvm(net) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function verifyTip(input: VerifyTipInput): Promise<TipVerification> {
  const { rpc, net, signature, fromWallet, toWallet, nowMs } = input;
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  if (!hasNativeTransfer(rpc)) return { ok: false, reason: 'unsupported_chain' };

  const transfer = await rpc.getNativeTransfer(signature);
  if (!transfer.found) return { ok: false, reason: 'not_found' };
  if (transfer.status !== 'success') return { ok: false, reason: 'failed_tx' };
  if (!sameAddress(transfer.from, fromWallet, net)) return { ok: false, reason: 'wrong_sender' };
  if (!sameAddress(transfer.to, toWallet, net)) return { ok: false, reason: 'wrong_recipient' };

  // A non-finite or negative amount from a backend is not a payment of any
  // size — `isValidTip` already refuses NaN/Infinity; make ≤ 0 explicit too.
  const amount = transfer.amountNative ?? 0;
  const unit = nativeUnit(net);
  if (!(amount > 0) || !isValidTip(amount, unit)) return { ok: false, reason: 'below_minimum' };

  // Fail closed on an unknown timestamp (security review L1). Skipping the
  // recency check when `blockTimeMs` is null means an arbitrarily old transfer
  // can be replayed as evidence of a live payment on any backend that cannot
  // supply a block time — a distinct reason rather than a silent accept, so
  // the operator can tell "too old" from "cannot tell how old".
  if (transfer.blockTimeMs === null) {
    return { ok: false, reason: 'unknown_age' };
  }
  if (nowMs - transfer.blockTimeMs > maxAgeMs) {
    return { ok: false, reason: 'too_old' };
  }

  return { ok: true, amountNative: amount };
}

export function minTipFor(net: Net): number {
  return minTip(nativeUnit(net));
}
