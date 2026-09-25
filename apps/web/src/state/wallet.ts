import {
  ALL_NETS,
  NET_INFO,
  type NativeUnit,
  type Net,
  type NetworkOption,
  type Wallet,
  nativeUnit as unitFor,
} from '@stonkz/shared';
import { envLabel } from '../wallet/chain.js';

/**
 * The connected wallet.
 *
 * Every net in `ALL_NETS` is live in the picker. In live mode the values
 * below are placeholders only until `api.connect()` overwrites them with the
 * connected wallet's real address, label and on-chain balance (Wallet
 * Standard for SIWS, EIP-1193/WalletConnect for SIWE — `wallet/`). In sim
 * mode they stay as written, which is what a sandbox should show.
 * `index.html:2443`
 */

/** Sim placeholders per net: a deterministic avatar seed and a fake address. */
const SIM_IDENTITY: Record<Net, { provider: string; seed: number; addr: string; full: string }> = {
  SOL: {
    provider: 'PHANTOM',
    seed: 80231,
    addr: '7xKQ..9fRt',
    full: '7xKQ8mNvRk4pB2sT9dLcW6hJ1yZaQe3Ux9fRt',
  },
  BASE: {
    provider: 'COINBASE WALLET',
    seed: 55102,
    addr: '0xBa5e..0000',
    full: '0xBa5e000000000000000000000000000000000000',
  },
  ARC: {
    provider: 'METAMASK',
    seed: 61207,
    addr: '0xA7c1..19dD',
    full: '0xA7c1000000000000000000000000000000019dD0',
  },
  RH: {
    provider: 'ROBINHOOD WALLET',
    seed: 44119,
    addr: 'RH7f..dP2c',
    full: 'RH7f2Qm9Lx4vB8nT3kW6hJ1yZaQe3Ux5dP2c',
  },
};

/** Sim balances in the net's own unit — enough to trade, not enough to look rich. */
export const SIM_BALANCE: Record<NativeUnit, number> = { SOL: 12.4, ETH: 3.18, USDC: 250 };

export const NETS: Record<Net, NetworkOption> = Object.fromEntries(
  ALL_NETS.map((net) => {
    const info = NET_INFO[net];
    const id = SIM_IDENTITY[net];
    return [
      net,
      {
        k: net,
        name: info.name,
        sub: envLabel(net),
        col: info.col,
        provider: id.provider,
        seed: id.seed,
        addr: id.addr,
        full: id.full,
      },
    ];
  }),
) as Record<Net, NetworkOption>;

export const WALLET: Wallet = {
  on: false,
  net: 'SOL',
  addr: NETS.SOL.addr,
  full: NETS.SOL.full,
  sol: SIM_BALANCE.SOL,
  seed: NETS.SOL.seed,
  provider: NETS.SOL.provider,
};

/** The picker entry for the connected (or default) network. */
export function netOf(): NetworkOption {
  return NETS[WALLET.net] ?? NETS.SOL;
}

/**
 * The gas token the ticket is denominated in: SOL on Solana, ETH on Base and
 * Robinhood, USDC on Arc. The trade box never switches to the pair's base
 * mint. `index.html:2694`
 */
export function nativeUnit(): NativeUnit {
  return unitFor(WALLET.net);
}

const NET_KEY = 'stonkz.net.v1';

/** Point the wallet at a network without asserting a connection yet. */
export function selectNet(net: Net): NetworkOption {
  const n = NETS[net] ?? NETS.SOL;
  WALLET.net = n.k;
  WALLET.addr = n.addr;
  WALLET.full = n.full;
  WALLET.seed = n.seed;
  WALLET.provider = n.provider;
  try {
    localStorage.setItem(NET_KEY, n.k);
  } catch {
    /* private mode: the pick just does not survive a reload */
  }
  return n;
}

/** The net picked last time, so the picker and board open where the user left off. */
export function savedNet(): Net | null {
  try {
    const raw = localStorage.getItem(NET_KEY);
    return raw && (ALL_NETS as readonly string[]).includes(raw) ? (raw as Net) : null;
  } catch {
    return null;
  }
}

/**
 * Native price feeds for the footer and USD conversions.
 *
 * `usd` is the *connected* chain's mark (wallet USD ≈ balance × usd).
 * `sol` / `eth` are both kept so the footer can show SOL and ETH together;
 * `usdc` is pinned at one dollar. Live mode overwrites these from
 * `GET /native-price` and `/me`.
 */
export const NATIVE_PRICE = { usd: 214.08, sol: 214.08, eth: 3500, usdc: 1 };

/** The USD mark of a native unit, from the feeds above. */
export function nativeUsd(unit: NativeUnit): number {
  return unit === 'ETH' ? NATIVE_PRICE.eth : unit === 'USDC' ? NATIVE_PRICE.usdc : NATIVE_PRICE.sol;
}
