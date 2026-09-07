import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { ChainRpc, EvmTransactionSource } from '../chain/types.js';
import { ERC20_ABI, LAUNCHPAD_ABI, WETH_ABI } from './evm-abi.js';
import type { UniswapClient, UniswapQuoteResponseRaw } from './uniswap.js';

/** Mirrors `solana-tx.ts`'s `asSolanaBlockhashSource` — narrows a `ChainRpc` to the receipt-lookup capability only the real `EvmRpc` (and `FakeChainRpc`) implement. */
export function asEvmTransactionSource(rpc: ChainRpc): EvmTransactionSource | undefined {
  const candidate = rpc as Partial<EvmTransactionSource>;
  return typeof candidate.getTransactionReceipt === 'function' ? (candidate as EvmTransactionSource) : undefined;
}

/**
 * Robinhood Chain has **no atomic native-in trade** on this launchpad, for
 * every base token including the wrapped-native fast path. This is the load
 * -bearing finding of this phase's RH work, so it is stated here, in
 * `docs/rh-trade-atomicity-gap.md`, and again in the phase report — not just
 * once.
 *
 * `docs/robinhood-chain.md` §3.3 already worked out why and what the real
 * fix is: **a `StonkzRouter` periphery contract**, deployed on Robinhood
 * Chain, that receives the swap output itself (Universal Router recipient =
 * `ADDRESS_THIS`) before calling the curve, so the whole thing reverts
 * atomically on failure. That contract does not exist anywhere in
 * `programs/evm` — I confirmed this by reading every file in that tree ahead
 * of writing this module — and building on-chain Solidity is outside this
 * phase's scope (`apps/api`, `apps/indexer`, and new `packages/*` only).
 *
 * What this module ships instead, so the gap is *usable* rather than just
 * documented: a fully-encoded, ordered **sequence of separate transactions**
 * (`EvmStep[]`) covering every case:
 *
 * - **Buy, base = wrapped-native (WETH):** `WETH.deposit{value}()` \u2192
 *   `WETH.approve(launchpad, amount)` \u2192 `launchpad.buy(token, amount, minOut)`.
 * - **Buy, base = anything else:** a Uniswap swap with the trader's own EOA
 *   as recipient (via `UniswapClient.swap`, ETH \u2192 base) \u2192
 *   `base.approve(launchpad, amount)` \u2192 `launchpad.buy(...)`.
 * - **Sell, base = WETH:** `token.approve(launchpad, amount)` \u2192
 *   `launchpad.sell(token, amount, minOut)` \u2192 `WETH.withdraw(amount)`.
 * - **Sell, base = anything else:** `token.approve(launchpad, amount)` \u2192
 *   `launchpad.sell(...)` \u2192 a Uniswap swap base \u2192 ETH, recipient the trader.
 *
 * Every step after the first can only be signed once the previous one has
 * confirmed — `atomic: false` and each step's own `warning` say this
 * explicitly so the frontend cannot present it as a single wallet
 * confirmation. **A trader who stops midway is left holding whatever the
 * last completed step produced** (WETH, approved-but-unspent base, or the
 * launched token with no ETH yet) — exactly the failure mode plan step 83
 * forbids for a *single* transaction, accepted here only because the
 * alternative is not shipping RH trading in this phase at all. This must not
 * ship to production trading real user funds without the router.
 */

export interface EvmStep {
  to: Address;
  data: Hex;
  /** Decimal wei string; `'0'` for a non-payable call. */
  value: string;
  description: string;
}

export interface EvmTradePlan {
  atomic: false;
  chain: 'RH';
  steps: EvmStep[];
  warning: string;
}

const ATOMICITY_WARNING =
  'Robinhood Chain has no StonkzRouter periphery contract yet, so this trade cannot be one atomic ' +
  'transaction (docs/robinhood-chain.md \u00a73.3). Each step below must be signed and confirmed in order; ' +
  'stopping partway leaves you holding an intermediate asset (wrapped ETH, an approved-but-unspent ' +
  'balance, or the launched token with no ETH received yet), not your original ETH.';

export interface EvmTradeInputs {
  trader: Address;
  launchpad: Address;
  token: Address;
  baseToken: Address;
  /** `null` when `aggregatorFor` selected no aggregator, i.e. `baseToken` already is WETH. */
  uniswap: { client: UniswapClient; quote: UniswapQuoteResponseRaw } | null;
  amountBaseOrToken: bigint;
  minOut: bigint;
  side: 'buy' | 'sell';
}

function launchpadCall(fn: 'buy' | 'sell', token: Address, amount: bigint, minOut: bigint): Hex {
  return encodeFunctionData({
    abi: LAUNCHPAD_ABI,
    functionName: fn,
    args: [token, amount, minOut],
  });
}

function approveCall(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] });
}

export async function buildEvmTradePlan(input: EvmTradeInputs): Promise<EvmTradePlan> {
  const steps: EvmStep[] = [];

  if (input.side === 'buy') {
    if (input.uniswap) {
      const swap = await input.uniswap.client.swap(input.uniswap.quote);
      steps.push({
        to: swap.swap.to as Address,
        data: swap.swap.data as Hex,
        value: swap.swap.value,
        description: `Swap ETH \u2192 base token via Uniswap (recipient: your wallet)`,
      });
    } else {
      steps.push({
        to: input.baseToken,
        data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit', args: [] }),
        value: input.amountBaseOrToken.toString(),
        description: 'Wrap ETH \u2192 WETH',
      });
    }
    steps.push({
      to: input.baseToken,
      data: approveCall(input.launchpad, input.amountBaseOrToken),
      value: '0',
      description: 'Approve the launchpad to pull base tokens',
    });
    steps.push({
      to: input.launchpad,
      data: launchpadCall('buy', input.token, input.amountBaseOrToken, input.minOut),
      value: '0',
      description: 'Buy on the curve',
    });
  } else {
    steps.push({
      to: input.token,
      data: approveCall(input.launchpad, input.amountBaseOrToken),
      value: '0',
      description: 'Approve the launchpad to pull the launched token',
    });
    steps.push({
      to: input.launchpad,
      data: launchpadCall('sell', input.token, input.amountBaseOrToken, input.minOut),
      value: '0',
      description: 'Sell on the curve',
    });
    if (input.uniswap) {
      const swap = await input.uniswap.client.swap(input.uniswap.quote);
      steps.push({
        to: swap.swap.to as Address,
        data: swap.swap.data as Hex,
        value: swap.swap.value,
        description: 'Swap base token \u2192 ETH via Uniswap (recipient: your wallet)',
      });
    } else {
      steps.push({
        to: input.baseToken,
        data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [input.minOut] }),
        value: '0',
        description: 'Unwrap WETH \u2192 ETH',
      });
    }
  }

  return { atomic: false, chain: 'RH', steps, warning: ATOMICITY_WARNING };
}
