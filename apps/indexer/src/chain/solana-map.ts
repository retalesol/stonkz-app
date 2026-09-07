import type { BaseMintRegistry } from '@stonkz/api/router/base-mints';
import type { ChainEvent } from '../events.js';
import {
  assertOnChainFeeSplit,
  baseAtomsToUsd,
  inferBaseDecimals,
  marketCapUsd,
  nativeFeeLegs,
  nativeNotional,
  toWhole,
  TOKEN_DECIMALS,
} from './market.js';
import { TokenRegistry, UnknownMintError, type TokenMeta } from './registry.js';
import type { SolanaLaunchpadEvent } from './solana-events.js';

/**
 * Decoded Anchor events → the indexer's `ChainEvent` contract.
 *
 * A launchpad transaction emits several events at once (`emit_fill` emits
 * `Trade`, `FeeAccrued` and `TreasuryCredit` together), and some indexer
 * events need fields spread across that group. So mapping is per-transaction,
 * not per-event.
 *
 * Three deliberate translation decisions, all of which are behaviour an
 * operator needs to know about:
 *
 * 1. **`TreasuryCredit` is dropped when the same transaction carries a
 *    `FeeAccrued`.** On-chain they are two views of one split — `emit_fill`
 *    emits both so the split can be reconciled — and `Ingestor` credits the
 *    protocol/ops vaults from `FeeAccrued` already. Materialising both would
 *    double-credit both treasuries. A standalone `TreasuryCredit` (a
 *    reconciliation, not a fill) is still materialised.
 * 2. **`LiquidityMigrated` and `TreasuryWithdrawn` produce no indexer event.**
 *    Neither has a read table. `LiquidityMigrated.pool` is folded into a
 *    `Graduated` in the same transaction when there is one.
 * 3. **No `CashbackWindow` event is ever produced.** The programs do not emit
 *    one; the window is `cb_start` plus `CB_WINDOW_SECS`, which is what
 *    `tokens.cbStartMs` and `@stonkz/shared`'s `effFee()` already compute.
 *    The window closing is the passage of time, not a chain event.
 */
export interface SolanaMapContext {
  txSig: string;
  slot: number;
  blockTimeMs: number;
  registry: TokenRegistry;
  baseMints: BaseMintRegistry;
  /** Spot SOL/USD, for fills whose base asset is not wrapped SOL. */
  nativeUsdPrice: number;
}

/** A stable 31-bit seed for the pixel avatar, derived from the mint. */
export function seedFromMint(mint: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < mint.length; i++) {
    hash ^= mint.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash | 0) % 2_147_483_647;
}

function baseSymbolFor(baseMints: BaseMintRegistry, baseMint: string): string {
  return baseMints.symbolFor('SOL', baseMint) ?? baseMint.slice(0, 6);
}

