/**
 * Configuration for the funded-testnet integration harness.
 *
 * Every scenario declares which of these it needs. A scenario whose
 * requirements are unset is reported **SKIPPED**, never passed — the whole
 * point of this harness is that it cannot produce a green run without real
 * chain access, the way the Playwright `live.spec.ts` suite can (it mocks the
 * write routes, because practice wallets hold no balance).
 */

export interface Config {
  /** The API under test. A staging deploy, not a mock. */
  apiBaseUrl: string | null;

  /* ------------------------------------------------------------- Solana */
  solRpcUrl: string | null;
  /** Base58 secret key of a **funded** devnet/testnet keypair. */
  solSecretKey: string | null;
  solLaunchpadProgramId: string | null;
  /** A second funded keypair, needed for tip verification (sender + recipient). */
  solSecretKeyB: string | null;

  /* --------------------------------------------------------- Robinhood */
  rhRpcUrl: string | null;
  /** 0x-prefixed private key of a **funded** RH testnet account. */
  rhPrivateKey: string | null;
  rhLaunchpadAddress: string | null;
  rhRouterAddress: string | null;
  /** Deployed ERC-1271 smart account whose owner is `rhPrivateKey`. */
  rhSmartAccountAddress: string | null;

  /* ------------------------------------------------------------ tuning */
  /** Trade size in native units. Keep small: this spends real testnet funds. */
  tradeAmountNative: number;
  /** How long to wait for the indexer to reflect a confirmed trade. */
  indexerTimeoutMs: number;
  /** Set to run scenarios that graduate a token — slow and expensive. */
  runGraduation: boolean;
}

function str(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got ${v})`);
  return n;
}

export function loadConfig(): Config {
  return {
    apiBaseUrl: str('INTEGRATION_API_URL'),

    solRpcUrl: str('INTEGRATION_SOL_RPC_URL'),
    solSecretKey: str('INTEGRATION_SOL_SECRET_KEY'),
    solLaunchpadProgramId: str('INTEGRATION_SOL_LAUNCHPAD_PROGRAM_ID'),
    solSecretKeyB: str('INTEGRATION_SOL_SECRET_KEY_B'),

    rhRpcUrl: str('INTEGRATION_RH_RPC_URL'),
    rhPrivateKey: str('INTEGRATION_RH_PRIVATE_KEY'),
    rhLaunchpadAddress: str('INTEGRATION_RH_LAUNCHPAD_ADDRESS'),
    rhRouterAddress: str('INTEGRATION_RH_ROUTER_ADDRESS'),
    rhSmartAccountAddress: str('INTEGRATION_RH_SMART_ACCOUNT'),

    tradeAmountNative: num('INTEGRATION_TRADE_AMOUNT', 0.01),
    indexerTimeoutMs: num('INTEGRATION_INDEXER_TIMEOUT_MS', 90_000),
    runGraduation: str('INTEGRATION_RUN_GRADUATION') === '1',
  };
}

export type ConfigKey = keyof Config;

/** Human-readable env var name for a config key, for skip messages. */
export const ENV_NAMES: Partial<Record<ConfigKey, string>> = {
  apiBaseUrl: 'INTEGRATION_API_URL',
  solRpcUrl: 'INTEGRATION_SOL_RPC_URL',
  solSecretKey: 'INTEGRATION_SOL_SECRET_KEY',
  solLaunchpadProgramId: 'INTEGRATION_SOL_LAUNCHPAD_PROGRAM_ID',
  solSecretKeyB: 'INTEGRATION_SOL_SECRET_KEY_B',
  rhRpcUrl: 'INTEGRATION_RH_RPC_URL',
  rhPrivateKey: 'INTEGRATION_RH_PRIVATE_KEY',
  rhLaunchpadAddress: 'INTEGRATION_RH_LAUNCHPAD_ADDRESS',
  rhRouterAddress: 'INTEGRATION_RH_ROUTER_ADDRESS',
  rhSmartAccountAddress: 'INTEGRATION_RH_SMART_ACCOUNT',
};
