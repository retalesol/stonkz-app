import type { BaseMintRegistry } from '@stonkz/api/router/base-mints';
import type { EvmNet } from '@stonkz/shared';
import { getAddress } from 'viem';
import type { ChainEvent } from '../events.js';
import type { DecodedEvmEvent } from './evm-events.js';
import {
  assertOnChainFeeSplit,
  baseAtomsToUsd,
  inferBaseDecimals,
  isNativeBaseMint,
  marketCapBase,
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
 * The router log that belongs to the `Trade` at `index`: the first
 * `AtomicBuy`/`AtomicSell` for the same token and side *after* it.
 *
 * `StonkzRouter` calls the launchpad (which emits `Trade`) and only then emits
 * its own event, so the pairing is positional. Matching on the token alone —
 * which this used to do — hands every fill in a multi-fill transaction the
 * first router log's ETH leg and wallet.
 */
function routerLogFor(logs: readonly EvmTxLog[], index: number, token: string, isBuy: boolean) {
  const wanted = isBuy ? 'AtomicBuy' : 'AtomicSell';
  for (let i = index + 1; i < logs.length; i++) {
    const event = logs[i]?.event;
    if (!event) continue;
    // The next curve fill starts a new pairing window.
    if (event.name === 'Trade' && addr(event.args, 'token') === token) return null;
    if (event.name !== wanted) continue;
    if (addr(event.args, 'token') !== token) continue;
    return event;
  }
  return null;
}

/**
 * The exact native leg of a routed fill, when the router logged one and the
 * curve's base is *not* already the wrapped native token.
 *
 * For a WETH-based curve the launchpad's own `baseAmount` is the ETH leg to
 * the wei, and it is the better number: `AtomicBuy.ethIn` is `msg.value`,
 * which overstates the spend whenever the curve could not take all of it (the
 * graduation cap) and the router refunded the rest. For any other base the
 * router is the only place the ETH leg is recorded; a partial fill is scaled
 * by the share of the aggregator's output the curve actually consumed.
 */
function routerNative(
  router: NonNullable<ReturnType<typeof routerLogFor>>,
  baseAmount: bigint,
): number {
  if (router.name === 'AtomicSell') return toWhole(big(router.args, 'ethOut'), NATIVE_DECIMALS.RH);
  const ethIn = big(router.args, 'ethIn');
  const delivered = big(router.args, 'baseFromAggregator');
  const wei = delivered > 0n && baseAmount < delivered ? (ethIn * baseAmount) / delivered : ethIn;
  return toWhole(wei, NATIVE_DECIMALS.RH);
}

/**
 * The `Trade` a `FeeAccrued` at `index` belongs to: the nearest earlier
 * `Trade` for the same token. `_emitFill` emits `Trade`, `FeeAccrued`,
 * `TreasuryCredit` back to back, so this is exact even when one transaction
 * carries several fills.
 */
function tradeFor(logs: readonly EvmTxLog[], index: number, token: string) {
  for (let i = index - 1; i >= 0; i--) {
    const event = logs[i]?.event;
    if (event?.name === 'Trade' && addr(event.args, 'token') === token) return event;
  }
  return undefined;
}

/**
 * The `PoolFeesAccrued` that completes a post-graduation `FeeAccrued` at
 * `index`: the next one for the same token, before any further `FeeAccrued`
 * for it. `accrueExternalFees` emits `FeeAccrued`, `TreasuryCredit`,
 * `PoolFeesAccrued` back to back.
 */
function poolFeesFor(logs: readonly EvmTxLog[], index: number, token: string) {
  for (let i = index + 1; i < logs.length; i++) {
    const event = logs[i]?.event;
    if (!event) continue;
    if (event.name === 'FeeAccrued' && addr(event.args, 'token') === token) return undefined;
    if (event.name === 'PoolFeesAccrued' && addr(event.args, 'token') === token) return event;
  }
  return undefined;
}

export async function mapEvmTransaction(
  logs: readonly EvmTxLog[],
  ctx: EvmMapContext,
): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  const hasFeeAccrued = logs.some((l) => l.event.name === 'FeeAccrued');
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
  for (const [index, { logIndex, event }] of logs.entries()) {
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
          // The event carries the ticker, not the display name, description
          // or image. `Ingestor.writeLaunchRows` keeps what `/launch/confirm`
          // wrote, or reads the creator's `/launch/prepare` intent when the
          // indexer gets there first; this placeholder only survives for a
          // launch made outside this stack.
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
          mcBase: marketCapBase(virtualBase, virtualToken, supply, baseDecimals),
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
          big(args, 'feeBurn'),
          big(args, 'feeCreatorBucket'),
        );
        const baseAmount = big(args, 'baseAmount');
        const realToken = big(args, 'realToken');
        const isBuy = bool(args, 'isBuy');
        const usdValue = baseAtomsToUsd(baseAmount, meta.basePrice1e6, meta.baseDecimals);
        const circulating = meta.tokensForSale > realToken ? meta.tokensForSale - realToken : 0n;
        ctx.registry.observeFill(net, token, circulating);
        const router = routerLogFor(logs, index, token, isBuy);
        const nativeBase = isNativeBaseMint(net, meta.baseMint);

        out.push({
          ...base,
          kind: 'Trade',
          logIndex,
          mint: token,
          sym: meta.sym,
          // Routed fills call the launchpad from StonkzRouter, so Trade.trader
          // is the router. Prefer AtomicBuy/Sell.trader (the wallet).
          trader: router ? addr(router.args, 'trader') : addr(args, 'trader'),
          side: isBuy ? 'buy' : 'sell',
          nativeAmount:
            router && !nativeBase
              ? routerNative(router, baseAmount)
              : nativeNotional(
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
          mcBase: marketCapBase(
            big(args, 'virtualBase'),
            big(args, 'virtualToken'),
            meta.supplyAtoms,
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
        const splitVersion = assertOnChainFeeSplit(
          `RH FeeAccrued ${ctx.txHash}`,
          feeTotal,
          big(args, 'protocol'),
          big(args, 'ops'),
          big(args, 'burn'),
          big(args, 'creatorBucket'),
        );
        const feeUsd = baseAtomsToUsd(feeTotal, meta.basePrice1e6, meta.baseDecimals);
        const trade = tradeFor(logs, index, token);
        // No `Trade` means the fee did not come from a curve fill but from
        // the graduated pool's locked position (`accrueExternalFees`), whose
        // token side and staker peel follow on `PoolFeesAccrued`.
        const pool = trade ? undefined : poolFeesFor(logs, index, token);
        // A cashback fill whose bucket was swapped into the token reports its
        // creator/staker peel (`feeCreator` / `feeStakers`) in **tokens**, so
        // neither is a native amount: the native peel is zero and the token
        // slices are carried separately.
        const converted = trade ? big(trade.args, 'cashbackTokens') > 0n : false;
        const stakerAtoms = pool
          ? big(pool.args, 'stakersBase')
          : trade && !converted
            ? big(trade.args, 'feeStakers')
            : 0n;
        const creatorTokenAtoms = pool
          ? big(pool.args, 'tokenAmount') - big(pool.args, 'stakersToken')
          : converted && trade
            ? big(trade.args, 'feeCreator')
            : 0n;
        const stakerTokenAtoms = pool
          ? big(pool.args, 'stakersToken')
          : converted && trade
            ? big(trade.args, 'feeStakers')
            : 0n;
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
            stakerAtoms,
            big(args, 'creatorBucket'),
            splitVersion,
          ),
          creatorTokens: toWhole(creatorTokenAtoms, meta.tokenDecimals),
          stakerTokens: toWhole(stakerTokenAtoms, meta.tokenDecimals),
          ...(pool ? { postGraduation: true } : {}),
        });
        break;
      }

      // Consumed by the `FeeAccrued` just before it (see above).
      case 'PoolFeesAccrued':
        break;

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
          // The program reports the cap at its snapshot price; back out the base figure.
          ...(meta.basePrice1e6 > 0n
            ? { mcBase: Number(big(args, 'mcapUsd1e6')) / Number(meta.basePrice1e6) }
            : {}),
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

      // A standalone `LiquidityMigrated` — the usual EVM shape: `graduate` is
      // permissionless and lands first, `migrateLiquidity` is a second,
      // authority-gated transaction — attaches the pool to the already-
      // graduated row, exactly as `solana-map.ts` decision 2 does. Folded into
      // the `Graduated` above when both share a transaction. `mc: 0` tells the
      // ingestor to keep the cap it already has.
      case 'LiquidityMigrated': {
        if (logs.some((l) => l.event.name === 'Graduated')) break;
        const token = addr(args, 'token');
        const meta = await need(token);
        out.push({
          ...base,
          kind: 'Graduated',
          logIndex,
          mint: token,
          sym: meta.sym,
          mc: 0,
          poolAddress: addr(args, 'pool'),
        });
        break;
      }

      // No read table, or — for the router pair — already consumed above as
      // the `Trade`'s exact native leg.
      case 'TreasuryWithdrawn':
      case 'AtomicBuy':
      case 'AtomicSell':
        break;
    }
  }

  return out;
}
