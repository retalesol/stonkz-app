import { EVM_NETS, NET_INFO, isEvmNet, type EvmNet, type Net } from '@stonkz/shared';

/**
 * Chain identity, as the wallet layer needs it.
 *
 * Every value here is either read from a Vite env var or a documented default:
 * Robinhood's from `docs/robinhood-chain.md` §2.2 / §1 rows 3, 5, 8; Base from
 * base.org; Arc from docs.arc.io ("Connect to Arc"). Nothing is guessed: the
 * explorer hosts in particular are documented phishing-lookalike targets
 * (`docs/robinhood-chain.md` §2.3), so they stay config values rather than
 * being built by string-guessing.
 *
 * Product facts (gas unit, colours, caps) live in `@stonkz/shared`'s
 * `NET_INFO`; this file only adds the environment-specific chain ids, RPCs and
 * explorers, keyed by the same `EvmNet`.
 */

function envStr(key: string, fallback: string): string {
  const v = import.meta.env[key] as string | undefined;
  return v === undefined || v === '' ? fallback : v;
}

export interface EvmChainConfig {
  readonly net: EvmNet;
  readonly chainId: number;
  readonly chainIdHex: `0x${string}`;
  readonly chainName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** The `wallet_addEthereumChain` payload for a wallet that has never seen the chain. */
  readonly addChainParams: {
    readonly chainId: `0x${string}`;
    readonly chainName: string;
    readonly nativeCurrency: {
      readonly name: string;
      readonly symbol: string;
      readonly decimals: 18;
    };
    readonly rpcUrls: readonly string[];
    readonly blockExplorerUrls: readonly string[];
  };
  /** Human label for the environment this build settles on, for the footer. */
  readonly envLabel: string;
  /** Faucet for test funds, when the configured chain is a testnet. */
  readonly faucetUrl: string | null;
  /** True when the configured chain id is the production chain. */
  readonly isMainnet: boolean;
}

/** Staging defaults to RH testnet (46630); mainnet is 4663. */
export const RH_CHAIN_ID: number = Number(envStr('VITE_RH_CHAIN_ID', '46630'));
/** Base Sepolia by default — override with `VITE_BASE_CHAIN_ID` for mainnet (8453). */
export const BASE_CHAIN_ID: number = Number(envStr('VITE_BASE_CHAIN_ID', '84532'));
/**
 * Arc mainnet (5042). The public testnet (5042002) closed on 17 Sep 2026, so
 * there is no test chain to default to: Arc is tested on mainnet under the
 * `NET_INFO.ARC.maxTradeUsd` cap.
 */
export const ARC_CHAIN_ID: number = Number(envStr('VITE_ARC_CHAIN_ID', '5042'));

function hex(id: number): `0x${string}` {
  return ('0x' + id.toString(16)) as `0x${string}`;
}

function build(
  net: EvmNet,
  chainId: number,
  chainName: string,
  rpcUrl: string,
  explorerUrl: string,
  envLabel: string,
  faucetUrl: string | null,
  isMainnet: boolean,
): EvmChainConfig {
  const info = NET_INFO[net];
  const explorer = explorerUrl.replace(/\/+$/, '');
  return {
    net,
    chainId,
    chainIdHex: hex(chainId),
    chainName,
    rpcUrl,
    explorerUrl: explorer,
    addChainParams: {
      chainId: hex(chainId),
      chainName,
      // MetaMask only accepts 18-decimal native currencies, which is also how
      // Arc represents native USDC at the EVM layer (arc-node issue #95).
      nativeCurrency: {
        name: info.unit === 'USDC' ? 'USDC' : 'Ether',
        symbol: info.unit,
        decimals: 18,
      },
      rpcUrls: [rpcUrl],
      blockExplorerUrls: [explorer],
    },
    envLabel,
    faucetUrl,
    isMainnet,
  };
}

const RH_IS_MAINNET = RH_CHAIN_ID === 4663;
const BASE_IS_MAINNET = BASE_CHAIN_ID === 8453;
const ARC_IS_MAINNET = ARC_CHAIN_ID === 5042;

