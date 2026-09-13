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

/** `4663` (`0x1237`) on mainnet — `docs/robinhood-chain.md` row 3. */
export const RH_CHAIN_ID: number = Number(envStr('VITE_RH_CHAIN_ID', '4663'));

/** Hex chain id, the shape every `wallet_*EthereumChain` call wants. */
export const RH_CHAIN_ID_HEX = '0x' + RH_CHAIN_ID.toString(16);

/**
 * Rate-limited public RPC by default — Robinhood documents it as "not
 * recommended for production use" (row 5), so a deployment is expected to
 * set `VITE_RH_RPC` to an Alchemy endpoint.
 */
export const RH_RPC_URL: string = envStr('VITE_RH_RPC', 'https://rpc.mainnet.chain.robinhood.com');

export const RH_EXPLORER_URL: string = envStr('VITE_RH_EXPLORER', 'https://robinhoodchain.blockscout.com');

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
  return net === 'SOL' ? 'SOLANA ' + SOLANA_CLUSTER.toUpperCase() : 'ROBINHOOD CHAIN (' + RH_CHAIN_ID + ')';
}
