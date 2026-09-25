import type { BaseMintRegistry } from '@stonkz/api/router/base-mints';
import type { EvmNet } from '@stonkz/shared';
import { getAddress } from 'viem';
import type { ChainEvent } from '../events.js';
import type { DecodedEvmEvent } from './evm-events.js';
import {
  assertOnChainFeeSplit,
  baseAtomsToUsd,
  inferBaseDecimals,
  marketCapUsd,
  nativeFeeLegs,
  nativeNotional,
  NATIVE_DECIMALS,
  toWhole,
  TOKEN_DECIMALS,
} from './market.js';
import type { TokenRegistry } from './registry.js';
import { UnknownMintError, type TokenMeta } from './registry.js';

/**
 * Decoded Solidity events → the indexer's `ChainEvent` contract.
 *
 * The same shape as `solana-map.ts` and the same three translation decisions
 * (redundant `TreasuryCredit` dropped, `LiquidityMigrated`/`TreasuryWithdrawn`
 * not materialised, no synthetic `CashbackWindow`), because the two programs
 * emit deliberately parallel event sets. Two things differ, both because of
 * the chain rather than the contract:
 *
 * 1. **`nativeAmount` is exact here.** `StonkzRouter` emits `AtomicBuy.ethIn`
 *    / `AtomicSell.ethOut` in the same transaction as the curve `Trade`, so a
 *    routed fill records the ETH the user actually paid instead of a USD
 *    reconstruction. Solana has no router event, so it always reconstructs.
 * 2. **Addresses are EIP-55 checksummed.** Auth sessions store checksummed
 *    EVM wallets; joining on lowercase used to make `GET /stake` look empty
 *    after a successful on-chain stake. Normalise at the decode boundary.
 */
export interface EvmMapContext {
  net: EvmNet;
  txHash: string;
  blockNumber: number;
  blockTimeMs: number;
  registry: TokenRegistry;
  baseMints: BaseMintRegistry;
  /** Spot ETH/USD, for fills whose base asset is not wrapped ETH. */
  nativeUsdPrice: number;
}

/** One transaction's logs, in log-index order, already decoded. */
export interface EvmTxLog {
  logIndex: number;
  event: DecodedEvmEvent;
}

/** A stable 31-bit seed for the pixel avatar, derived from the token address. */
export function seedFromAddress(address: string): number {
  let hash = 2_166_136_261;
  const norm = address.toLowerCase();
  for (let i = 0; i < norm.length; i++) {
    hash ^= norm.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash | 0) % 2_147_483_647;
}

/**
 * Typed reads off a decoded log's `args`.
 *
 * viem's `decodeEventLog` returns a `Record<string, unknown>` for a
 * non-literal ABI, and the shape it produced is only as trustworthy as the
 * ABI it was handed. Naming the field in the failure message means a
 * transcription slip in `evm-events.ts` dead-letters with the field that is
 * wrong, rather than with `undefined`.
 */
type Args = Record<string, unknown>;

function addr(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string')
    throw new Error(`RH log field ${key} is not an address: ${JSON.stringify(value)}`);
  // Keep EIP-55 checksum so joins against auth sessions (`toChecksumAddress`) match.
  try {
    return getAddress(value);
  } catch {
    return value.toLowerCase();
  }
}

function big(args: Args, key: string): bigint {
  const value = args[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.length > 0) return BigInt(value);
  throw new Error(`RH log field ${key} is not a uint: ${JSON.stringify(value)}`);
}

function num(args: Args, key: string): number {
  const value = args[key];
  return typeof value === 'number' ? value : Number(big(args, key));
}

function bool(args: Args, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean')
    throw new Error(`RH log field ${key} is not a bool: ${JSON.stringify(value)}`);
  return value;
}

