/**
 * Seeds Postgres with launch-day-scale board/token data for the load tests
 * in `loadtest/k6/`.
 *
 * `apps/indexer`'s fixture producer (`apps/indexer/src/fixtures/producer.ts`)
 * is deliberately tiny — "a couple of tokens per net" per `e2e/live.spec.ts`
 * — because its job is exercising the event schema, not board scale. Nothing
 * about the read paths under test here (`GET /tokens`, `/candles`, `/trades`,
 * `/quote`) cares whether a row came from `ChainEvent` replay or a direct
 * insert; they only ever read `tokens` / `candles` / `trades` / `tape` /
 * `holders_snapshot`. This script writes those tables directly, at the
 * volume a launched board actually reaches, without needing on-chain
 * programs or a full event replay to get there.
 *
 * Curve state (`curveVirtualBase0` etc.) is derived with the *real*
 * `@stonkz/curve-sim` (`deriveCurve`/`freshState`) and then advanced with the
 * same constant-product algebra `buyQuote` uses, so `/tokens/:sym/quote` and
 * `/trade/prepare` price these tokens exactly as they would a chain-derived
 * row — this is not a fake shape, it is real curve state that happens to be
 * written directly instead of replayed from `TokenCreated`/`Trade` events.
 *
 * Usage:
 *   DATABASE_URL=postgres://stonkz:stonkz@localhost:5432/stonkz \
 *     tsx loadtest/seed.ts [--tokens-per-net=400] [--wallets-per-net=150]
 *
 * Writes `loadtest/fixtures/manifest.json` — the symbols/nets/wallets the k6
 * scripts read via `open()`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAJORS, STOCKS, nativeUnit, type Net } from '@stonkz/shared';
import { TOKEN_DECIMALS, deriveCurve, freshState, mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import { createDb } from '../src/db/client.js';
import { candles, holdersSnapshot, settings, tape, tokens, trades } from '../src/db/schema.js';
import { ZERO_EVM_ADDRESS } from '../src/env.js';
import { solanaWallet, evmWallet } from './lib/wallets.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function argNum(flag: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!hit) return fallback;
  const n = Number.parseInt(hit.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TOKENS_PER_NET = argNum('tokens-per-net', 400);
const WALLETS_PER_NET = argNum('wallets-per-net', 150);
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://stonkz:stonkz@localhost:5432/stonkz';

const NATIVE_USD: Record<Net, number> = {
  SOL: Number(process.env['STUB_SOL_USD'] ?? 214.08),
  RH: Number(process.env['STUB_ETH_USD'] ?? 4200),
};
const NATIVE_DECIMALS: Record<Net, number> = { SOL: 9, RH: 18, BASE: 18 };
const SUPPLIES = [1_000_000, 500_000_000, 1_000_000_000, 1_000_000_000_000];

let lcg = 0x5eed;
/** Deterministic PRNG so a re-seed of the same size reproduces the same board. */
function rand(): number {
  lcg = (lcg * 1664525 + 1013904223) >>> 0;
  return lcg / 4294967296;
}
function pick<T>(arr: readonly T[]): T {
  const item = arr[Math.floor(rand() * arr.length)];
  if (item === undefined) throw new Error('pick() from an empty array');
  return item;
}
function randInt(min: number, max: number): number {
  return Math.floor(min + rand() * (max - min + 1));
}

interface BaseAsset {
  symbol: string;
  mint: string;
  decimals: number;
  priceUsd: number;
}

/**
 * Solana's launchpad program (and this API's Solana trade-prepare path,
 * `routes/trade.ts`) round-trips every mint through `new PublicKey(...)`, so
 * every SOL-net mint address here — native, major, stock or the launched
 * token itself — has to be a real base58-encoded 32-byte key, even though
 * nothing ever signs for it. Robinhood/EVM has no such constraint: nothing on
 * these code paths checksums an address (only test fixtures do), so a plain
 * random 20-byte hex string is fine.
 */
function fakeMint(net: Net): string {
  return net === 'SOL' ? solanaWallet() : evmWallet();
}