export const EVM_CHAINS: Record<EvmNet, EvmChainConfig> = {
  RH: build(
    'RH',
    RH_CHAIN_ID,
    RH_IS_MAINNET ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
    envStr(
      'VITE_RH_RPC',
      // Rate-limited public RPC by default — Robinhood documents it as "not
      // recommended for production use" (row 5), so a deployment is expected
      // to set `VITE_RH_RPC` to an Alchemy endpoint.
      RH_IS_MAINNET
        ? 'https://rpc.mainnet.chain.robinhood.com'
        : 'https://rpc.testnet.chain.robinhood.com',
    ),
    envStr(
      'VITE_RH_EXPLORER',
      RH_IS_MAINNET
        ? 'https://robinhoodchain.blockscout.com'
        : 'https://explorer.testnet.chain.robinhood.com',
    ),
    RH_IS_MAINNET ? 'RH MAINNET' : 'RH TESTNET',
    RH_IS_MAINNET ? null : 'https://faucet.testnet.chain.robinhood.com',
    RH_IS_MAINNET,
  ),
  BASE: build(
    'BASE',
    BASE_CHAIN_ID,
    BASE_IS_MAINNET ? 'Base' : 'Base Sepolia',
    envStr(
      'VITE_BASE_RPC',
      BASE_IS_MAINNET ? 'https://mainnet.base.org' : 'https://sepolia.base.org',
    ),
    envStr(
      'VITE_BASE_EXPLORER',
      BASE_IS_MAINNET ? 'https://basescan.org' : 'https://sepolia.basescan.org',
    ),
    BASE_IS_MAINNET ? 'BASE MAINNET' : 'BASE SEPOLIA',
    BASE_IS_MAINNET ? null : 'https://portal.cdp.coinbase.com/products/faucet',
    BASE_IS_MAINNET,
  ),
  ARC: build(
    'ARC',
    ARC_CHAIN_ID,
    ARC_IS_MAINNET ? 'Arc' : 'Arc Testnet',
    envStr(
      'VITE_ARC_RPC',
      ARC_IS_MAINNET ? 'https://rpc.arc.network' : 'https://rpc.testnet.arc.network',
    ),
    envStr(
      'VITE_ARC_EXPLORER',
      ARC_IS_MAINNET ? 'https://explorer.arc.network' : 'https://explorer.testnet.arc.network',
    ),
    ARC_IS_MAINNET ? 'ARC MAINNET (CAPPED)' : 'ARC TESTNET',
    null,
    ARC_IS_MAINNET,
  ),
};

/* Named exports kept for the existing call sites and tests. */
export const RH_CHAIN_ID_HEX = EVM_CHAINS.RH.chainIdHex;
export const RH_RPC_URL = EVM_CHAINS.RH.rpcUrl;
export const RH_EXPLORER_URL = EVM_CHAINS.RH.explorerUrl;
export const RH_ADD_CHAIN_PARAMS = EVM_CHAINS.RH.addChainParams;
export const BASE_CHAIN_ID_HEX = EVM_CHAINS.BASE.chainIdHex;
export const BASE_RPC_URL = EVM_CHAINS.BASE.rpcUrl;
export const BASE_EXPLORER_URL = EVM_CHAINS.BASE.explorerUrl;
export const BASE_ADD_CHAIN_PARAMS = EVM_CHAINS.BASE.addChainParams;
export const ARC_RPC_URL = EVM_CHAINS.ARC.rpcUrl;
export const ARC_EXPLORER_URL = EVM_CHAINS.ARC.explorerUrl;

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
/** Explorer page for a transaction on `net`. Solana's explorer takes the cluster as a query. */
export function explorerTxUrl(net: Net, sig: string): string {
  if (isEvmNet(net)) return EVM_CHAINS[net].explorerUrl + '/tx/' + sig;
  const cluster = solanaWalletStandardChain().slice('solana:'.length);
  return (
    'https://explorer.solana.com/tx/' + sig + (cluster === 'mainnet' ? '' : '?cluster=' + cluster)
  );
}

/** Explorer page for an address (a mint, a pool, a wallet) on `net`. */
export function explorerAddressUrl(net: Net, address: string): string {
  if (isEvmNet(net)) return EVM_CHAINS[net].explorerUrl + '/address/' + address;
  const cluster = solanaWalletStandardChain().slice('solana:'.length);
  return (
    'https://explorer.solana.com/address/' +
    address +
    (cluster === 'mainnet' ? '' : '?cluster=' + cluster)
  );
}

