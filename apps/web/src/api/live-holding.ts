import { createPublicClient, formatUnits, http, type PublicClient } from 'viem';
import { isEvmNet, type EvmNet } from '@stonkz/shared';
import { EVM_CHAINS } from '../wallet/chain.js';
import type { SimCoin } from '../state/coins.js';
import { setHoldingTokens } from '../state/holdings.js';

/** One read client per EVM net: a Base coin's balance lives on Base, not RH. */
const clients = new Map<EvmNet, PublicClient>();
function rpcFor(net: EvmNet): PublicClient {
  let c = clients.get(net);
  if (!c) {
    c = createPublicClient({ transport: http(EVM_CHAINS[net].rpcUrl) }) as PublicClient;
    clients.set(net, c);
  }
  return c;
}

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * Format atoms for the sell amount input without float overshoot.
 * Truncates to 8 decimal places (still floored), so `parseFloat` → API
 * `toAtoms(…, 18)` cannot exceed the on-chain balance.
 */
export function safeSellAmountInput(atoms: bigint, decimals = 18): string {
  if (atoms <= 0n) return '0';
  const places = Math.min(8, decimals);
  const factor = 10n ** BigInt(decimals - places);
  const truncated = atoms / factor; // floor
  const s = truncated.toString().padStart(places + 1, '0');
  const whole = s.slice(0, s.length - places) || '0';
  const frac = s.slice(s.length - places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Pull the wallet's ERC-20 balance into HOLD so the position bar matches MetaMask. */
export async function syncHoldingFromChain(c: SimCoin, wallet: string): Promise<number | null> {
  const net = c.net ?? 'SOL';
  if (!c.mint || !wallet || !wallet.startsWith('0x') || !isEvmNet(net)) return null;
  try {
    const raw = await rpcFor(net).readContract({
      address: c.mint as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [wallet as `0x${string}`],
    });
    const tok = Number(formatUnits(raw, 18));
    setHoldingTokens(c.sym, tok, undefined, raw.toString());
    return tok;
  } catch {
    return null;
  }
}
