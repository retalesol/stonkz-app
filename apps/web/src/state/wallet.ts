import { type NativeUnit, type Net, type NetworkOption, type Wallet, nativeUnit as unitFor } from '@stonkz/shared';

/**
 * The connected wallet.
 *
 * Both networks are live in the picker from day one. In live mode the values
 * below are placeholders only until `api.connect()` overwrites them with the
 * connected wallet's real address, label and on-chain balance (Wallet
 * Standard for SIWS, EIP-1193/WalletConnect for SIWE — `wallet/`). In sim
 * mode they stay as written, which is what a sandbox should show.
 * `index.html:2443`
 */

export const NETS: Record<Net, NetworkOption> = {
  SOL: {
    k: 'SOL',
    name: 'SOLANA',
    sub: 'MAINNET-BETA',
    col: '#14f195',
    provider: 'PHANTOM',
    seed: 80231,
    addr: '7xKQ..9fRt',
    full: '7xKQ8mNvRk4pB2sT9dLcW6hJ1yZaQe3Ux9fRt',
  },
  RH: {
    k: 'RH',
    name: 'ROBINHOOD',
    sub: 'RH CHAIN',
    col: '#00c805',
    provider: 'ROBINHOOD WALLET',
    seed: 44119,
    addr: 'RH7f..dP2c',
    full: 'RH7f2Qm9Lx4vB8nT3kW6hJ1yZaQe3Ux5dP2c',
  },
};

export const WALLET: Wallet = {
  on: false,
  net: 'SOL',
  addr: NETS.SOL.addr,
  full: NETS.SOL.full,
  sol: 12.4,
  seed: NETS.SOL.seed,
  provider: NETS.SOL.provider,
};

/** The picker entry for the connected (or default) network. */
export function netOf(): NetworkOption {
  return NETS[WALLET.net] ?? NETS.SOL;
}

/**
 * The gas token the ticket is denominated in: SOL on Solana, ETH on Robinhood.
 * The trade box never switches to the pair's base mint. `index.html:2694`
 */
export function nativeUnit(): NativeUnit {
  return unitFor(WALLET.net);
}

/** Point the wallet at a network without asserting a connection yet. */
export function selectNet(net: Net): NetworkOption {
  const n = NETS[net] ?? NETS.SOL;
  WALLET.net = n.k;
  WALLET.addr = n.addr;
  WALLET.full = n.full;
  WALLET.seed = n.seed;
  WALLET.provider = n.provider;
  return n;
}

/**
 * Native price feeds for the footer and USD conversions.
 *
 * `usd` is the *connected* chain's mark (wallet USD ≈ balance × usd).
 * `sol` / `eth` are both kept so the footer can show SOL and ETH together.
 * Live mode overwrites these from `GET /native-price` and `/me`.
 */
export const NATIVE_PRICE = { usd: 214.08, sol: 214.08, eth: 3500 };
