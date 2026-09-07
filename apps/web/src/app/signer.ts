import type { Net } from '@stonkz/shared';
import { rng } from '@stonkz/shared';

/**
 * Signs a prepared payload and "confirms" it.
 *
 * `app/keys.ts` does real cryptographic signing for the SIWS/SIWE login
 * handshake because that round-trips against a real verifier
 * (`auth/siws.ts`/`auth/siwe.ts`) and is fully checkable today. A prepared
 * trade/launch/claim transaction is a different problem: nothing in this
 * repo — neither `apps/web` nor `apps/api` — has a code path that broadcasts
 * a signed transaction to a real chain RPC and waits for it to land.
 * `apps/api`'s own chain clients default to real mainnet/testnet RPCs
 * (`app/deps.ts`), so even a genuinely-signed transaction from this practice
 * wallet would only ever fail at broadcast for lack of funds — there is no
 * sandbox here to broadcast it into. `/launch/confirm` in particular needs a
 * signature it can look up *on that real chain*, which this module cannot
 * produce no matter how it signs.
 *
 * So: this simulates the wallet-adapter signing prompt and the
 * broadcast-and-confirm wait — exactly the same honesty trade `app/wallet.ts`
 * already makes for `connect()` (a real 460ms pause, a fake handshake) — and
 * is the seam a real `sendAndConfirmTransaction` replaces once this system
 * has somewhere real to send one.
 */

export interface UiStep {
  description: string;
  /**
   * Optional async work to run immediately before this step is signed —
   * e.g. its own independent `POST .../prepare` call, for a step whose
   * payload cannot be known until the previous step has already confirmed.
   * `modals/steps.ts`'s `advance()` awaits this, then signs.
   */
  run?: () => Promise<void>;
}

export class SignerCancelledError extends Error {
  constructor() {
    super('signing cancelled');
    this.name = 'SignerCancelledError';
  }
}

let seedCounter = Date.now();

function fakeSolanaSignature(): string {
  const r = rng(seedCounter++);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 64; i++) out += alphabet[(r() * alphabet.length) | 0];
  return out;
}

function fakeEvmHash(): string {
  const r = rng(seedCounter++);
  let out = '0x';
  for (let i = 0; i < 64; i++) out += ((r() * 16) | 0).toString(16);
  return out;
}

/**
 * One wallet-adapter "sign, then wait for confirmation" round for a single
 * step. Solana's atomic path calls this exactly once, inline; Robinhood's
 * non-atomic plan (`modals/steps.ts`) calls it once per `EvmStep`, gated on
 * an explicit click so "sequential confirmation" is a real user action per
 * step, not an automatic loop that only *looks* like separate signatures.
 */
export async function signAndConfirmStep(net: Net): Promise<{ signature: string }> {
  await new Promise((resolve) => setTimeout(resolve, 450 + Math.random() * 350));
  return { signature: net === 'SOL' ? fakeSolanaSignature() : fakeEvmHash() };
}