function baseAssetPool(net: Net): BaseAsset[] {
  const native = nativeUnit(net);
  const majors = MAJORS[net].map(([sym]) => sym).filter((sym) => sym !== native);
  const stocks = net === 'SOL' ? STOCKS.map(([sym]) => sym) : [];
  const others = [...majors, ...stocks];
  return others.map((sym) => ({
    symbol: sym,
    mint: fakeMint(net),
    decimals: 6,
    priceUsd: sym.endsWith('x') ? randInt(20, 900) : sym === 'USDC' || sym === 'USDT' ? 1 : randInt(1, 250),
  }));
}

interface SeedToken {
  net: Net;
  sym: string;
  baseSymbol: string;
  isTradeable: boolean; // native-paired: quote/trade never touch Jupiter/Uniswap
}

const manifestWallets: Record<Net, string[]> = { SOL: [], RH: [], BASE: [] };

async function batchInsert<T extends Record<string, unknown>>(
  db: ReturnType<typeof createDb>['db'],
  table: Parameters<typeof db.insert>[0],
  rows: T[],
): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    if (chunk.length === 0) continue;
    await db.insert(table).values(chunk);
  }
}

async function main(): Promise<void> {
  console.log(`seeding ${TOKENS_PER_NET} tokens/net, ${WALLETS_PER_NET} wallets/net -> ${DATABASE_URL}`);
  const { db, close } = createDb({ url: DATABASE_URL, poolMax: 8 });

  const manifest: {
    nets: Record<Net, { tradeableSymbols: string[]; hotSymbols: string[]; allSymbols: string[] }>;
  } = {
    nets: {
      SOL: { tradeableSymbols: [], hotSymbols: [], allSymbols: [] },
      RH: { tradeableSymbols: [], hotSymbols: [], allSymbols: [] },
    },
  };

  for (const net of ['SOL', 'RH', 'BASE'] as const) {
    const native = nativeUnit(net);
    const nativePriceUsd1e6 = BigInt(Math.round(NATIVE_USD[net] * 1e6));
    // The canonical wrapped-native mint (`router/base-mints.ts`), not a
    // one-off per token — matching production, where every native-paired
    // token shares the same base mint.
    const nativeMint = net === 'SOL' ? 'So11111111111111111111111111111111111111112' : ZERO_EVM_ADDRESS;
    const otherBases = baseAssetPool(net);
    const wallets = Array.from({ length: WALLETS_PER_NET }, () => (net === 'SOL' ? solanaWallet() : evmWallet()));

    const tokenRows: (typeof tokens.$inferInsert)[] = [];
    const tradeRows: (typeof trades.$inferInsert)[] = [];
    const tapeRows: (typeof tape.$inferInsert)[] = [];
    const candleAgg = new Map<string, typeof candles.$inferInsert>();
    const holderAgg = new Map<string, typeof holdersSnapshot.$inferInsert>();
    const seedTokens: SeedToken[] = [];

    const nowMs = Date.now();
    let txCounter = 0;
    const nextSig = (): string =>
      net === 'SOL'
        ? `LT${net}${(++txCounter).toString(36).padStart(12, '0')}`.toUpperCase()
        : `0x${(++txCounter).toString(16).padStart(64, '0')}`;

    for (let i = 0; i < TOKENS_PER_NET; i++) {
      // 85% native-paired (what the write-path load tests use — no
      // Jupiter/Uniswap hop); 15% a major/stock base, for board realism only.
      const useNative = rand() < 0.85 || otherBases.length === 0;
      const base: BaseAsset = useNative
        ? { symbol: native, mint: nativeMint, decimals: NATIVE_DECIMALS[net], priceUsd: NATIVE_USD[net] }
        : pick(otherBases);
      const basePrice1e6 = useNative ? nativePriceUsd1e6 : BigInt(Math.round(base.priceUsd * 1e6));

      const supply = pick(SUPPLIES);
      const supplyAtoms = BigInt(supply) * 10n ** BigInt(TOKEN_DECIMALS);
      const params = deriveCurve(supplyAtoms, basePrice1e6, base.decimals);
      if (!params) continue; // Astronomically unlikely with these inputs; skip rather than crash a seed run.
      const fresh = freshState(params);

      // How far along the curve this token has progressed. Most of the board
      // is early; a shrinking tail is close to or past graduation, mirroring
      // an actual launchpad's lane distribution (`lane_idx` on `tokens`).
      const progress = Math.pow(rand(), 2.2); // skew toward 0
      const sold = (params.tokensForSale * BigInt(Math.round(progress * 10_000))) / 10_000n;
      const virtualToken = fresh.virtualToken - sold;
      const virtualBase = virtualToken > 0n ? params.k / virtualToken : params.virtualBase;
      const realToken = params.tokensForSale - sold;
      const realBase = virtualBase > params.virtualBase ? virtualBase - params.virtualBase : 0n;
      const mcBaseAtoms = virtualToken > 0n ? mcapBase({ ...fresh, virtualBase, virtualToken, realBase, realToken }, supplyAtoms) : 0n;
      const mcUsd1e6 = mcapUsd1e6(mcBaseAtoms, basePrice1e6, base.decimals);
      const mcUsd = Number(mcUsd1e6) / 1e6;

      const graduated = mcUsd >= 69_000;
      const lane = graduated ? 'grad' : mcUsd >= 58_650 ? 'soon' : 'new';
      const sym = `LT${net}${i.toString(36).toUpperCase().padStart(3, '0')}`;
      const seed = randInt(1, 2 ** 31 - 1);
      const creator = pick(wallets);
      const launchedAt = new Date(nowMs - randInt(1_000, 3 * 24 * 3_600_000));

      tokenRows.push({
        net,
        sym,
        name: `Loadtest ${sym}`,
        descr: 'Synthetic token generated by loadtest/seed.ts for load testing.',
        creator,
        mint: fakeMint(net),
        baseSymbol: base.symbol,
        baseMint: base.mint,
        supply,
        feeBps: randInt(100, 500),
        cashback: false,
        mc: mcUsd,
        lastMc: mcUsd * (0.9 + rand() * 0.2),
        chg: (rand() - 0.4) * 60,
        holders: 0, // filled in below once trades are generated
        replies: randInt(0, 40),
        lane,
        graduatedAt: graduated ? new Date(nowMs - randInt(0, 12 * 3_600_000)) : null,
        seed,
        launchedAt,
        updatedAt: new Date(),
        tokenDecimals: TOKEN_DECIMALS,
        baseDecimals: base.decimals,
        basePriceUsd1e6: basePrice1e6.toString(),
        curveTokensForSale: params.tokensForSale.toString(),
        curveVirtualBase0: params.virtualBase.toString(),
        curveVirtualToken0: params.virtualToken.toString(),
        curveK: params.k.toString(),
        curveRealBase: (graduated ? 0n : realBase).toString(),
        curveRealToken: (graduated ? 0n : realToken).toString(),
        curveGradMcapBase: params.gradMcapBase.toString(),
      });
      seedTokens.push({ net, sym, baseSymbol: base.symbol, isTradeable: !graduated });

      // ---- historical trades/tape/candles, walking mc from ~10% up to mcUsd
      const nTrades = randInt(8, 60);
      let walkMc = mcUsd * 0.1;
      const step = (mcUsd - walkMc) / nTrades;
      for (let t = 0; t < nTrades; t++) {
        walkMc += step * (0.4 + rand() * 1.2);
        const side: 'buy' | 'sell' = rand() < 0.78 ? 'buy' : 'sell';
        const trader = pick(wallets);
        const nativeAmount = Number((0.01 + rand() * (rand() < 0.05 ? 8 : 1.2)).toFixed(4));
        const usdValue = nativeAmount * NATIVE_USD[net];
        const tokenAmount = Math.max(1, usdValue / Math.max(0.000001, walkMc / supply));
        const blockTime = new Date(launchedAt.getTime() + Math.floor(((t + 1) / nTrades) * (nowMs - launchedAt.getTime())));
        const txSig = nextSig();
        const price = tokenAmount > 0 ? usdValue / tokenAmount : 0;

        tradeRows.push({
          net,
          sym,
          txSig,
          logIndex: 0,
          side,
          trader,
          nativeAmount,
          baseAmount: nativeAmount,
          tokenAmount,
          usdValue,
          mc: walkMc,
          price,
          cashback: false,
          blockTime,
          chainPosition: net === 'SOL' ? 250_000_000 + t : 21_000_000 + t,
        });
        tapeRows.push({
          net,
          sym,
          side,
          trader,
          nativeAmount,
          tokenAmount,
          usdValue,
          mc: walkMc,
          cashback: false,
          txSig,
          logIndex: 0,
          blockTime,
        });

        for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) {
          const size = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[tf];
          const bucket = Math.floor(blockTime.getTime() / size) * size;
          const key = `${net}:${sym}:${tf}:${bucket}`;
          const existing = candleAgg.get(key);
          if (!existing) {
            candleAgg.set(key, {
              net,
              sym,
              tf,
              bucketStart: new Date(bucket),
              o: price,
              h: price,
              l: price,
              c: price,
              v: usdValue,
              nativeVolume: nativeAmount,
              trades: 1,
            });
          } else {
            existing.h = Math.max(existing.h, price);
            existing.l = Math.min(existing.l, price);
            existing.c = price;
            existing.v += usdValue;
            existing.nativeVolume += nativeAmount;
            existing.trades = (existing.trades ?? 0) + 1;
          }
        }

        const holderKey = `${net}:${sym}:${trader}`;
        const holder = holderAgg.get(holderKey) ?? {
          net,
          sym,
          wallet: trader,
          tokenAmount: 0,
          costNative: 0,
          realizedNative: 0,
          firstSeen: blockTime,
          updatedAt: blockTime,
        };
        if (side === 'buy') {
          holder.tokenAmount = (holder.tokenAmount ?? 0) + tokenAmount;
          holder.costNative = (holder.costNative ?? 0) + nativeAmount;
        } else {
          holder.tokenAmount = Math.max(0, (holder.tokenAmount ?? 0) - tokenAmount);
        }
        holder.updatedAt = blockTime;
        holderAgg.set(holderKey, holder);
      }
    }

    // holders count on the token row, matching what the indexer's
    // `updateToken` would have converged to. Computed before the insert below
    // so `tokens` only needs one write pass, not an insert-then-update.
    const holderCounts = new Map<string, number>();
    for (const h of holderAgg.values()) {
      if ((h.tokenAmount ?? 0) <= 0) continue;
      const k = `${h.net}:${h.sym}`;
      holderCounts.set(k, (holderCounts.get(k) ?? 0) + 1);
    }
    for (const row of tokenRows) {
      row.holders = holderCounts.get(`${row.net}:${row.sym}`) ?? 0;
    }

    console.log(`[${net}] inserting ${tokenRows.length} tokens, ${tradeRows.length} trades, ${candleAgg.size} candles...`);
    await batchInsert(db, tokens, tokenRows);
    await batchInsert(db, trades, tradeRows);
    await batchInsert(db, tape, tapeRows);
    await batchInsert(db, candles, [...candleAgg.values()]);
    await batchInsert(db, holdersSnapshot, [...holderAgg.values()]);

    // A JWT is minted per wallet in mint-tokens.ts; save the settings row up
    // front so /trade/prepare's slippage/cap read hits a real row, not the
    // in-memory default, for at least the wallets used to trade.
    const traderWallets = wallets.slice(0, Math.min(wallets.length, 60));
    await batchInsert(
      db,
      settings,
      traderWallets.map((wallet) => ({ net, wallet, slip: 2, prio: 0.0005, mev: 'OFF' as const, mevTip: 0, cap: 50, defBuy: 0.5, confirm: true })),
    );

    const tradeable = seedTokens.filter((t) => t.isTradeable && t.baseSymbol === native);
    manifest.nets[net] = {
      allSymbols: seedTokens.map((t) => t.sym),
      tradeableSymbols: tradeable.map((t) => t.sym),
      // A handful of well-known "hot" tokens for the quote-burst/pump scenario.
      hotSymbols: tradeable.slice(0, 8).map((t) => t.sym),
    };

    console.log(`[${net}] wallet pool: ${wallets.length}, tradeable native-paired tokens: ${tradeable.length}`);
    manifestWallets[net] = wallets;
  }

  mkdirSync(join(HERE, 'fixtures'), { recursive: true });
  writeFileSync(join(HERE, 'fixtures', 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(HERE, 'fixtures', 'wallets.json'), JSON.stringify(manifestWallets, null, 2));
  console.log('wrote loadtest/fixtures/manifest.json and wallets.json');

  await close();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
