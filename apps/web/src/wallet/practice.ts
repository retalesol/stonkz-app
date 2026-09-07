import type { Net } from '@stonkz/shared';
import { practiceAddress, signSignInMessage } from '../app/keys.js';
import { WalletError } from './errors.js';
import type { BroadcastResult, ConnectedWallet, SignPayload, WalletChoice } from './types.js';

/**
 * The practice keypair, kept — and hard-gated.
 *
 * `app/keys.ts` mints a real ed25519 / secp256k1 keypair in the browser and
 * signs a real SIWS/SIWE challenge with it, which is genuinely useful: a
 * developer with no extension installed can still exercise every
 * authenticated endpoint. What it cannot do is settle anything, because the
 * key is never funded and this module does not broadcast.
 *
 * Before this phase that was the *only* signer, and nothing in the UI said
 * so. Now three things gate it:
 *
 * 1. **An explicit build flag.** `VITE_PRACTICE_WALLET=1`, unset by default,
 *    and `vite.config.ts` refuses to produce a production build with it set
 *    unless `VITE_PRACTICE_WALLET_ACK=1` is also present. Shipping practice
 *    mode as "live" is therefore not a thing that can happen by forgetting.
 * 2. **A real wallet always wins.** `wallet/manager.ts`'s
 *    `preferRealWallet()` puts practice last and never auto-selects it when
 *    any real wallet is available.
 * 3. **A persistent badge.** Every `signAndSend()` here returns
 *    `simulated: true`, and `app/wallet.ts` pins an unmissable header badge
 *    for the whole session.
 */

export const PRACTICE_WALLET_ID = 'practice';

type EnvLike = Record<string, unknown>;

/**
 * The single gate. Pure over its env so the "cannot activate with the flag
 * off" property is a unit test rather than a claim.
 */
export function practiceWalletEnabled(env: EnvLike = import.meta.env as unknown as EnvLike): boolean {
  return String(env['VITE_PRACTICE_WALLET'] ?? '') === '1';
}

/** The picker row, offered only when the flag is on. */
export function practiceWalletChoice(net: Net, env?: EnvLike): WalletChoice | null {
  if (!practiceWalletEnabled(env)) return null;
  return {
    id: PRACTICE_WALLET_ID,
    net,
    kind: 'practice',
    name: 'Practice key (nothing settles)',
  };
}

class PracticeWallet implements ConnectedWallet {
  readonly kind = 'practice' as const;
  readonly label = 'PRACTICE KEY';
  readonly practice = true;

  constructor(readonly net: Net) {}

  get address(): string {
    return practiceAddress(this.net);
  }

  async signInMessage(message: string): Promise<string> {
    // Real cryptography against a real verifier — `apps/api`'s `auth/siws.ts`
    // and `auth/siwe.ts` accept this because the signature is genuine.
    return signSignInMessage(this.net, message);
  }

  async signAndSend(payload: SignPayload): Promise<BroadcastResult> {
    if (payload.net !== this.net) {
      throw new WalletError('unsupported_method', 'The practice wallet is bound to one chain at a time.');
    }
    // Deliberately not broadcast. The key holds nothing, so a real send would
    // fail for lack of funds every time; pretending otherwise is what the
    // `simulated` flag and the header badge exist to prevent.
    await new Promise((r) => setTimeout(r, 420));
    return { signature: simulatedSignature(this.net), simulated: true };
  }

  async signTypedData(): Promise<string> {
    throw new WalletError(
      'unsupported_method',
      'The practice wallet cannot produce a verifiable EIP-712 permit \u2014 there is no chain to read the ' +
        'token\u2019s permit nonce from. Connect a real wallet for a first-time Robinhood sell.',
    );
  }

  async nativeBalance(): Promise<number | null> {
    // Always zero, and honestly so: nothing can fund this key.
    return 0;
  }

  async disconnect(): Promise<void> {
    // Nothing to release; the key stays in `localStorage` for the next session.
  }

  onAccountChange(): () => void {
    return () => undefined;
  }
}

/**
 * A clearly-marked stand-in signature. Prefixed so it can never be mistaken
 * for a real one in a log, a toast or a share link — a real base58 Solana
 * signature is 64 bytes and a real EVM hash is 32, and neither starts with
 * these characters by construction.
 */
function simulatedSignature(net: Net): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return net === 'SOL' ? 'SIMULATED-' + rand : '0xsimulated' + rand;
}

export function connectPracticeWallet(net: Net, env?: EnvLike): ConnectedWallet {
  if (!practiceWalletEnabled(env)) {
    throw new WalletError(
      'no_wallet',
      'The practice wallet is disabled in this build. Set VITE_PRACTICE_WALLET=1 in a development build to use it.',
    );
  }
  return new PracticeWallet(net);
}
