import type { Net } from '@stonkz/shared';

/**
 * Chain identity, as the wallet layer needs it.
 *
 * Every value here is either read from a Vite env var or sourced from
 * `docs/robinhood-chain.md` §2.2 / §1 row 3, 5, 8. Nothing is guessed: the
 * explorer host in particular is a documented phishing-lookalike target
 * (`docs/robinhood-chain.md` §2.3), so it stays a config value taken from
 * Robinhood's own page rather than built by string-guessing.
 */

function envStr(key: string, fallback: string): string {
  const v = import.meta.env[key] as string | undefined;
  return v === undefined || v === '' ? fallback : v;
}

/** Staging defaults to RH testnet (46630); mainnet is 4663. */
export const RH_CHAIN_ID: number = Number(envStr('VITE_RH_CHAIN_ID', '46630'));

/** Base Sepolia by default — override with `VITE_BASE_CHAIN_ID` for mainnet (8453). */
export const BASE_CHAIN_ID: number = Number(envStr('VITE_BASE_CHAIN_ID', '84532'));
export const BASE_CHAIN_ID_HEX = '0x' + BASE_CHAIN_ID.toString(16);

export const BASE_RPC_URL: string = envStr('VITE_BASE_RPC', 'https://sepolia.base.org');
export const BASE_EXPLORER_URL: string = envStr(
  'VITE_BASE_EXPLORER',
  'https://sepolia.basescan.org',
);

export const BASE_ADD_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: BASE_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [BASE_RPC_URL],
  blockExplorerUrls: [BASE_EXPLORER_URL],
} as const;

/** Hex chain id, the shape every `wallet_*EthereumChain` call wants. */
export const RH_CHAIN_ID_HEX = '0x' + RH_CHAIN_ID.toString(16);

/**
 * Rate-limited public RPC by default — Robinhood documents it as "not
 * recommended for production use" (row 5), so a deployment is expected to
 * set `VITE_RH_RPC` to an Alchemy endpoint. Staging (46630) defaults to the
 * public testnet RPC.
 */
export const RH_RPC_URL: string = envStr(
  'VITE_RH_RPC',
  RH_CHAIN_ID === 46630
    ? 'https://rpc.testnet.chain.robinhood.com'
    : 'https://rpc.mainnet.chain.robinhood.com',
);

export const RH_EXPLORER_URL: string = envStr(
  'VITE_RH_EXPLORER',
  RH_CHAIN_ID === 46630
    ? 'https://explorer.testnet.chain.robinhood.com'
    : 'https://robinhoodchain.blockscout.com',
);

/**
 * The `wallet_addEthereumChain` payload, for an injected extension that has
 * never seen chain 4663. ETH gas, 18 decimals — row 9; there is no native
 * chain token.
 */
export const RH_ADD_CHAIN_PARAMS = {
  chainId: RH_CHAIN_ID_HEX,
  chainName: RH_CHAIN_ID === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [RH_RPC_URL],
  blockExplorerUrls: [RH_EXPLORER_URL],
} as const;

export const SOLANA_RPC_URL: string = envStr(
  'VITE_HELIUS_RPC',
  envStr('VITE_SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
);

/**
 * `mainnet-beta` | `devnet` | `testnet` | `localnet`, as `VITE_CLUSTER` names it.
 * Defaults to **devnet** so staging and local builds settle against a free
 * cluster; flipping to mainnet is an RPC + cluster env switch only.
 */
export const SOLANA_CLUSTER: string = envStr('VITE_CLUSTER', 'devnet');

/**
 * The Wallet Standard chain identifier for the configured cluster. A wallet
 * advertises the chains it can sign for; connecting a devnet-only wallet to a
 * mainnet app should fail loudly here rather than at broadcast.
 */
export function solanaWalletStandardChain(cluster: string = SOLANA_CLUSTER): string {
  if (cluster === 'devnet') return 'solana:devnet';
  if (cluster === 'testnet') return 'solana:testnet';
  if (cluster === 'localnet') return 'solana:localnet';
  return 'solana:mainnet';
}

/** Human label for the chain a `net` settles on, for error copy. */
export function chainLabel(net: Net): string {
  if (net === 'SOL') return 'SOLANA ' + SOLANA_CLUSTER.toUpperCase();
  if (net === 'BASE') return 'BASE (' + BASE_CHAIN_ID + ')';
  return 'ROBINHOOD CHAIN (' + RH_CHAIN_ID + ')';
}

export function evmChainIdForNet(net: Net): number {
  return net === 'BASE' ? BASE_CHAIN_ID : RH_CHAIN_ID;
}

export function evmAddChainParams(
  net: Net,
): typeof RH_ADD_CHAIN_PARAMS | typeof BASE_ADD_CHAIN_PARAMS {
  return net === 'BASE' ? BASE_ADD_CHAIN_PARAMS : RH_ADD_CHAIN_PARAMS;
}