function text(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string')
    throw new Error(`RH log field ${key} is not a string: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The exact native leg of a routed fill, when the router logged one.
 *
 * A transaction holds at most one atomic trade per token — the router does one
 * curve hop per call — so matching on the token address is sufficient.
 */
function routerNative(logs: readonly EvmTxLog[], token: string): number | null {
  for (const { event } of logs) {
    if (event.name !== 'AtomicBuy' && event.name !== 'AtomicSell') continue;
    if (addr(event.args, 'token') !== token) continue;
    const wei = event.name === 'AtomicBuy' ? big(event.args, 'ethIn') : big(event.args, 'ethOut');
    return toWhole(wei, NATIVE_DECIMALS.RH);
  }
  return null;
}

/** Real wallet behind an atomic router trade (Trade.trader is the router). */
function routerTrader(logs: readonly EvmTxLog[], token: string): string | null {
  for (const { event } of logs) {
    if (event.name !== 'AtomicBuy' && event.name !== 'AtomicSell') continue;
    if (addr(event.args, 'token') !== token) continue;
    return addr(event.args, 'trader');
  }
  return null;
}

export async function mapEvmTransaction(
  logs: readonly EvmTxLog[],
  ctx: EvmMapContext,
): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  const hasFeeAccrued = logs.some((l) => l.event.name === 'FeeAccrued');
  const trade = logs.find((l) => l.event.name === 'Trade')?.event;
  const migrated = logs.find((l) => l.event.name === 'LiquidityMigrated')?.event;

  const net = ctx.net;
  const base = {
    net,
    txSig: ctx.txHash.toLowerCase(),
    chainPosition: ctx.blockNumber,
    blockTimeMs: ctx.blockTimeMs,
  };

  const need = async (token: string): Promise<TokenMeta> => {
    const meta = await ctx.registry.resolve(net, token);
    if (!meta) throw new UnknownMintError(net, token);
    return meta;
  };

  // The log's own index within the block is preserved rather than renumbered
  // from 0: `chain_events` is unique on (net, txSig, logIndex, kind), and the
  // block's own indices are what a block explorer and a re-ingest of the same
  // transaction both agree on.
  for (const { logIndex, event } of logs) {
    const args = event.args;

    switch (event.name) {
      case 'TokenCreated': {
        const token = addr(args, 'token');
        const baseToken = addr(args, 'baseToken');
        const gradMcapBase = big(args, 'gradMcapBase');
        const basePrice1e6 = big(args, 'basePrice1e6');
        const baseDecimals = inferBaseDecimals(gradMcapBase, basePrice1e6);
        if (baseDecimals === null) {
          throw new Error(
            `${net} TokenCreated ${text(args, 'ticker')} (${token}): base decimals are not recoverable from gradMcapBase=${gradMcapBase} basePrice1e6=${basePrice1e6}`,
          );
        }
        const tokenDecimals = TOKEN_DECIMALS[net];
        const supply = big(args, 'supply');
        const tokensForSale = big(args, 'tokensForSale');
        const virtualBase = big(args, 'virtualBase');
        const virtualToken = big(args, 'virtualToken');

        ctx.registry.remember({
          net,
          mint: token,
          sym: text(args, 'ticker'),
          creator: addr(args, 'creator'),
          baseMint: baseToken,
          baseDecimals,
          tokenDecimals,
          basePrice1e6,
          supplyAtoms: supply,
          tokensForSale,
          feeBps: num(args, 'feeBps'),
          circulatingAtoms: 0n,
        });

        out.push({
          ...base,
          kind: 'TokenCreated',
          logIndex,
          mint: token,
          sym: text(args, 'ticker'),
          // See `solana-map.ts`: the event carries the ticker, not the display
          // name — that lives in the off-chain metadata. `/launch/confirm`
          // writes the richer row first for launches made through this stack,
          // and `onTokenCreated` inserts with `onConflictDoNothing`.
          name: text(args, 'ticker'),
          descr: '',
          creator: addr(args, 'creator'),
          baseSymbol: ctx.baseMints.symbolFor(net, baseToken) ?? baseToken.slice(0, 8),
          baseMint: baseToken,
          supply: toWhole(supply, tokenDecimals),
          feeBps: num(args, 'feeBps'),
          cashback: bool(args, 'cashback'),
          seed: seedFromAddress(token),
          mc: marketCapUsd(virtualBase, virtualToken, supply, basePrice1e6, baseDecimals),
          curve: {
            tokenDecimals,
            baseDecimals,
            basePriceUsd1e6: basePrice1e6.toString(),
            tokensForSale: tokensForSale.toString(),
            virtualBase0: virtualBase.toString(),
            virtualToken0: virtualToken.toString(),
            k: (virtualBase * virtualToken).toString(),
            realBase: '0',
            realToken: tokensForSale.toString(),
            gradMcapBase: gradMcapBase.toString(),
          },
        });
        break;
      }

      case 'Trade': {
        const token = addr(args, 'token');
        const meta = await need(token);
        const feeTotal = big(args, 'feeTotal');
        assertOnChainFeeSplit(
          `RH Trade ${ctx.txHash}`,
          feeTotal,
          big(args, 'feeProtocol'),
          big(args, 'feeOps'),
          big(args, 'feeCreatorBucket'),
        );
        const baseAmount = big(args, 'baseAmount');
        const realToken = big(args, 'realToken');
        const usdValue = baseAtomsToUsd(baseAmount, meta.basePrice1e6, meta.baseDecimals);
        const circulating = meta.tokensForSale > realToken ? meta.tokensForSale - realToken : 0n;
        ctx.registry.observeFill(net, token, circulating);

        out.push({
          ...base,
          kind: 'Trade',
          logIndex,
          mint: token,
          sym: meta.sym,
          // Routed fills call the launchpad from StonkzRouter, so Trade.trader
          // is the router. Prefer AtomicBuy/Sell.trader (the wallet).
          trader: routerTrader(logs, token) ?? addr(args, 'trader'),
          side: bool(args, 'isBuy') ? 'buy' : 'sell',
          nativeAmount:
            routerNative(logs, token) ??
            nativeNotional(
              net,
              meta.baseMint,
              baseAmount,
              meta.baseDecimals,
              usdValue,
              ctx.nativeUsdPrice,
            ),
          baseAmount: toWhole(baseAmount, meta.baseDecimals),
          tokenAmount: toWhole(big(args, 'tokenAmount'), meta.tokenDecimals),
          usdValue,
          mc: marketCapUsd(
            big(args, 'virtualBase'),
            big(args, 'virtualToken'),
            meta.supplyAtoms,
            meta.basePrice1e6,
            meta.baseDecimals,
          ),
          cashback: bool(args, 'inCashback'),
          realBase: big(args, 'realBase').toString(),
          realToken: realToken.toString(),
        });
        break;
      }

      case 'FeeAccrued': {
        const token = addr(args, 'token');
        const meta = await need(token);
        const feeTotal = big(args, 'feeTotal');
        assertOnChainFeeSplit(
          `RH FeeAccrued ${ctx.txHash}`,
          feeTotal,
          big(args, 'protocol'),
          big(args, 'ops'),
          big(args, 'creatorBucket'),
        );
        const feeUsd = baseAtomsToUsd(feeTotal, meta.basePrice1e6, meta.baseDecimals);
        out.push({
          ...base,
          kind: 'FeeAccrued',
          logIndex,
          mint: token,
          sym: meta.sym,
          creator: meta.creator,
          ...nativeFeeLegs(
            nativeNotional(
              net,
              meta.baseMint,
              feeTotal,
              meta.baseDecimals,
              feeUsd,
              ctx.nativeUsdPrice,
            ),
            trade ? big(trade.args, 'feeStakers') : 0n,
            big(args, 'creatorBucket'),
          ),
          creatorTokens: toWhole(
            trade ? big(trade.args, 'cashbackTokens') : 0n,
            meta.tokenDecimals,
          ),
        });
        break;
      }

      // The redundant view of the same split `FeeAccrued` already credited —
      // see `solana-map.ts` decision (1). `_credit` on the launchpad emits
      // both together and nowhere else.
      case 'TreasuryCredit':
        if (!hasFeeAccrued) {
          throw new Error(
            `RH TreasuryCredit ${ctx.txHash} has no accompanying FeeAccrued; a standalone credit has no base price to convert with`,
          );
        }
        break;

      case 'Graduated': {
        const token = addr(args, 'token');
        const meta = await need(token);
        out.push({
          ...base,
          kind: 'Graduated',
          logIndex,
          mint: token,
          sym: meta.sym,
          mc: Number(big(args, 'mcapUsd1e6')) / 1e6,
          ...(migrated ? { poolAddress: addr(migrated.args, 'pool') } : {}),
        });
        break;
      }

      case 'CreatorFeesClaimed': {
        const token = addr(args, 'token');
        const meta = await need(token);
        const baseAmount = big(args, 'base');
        const usd = baseAtomsToUsd(baseAmount, meta.basePrice1e6, meta.baseDecimals);
        out.push({
          ...base,
          kind: 'CreatorFeesClaimed',
          logIndex,
          mint: token,
          sym: meta.sym,
          creator: addr(args, 'creator'),
          nativeAmount: nativeNotional(
            net,
            meta.baseMint,
            baseAmount,
            meta.baseDecimals,
            usd,
            ctx.nativeUsdPrice,
          ),
          tokenAmount: toWhole(big(args, 'tokens'), meta.tokenDecimals),
        });
        break;
      }

      case 'Staked': {
        const token = addr(args, 'token');
        const meta = await need(token);
        const amount = big(args, 'amount');
        const weight = big(args, 'weight');
        out.push({
          ...base,
          kind: 'Staked',
          logIndex,
          mint: token,
          sym: meta.sym,
          wallet: addr(args, 'owner'),
          amount: toWhole(amount, meta.tokenDecimals),
          lockDays: num(args, 'lockDays'),
          mult: amount > 0n ? Number(weight) / Number(amount) : 1,
          untilMs: num(args, 'lockUntil') * 1000,
          circulating: toWhole(meta.circulatingAtoms, meta.tokenDecimals),
        });
        break;
      }

      case 'Unstaked': {
        const token = addr(args, 'token');
        const meta = await need(token);
        out.push({
          ...base,
          kind: 'Unstaked',
          logIndex,
          mint: token,
          sym: meta.sym,
          wallet: addr(args, 'owner'),
          amount: toWhole(big(args, 'amount'), meta.tokenDecimals),
        });
        break;
      }

      case 'StakeClaimed': {
        const token = addr(args, 'token');
        const meta = await need(token);
        const baseAmount = big(args, 'base');
        const usd = baseAtomsToUsd(baseAmount, meta.basePrice1e6, meta.baseDecimals);
        out.push({
          ...base,
          kind: 'StakeClaimed',
          logIndex,
          mint: token,
          sym: meta.sym,
          wallet: addr(args, 'owner'),
          rewardNative: nativeNotional(
            net,
            meta.baseMint,
            baseAmount,
            meta.baseDecimals,
            usd,
            ctx.nativeUsdPrice,
          ),
          rewardTokens: toWhole(big(args, 'tokens'), meta.tokenDecimals),
        });
        break;
      }

      // No read table (see `solana-map.ts` decision 2), or — for the router
      // pair — already consumed above as the `Trade`'s exact native leg.
      case 'LiquidityMigrated':
      case 'TreasuryWithdrawn':
      case 'AtomicBuy':
      case 'AtomicSell':
        break;
    }
  }

  return out;
}
