import { type NativeUnit, type Net, type NetworkOption, type Wallet, nativeUnit as unitFor } from '@stonkz/shared';

/**
 * The connected wallet.
 *
 * Both networks are live in the picker from day one — the sim just fakes the
 * signature. Phase 1.B replaces `connect()` with SIWS (Wallet Standard) and
 * SIWE (wagmi/viem) and `balance` with a real RPC read; nothing else here
 * changes shape. `index.html:2443`
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
 * Native price feed for the footer and USD conversions.
 *
 * Hard-coded in the sim; Phase 1.B swaps it for the connected network's oracle
 * price (SOLUSD or ETHUSD) so the footer stops claiming $214.08 on Robinhood.
 */
export const NATIVE_PRICE = { usd: 214.08 };