/**
 * Where to trade a graduated coin. Solana mainnet: Meteora's own DLMM page
 * for the pool. Everywhere else (the EVM testnets run a Stonkz-deployed V2
 * factory no Uniswap front end knows about; Solana devnet has no Meteora UI)
 * the pool's explorer page, where the pair contract and its reserves are
 * verifiable and one click from a swap.
 */
export function dexPoolUrl(net: Net, pool: string): string {
  if (!isEvmNet(net) && solanaWalletStandardChain() === 'solana:mainnet') {
    return 'https://app.meteora.ag/dlmm/' + pool;
  }
  return explorerAddressUrl(net, pool);
}

export function chainLabel(net: Net): string {
  if (net === 'SOL') return 'SOLANA ' + SOLANA_CLUSTER.toUpperCase();
  return NET_INFO[net].name + ' (' + EVM_CHAINS[net].chainId + ')';
}

/** The environment label per net, for the footer disclosure. */
export function envLabel(net: Net): string {
  if (net === 'SOL') return 'SOLANA ' + SOLANA_CLUSTER.toUpperCase();
  return EVM_CHAINS[net].envLabel;
}

/** Faucet for the configured environment, or null on mainnet. */
export function faucetUrl(net: Net): string | null {
  if (net === 'SOL') return SOLANA_CLUSTER === 'mainnet-beta' ? null : 'https://faucet.solana.com';
  return EVM_CHAINS[net].faucetUrl;
}

/** True when this build settles `net` on a production chain. */
export function isMainnet(net: Net): boolean {
  if (net === 'SOL') return SOLANA_CLUSTER === 'mainnet-beta';
  return EVM_CHAINS[net].isMainnet;
}

export function evmChainIdForNet(net: Net): number {
  return net === 'SOL' ? EVM_CHAINS.RH.chainId : EVM_CHAINS[net].chainId;
}

export function evmAddChainParams(net: Net): EvmChainConfig['addChainParams'] {
  return net === 'SOL' ? EVM_CHAINS.RH.addChainParams : EVM_CHAINS[net].addChainParams;
}

/* -------------------------------------------------------------------------- */
/* Deployment record — apps/web/public/chains.json                             */
/* -------------------------------------------------------------------------- */

export interface DeployedChain {
  readonly launchpad: string | null;
  readonly router: string | null;
  readonly programId?: string;
  readonly deployedAt: string | null;
}

/** `dev` holds the test chains (and Arc's capped mainnet); `main` the production ones. */
export type DeployEnv = 'dev' | 'main';

/** Which env this build settles on: mainnet on every net, or the dev set. */
export const DEPLOY_ENV: DeployEnv =
  (import.meta.env['VITE_ENV'] as string | undefined) === 'main' ? 'main' : 'dev';

const deployed: Partial<Record<Net, DeployedChain>> = {};
let chainsLoaded = false;

/**
 * Read `chains.json` (written by `scripts/emit-chains.mjs`) once at boot.
 * Failing to fetch it leaves every net "unknown", which the picker treats as
 * deployed so a CDN hiccup does not lock the app; the API is the enforcing
 * side and refuses trades on a net it has no address for.
 */
export async function loadChains(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl('/chains.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const doc = (await res.json()) as Partial<
      Record<DeployEnv, Record<string, Partial<DeployedChain>>>
    >;
    const envBlock = doc[DEPLOY_ENV] ?? {};
    for (const net of Object.keys(NET_INFO) as Net[]) {
      const row = envBlock[net];
      deployed[net] = row
        ? {
            launchpad: row.launchpad ?? null,
            router: row.router ?? null,
            ...(row.programId ? { programId: row.programId } : {}),
            deployedAt: row.deployedAt ?? null,
          }
        : { launchpad: null, router: null, deployedAt: null };
    }
    chainsLoaded = true;
  } catch {
    /* offline or not served: see above */
  }
}

/** True until chains.json says otherwise: nets it lists without a launchpad or program are not deployed. */
export function isDeployed(net: Net): boolean {
  if (!chainsLoaded) return true;
  const d = deployed[net];
  if (!d) return false;
  return net === 'SOL' ? !!d.programId : !!d.launchpad;
}

export function deployment(net: Net): DeployedChain | null {
  return deployed[net] ?? null;
}

/** The EVM net a chain id belongs to in this build, or null. */
export function evmNetForChainId(chainId: number): EvmNet | null {
  for (const net of EVM_NETS) if (EVM_CHAINS[net].chainId === chainId) return net;
  return null;
}