export async function mapSolanaTransaction(
  records: readonly SolanaLaunchpadEvent[],
  ctx: SolanaMapContext,
): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  const hasFeeAccrued = records.some((r) => r.kind === 'FeeAccrued');
  const trade = records.find((r): r is Extract<SolanaLaunchpadEvent, { kind: 'Trade' }> => r.kind === 'Trade');
  const migrated = records.find(
    (r): r is Extract<SolanaLaunchpadEvent, { kind: 'LiquidityMigrated' }> => r.kind === 'LiquidityMigrated',
  );

  const base = { net: 'SOL' as const, txSig: ctx.txSig, chainPosition: ctx.slot, blockTimeMs: ctx.blockTimeMs };
  let logIndex = 0;

  const need = async (mint: string): Promise<TokenMeta> => {
    const meta = await ctx.registry.resolve('SOL', mint);
    if (!meta) throw new UnknownMintError('SOL', mint);
    return meta;
  };

  for (const record of records) {
    switch (record.kind) {
      case 'TokenCreated': {
        const baseDecimals = inferBaseDecimals(record.gradMcapBase, record.basePrice1e6);
        if (baseDecimals === null) {
          throw new Error(
            `SOL TokenCreated ${record.ticker} (${record.mint}): base decimals are not recoverable from gradMcapBase=${record.gradMcapBase} basePrice1e6=${record.basePrice1e6}`,
          );
        }
        const tokenDecimals = TOKEN_DECIMALS.SOL;
        const meta: TokenMeta = {
          net: 'SOL',
          mint: record.mint,
          sym: record.ticker,
          creator: record.creator,
          baseMint: record.baseMint,
          baseDecimals,
          tokenDecimals,
          basePrice1e6: record.basePrice1e6,
          supplyAtoms: record.supply,
          tokensForSale: record.tokensForSale,
          feeBps: record.feeBps,
        };
        ctx.registry.remember(meta);

        out.push({
          ...base,
          kind: 'TokenCreated',
          logIndex: logIndex++,
          mint: record.mint,
          sym: record.ticker,
          // The program's `TokenCreated` carries the ticker but not the
          // display name or description — those live in the off-chain
          // metadata `uri`. `/launch/confirm` writes the richer row first for
          // any launch made through this stack, and `onTokenCreated` inserts
          // with `onConflictDoNothing`, so this only shows up for a launch
          // made outside it.
          name: record.ticker,
          descr: '',
          creator: record.creator,
          baseSymbol: baseSymbolFor(ctx.baseMints, record.baseMint),
          baseMint: record.baseMint,
          supply: toWhole(record.supply, tokenDecimals),
          feeBps: record.feeBps,
          cashback: record.cashback,
          seed: seedFromMint(record.mint),
          mc: marketCapUsd(
            record.virtualBase,
            record.virtualToken,
            record.supply,
            record.basePrice1e6,
            baseDecimals,
          ),
          curve: {
            tokenDecimals,
            baseDecimals,
            basePriceUsd1e6: record.basePrice1e6.toString(),
            tokensForSale: record.tokensForSale.toString(),
            virtualBase0: record.virtualBase.toString(),
            virtualToken0: record.virtualToken.toString(),
            k: (record.virtualBase * record.virtualToken).toString(),
            realBase: '0',
            realToken: record.tokensForSale.toString(),
            gradMcapBase: record.gradMcapBase.toString(),
          },
        });
        break;
      }

      case 'Trade': {
        const meta = await need(record.mint);
        assertOnChainFeeSplit(
          `SOL Trade ${ctx.txSig}`,
          record.feeTotal,
          record.feeProtocol,
          record.feeOps,
          record.feeCreatorBucket,
        );
        const usdValue = baseAtomsToUsd(record.baseAmount, meta.basePrice1e6, meta.baseDecimals);
        out.push({
          ...base,
          kind: 'Trade',
          logIndex: logIndex++,
          sym: meta.sym,
          trader: record.trader,
          side: record.isBuy ? 'buy' : 'sell',
          nativeAmount: nativeNotional(
            'SOL',
            meta.baseMint,
            record.baseAmount,
            meta.baseDecimals,
            usdValue,
            ctx.nativeUsdPrice,
          ),
          baseAmount: toWhole(record.baseAmount, meta.baseDecimals),
          tokenAmount: toWhole(record.tokenAmount, meta.tokenDecimals),
          usdValue,
          mc: marketCapUsd(
            record.virtualBase,
            record.virtualToken,
            meta.supplyAtoms,
            meta.basePrice1e6,
            meta.baseDecimals,
          ),
          cashback: record.inCashback,
          realBase: record.realBase.toString(),
          realToken: record.realToken.toString(),
        });
        break;
      }

      case 'FeeAccrued': {
        const meta = await need(record.mint);
        assertOnChainFeeSplit(
          `SOL FeeAccrued ${ctx.txSig}`,
          record.feeTotal,
          record.protocol,
          record.ops,
          record.creatorBucket,
        );
        const feeUsd = baseAtomsToUsd(record.feeTotal, meta.basePrice1e6, meta.baseDecimals);
        const feeNative = nativeNotional(
          'SOL',
          meta.baseMint,
          record.feeTotal,
          meta.baseDecimals,
          feeUsd,
          ctx.nativeUsdPrice,
        );
        out.push({
          ...base,
          kind: 'FeeAccrued',
          logIndex: logIndex++,
          sym: meta.sym,
          // `FeeAccrued` names the mint, not the creator; the creator comes
          // from the launch, which is the same place the vault row does.
          creator: meta.creator,
          ...nativeFeeLegs(feeNative, trade?.feeStakers ?? 0n, record.creatorBucket),
          creatorTokens: toWhole(trade?.cashbackTokens ?? 0n, meta.tokenDecimals),
        });
        break;
      }

      // See decision (1). The launchpad emits `TreasuryCredit` only from
      // `emit_fill`, i.e. only ever beside a `FeeAccrued` describing the same
      // two legs, so it is always the redundant view and always dropped. If a
      // future instruction emits a standalone one, `hasFeeAccrued` is false
      // for it and this becomes a real gap the assertion below reports.
      case 'TreasuryCredit':
        if (!hasFeeAccrued) {
          throw new Error(
            `SOL TreasuryCredit ${ctx.txSig} has no accompanying FeeAccrued; a standalone credit has no base price to convert with`,
          );
        }
        break;

      case 'Graduated': {
        const meta = await need(record.mint);
        out.push({
          ...base,
          kind: 'Graduated',
          logIndex: logIndex++,
          sym: meta.sym,
          mc: Number(record.mcapUsd1e6) / 1e6,
          ...(migrated ? { poolAddress: migrated.pool } : {}),
        });
        break;
      }

      case 'CreatorFeesClaimed': {
        const meta = await need(record.mint);
        const usd = baseAtomsToUsd(record.baseAmount, meta.basePrice1e6, meta.baseDecimals);
        out.push({
          ...base,
          kind: 'CreatorFeesClaimed',
          logIndex: logIndex++,
          sym: meta.sym,
          creator: record.creator,
          nativeAmount: nativeNotional(
            'SOL',
            meta.baseMint,
            record.baseAmount,
            meta.baseDecimals,
            usd,
            ctx.nativeUsdPrice,
          ),
          tokenAmount: toWhole(record.tokenAmount, meta.tokenDecimals),
        });
        break;
      }

      case 'Staked': {
        const meta = await need(record.mint);
        out.push({
          ...base,
          kind: 'Staked',
          logIndex: logIndex++,
          sym: meta.sym,
          wallet: record.owner,
          amount: toWhole(record.amount, meta.tokenDecimals),
          lockDays: record.lockDays,
          // `weight` is `amount * LOCK_WEIGHT_BPS / BPS_DEN`, so the ratio is
          // the lock multiplier the read tables display.
          mult: record.amount > 0n ? Number(record.weight) / Number(record.amount) : 1,
          untilMs: Number(record.lockUntil) * 1000,
          circulating: toWhole(record.eligibleStaked, meta.tokenDecimals),
        });
        break;
      }

      case 'Unstaked': {
        const meta = await need(record.mint);
        out.push({
          ...base,
          kind: 'Unstaked',
          logIndex: logIndex++,
          sym: meta.sym,
          wallet: record.owner,
          amount: toWhole(record.amount, meta.tokenDecimals),
        });
        break;
      }

      case 'StakeClaimed': {
        const meta = await need(record.mint);
        const usd = baseAtomsToUsd(record.baseAmount, meta.basePrice1e6, meta.baseDecimals);
        out.push({
          ...base,
          kind: 'StakeClaimed',
          logIndex: logIndex++,
          sym: meta.sym,
          wallet: record.owner,
          rewardNative: nativeNotional(
            'SOL',
            meta.baseMint,
            record.baseAmount,
            meta.baseDecimals,
            usd,
            ctx.nativeUsdPrice,
          ),
          rewardTokens: toWhole(record.tokenAmount, meta.tokenDecimals),
        });
        break;
      }

      // See decision (2): no read table, nothing to materialise.
      case 'LiquidityMigrated':
      case 'TreasuryWithdrawn':
        break;
    }
  }

  return out;
}
