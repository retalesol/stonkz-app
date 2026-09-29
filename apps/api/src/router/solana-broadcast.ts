import { jsonRpc } from '../chain/jsonrpc.js';
import type { FetchLike } from '../chain/types.js';
import type { Logger } from '../observability/logger.js';
import { RouterError } from './errors.js';

/**
 * The MEV-protected submission path behind the settings modal's MEV mode.
 *
 * Solana wallets normally broadcast through their own RPC
 * (`solana:signAndSendTransaction`), which no setting of ours can steer. So
 * when the trader picks `SHIELD` or `RELAY`, the web signs *without* sending
 * (`solana:signTransaction`) and hands the signed bytes to
 * `POST /trade/broadcast`, which lands here:
 *
 * - `SHIELD` → Jito block engine, `sendTransaction` on
 *   `/api/v1/transactions?bundleOnly=true`. The transaction must already carry
 *   a tip transfer to a Jito tip account (`solana-fees.ts` writes it at
 *   prepare time); `bundleOnly` means Jito never also forwards it over the
 *   public mempool path, which is the whole point.
 * - `RELAY` → `SOLANA_PRIVATE_RPC_URL` (a staked / private endpoint that does
 *   not gossip to the public mempool). No tip.
 * - Either route failing falls back to the ordinary RPC, and the outcome says
 *   so (`via: 'rpc'`, `fallback: <why>`) so the UI can toast instead of
 *   letting the trader believe the trade was protected.
 *
 * `routeFor()` is what `/trade/prepare` uses to decide whether a tip buys
 * anything on this deployment: with no `JITO_BLOCK_ENGINE_URL` (devnet, local)
 * a Jito tip is money thrown at a mainnet address for nothing, so prepare
 * writes none and reports `mevRoute: 'none'`.
 */

export type MevMode = 'SHIELD' | 'RELAY' | 'OFF';
export type MevRoute = 'jito' | 'private' | 'none';

export interface BroadcastOutcome {
  signature: string;
  /** How the transaction actually went out. */
  via: 'jito' | 'private' | 'rpc';
  /** Present when `via` is not the route the mode asked for: the reason it fell back. */
  fallback?: string;
}

export class BroadcastFailedError extends RouterError {
  readonly code = 'broadcast_failed';
  readonly httpStatus = 502;

  constructor(detail: string, cause?: unknown) {
    super(detail, { cause });
    this.name = 'BroadcastFailedError';
  }
}

export interface SolanaBroadcasterOptions {
  /** `SOLANA_RPC_URL` — the always-available fallback. */
  rpcUrl: string;
  jitoBlockEngineUrl?: string | undefined;
  privateRpcUrl?: string | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  logger?: Pick<Logger, 'warn'>;
}

export interface SolanaBroadcaster {
  routeFor(mode: MevMode): MevRoute;
  send(signedTransactionBase64: string, mode: MevMode): Promise<BroadcastOutcome>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class HttpSolanaBroadcaster implements SolanaBroadcaster {
  private readonly rpcUrl: string;
  private readonly jitoUrl: string | undefined;
  private readonly privateUrl: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Logger, 'warn'> | undefined;

  constructor(opts: SolanaBroadcasterOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.jitoUrl = opts.jitoBlockEngineUrl?.replace(/\/+$/, '') || undefined;
    this.privateUrl = opts.privateRpcUrl || undefined;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.logger = opts.logger;
  }

  routeFor(mode: MevMode): MevRoute {
    if (mode === 'SHIELD') return this.jitoUrl ? 'jito' : 'none';
    if (mode === 'RELAY') return this.privateUrl ? 'private' : 'none';
    return 'none';
  }

  async send(tx: string, mode: MevMode): Promise<BroadcastOutcome> {
    const route = this.routeFor(mode);
    let fallback: string | undefined;

    if (route === 'jito') {
      try {
        const signature = await jsonRpc<string>(
          this.fetchImpl,
          `${this.jitoUrl}/api/v1/transactions?bundleOnly=true`,
          'sendTransaction',
          [tx, { encoding: 'base64' }],
          { timeoutMs: this.timeoutMs },
        );
        return { signature, via: 'jito' };
      } catch (err) {
        fallback = `jito: ${describe(err)}`;
        this.logger?.warn('trade/broadcast: Jito refused the transaction; falling back to RPC', {
          err: describe(err),
        });
      }
    } else if (route === 'private') {
      try {
        const signature = await this.rpcSend(this.privateUrl as string, tx);
        return { signature, via: 'private' };
      } catch (err) {
        fallback = `private rpc: ${describe(err)}`;
        this.logger?.warn('trade/broadcast: private RPC refused the transaction; falling back', {
          err: describe(err),
        });
      }
    } else if (mode !== 'OFF') {
      fallback = mode === 'SHIELD' ? 'jito_not_configured' : 'private_rpc_not_configured';
    }

    try {
      const signature = await this.rpcSend(this.rpcUrl, tx);
      return fallback ? { signature, via: 'rpc', fallback } : { signature, via: 'rpc' };
    } catch (err) {
      throw new BroadcastFailedError(
        (fallback ? `${fallback}; ` : '') + `rpc: ${describe(err)}`,
        err,
      );
    }
  }

  private rpcSend(url: string, tx: string): Promise<string> {
    return jsonRpc<string>(
      this.fetchImpl,
      url,
      'sendTransaction',
      // Preflight stays on: a transaction that would fail simulation costs the
      // trader its fee if it lands, and the wallet's own path simulates too.
      [tx, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }],
      { timeoutMs: this.timeoutMs },
    );
  }
}
