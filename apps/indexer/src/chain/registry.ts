import { and, eq } from 'drizzle-orm';
import type { Db } from '@stonkz/api/db/client';
import { tokens } from '@stonkz/api/db/schema';
import type { Net } from '@stonkz/shared';
import { TOKEN_DECIMALS } from './market.js';

/**
 * Everything a decoded fill needs that its own event does not carry.
 *
 * On-chain events name a **mint** (Solana) or a **contract address** (EVM).
 * Every read table is keyed on the ticker, and every USD figure needs the
 * base asset's decimals and the oracle price captured at launch. Only
 * `TokenCreated` carries those, so they have to be remembered.
 */
export interface TokenMeta {
  net: Net;
  /** SPL mint / ERC-20 address, lowercased on the EVM. */
  mint: string;
  sym: string;
  /** `FeeAccrued` names the mint, not the creator; the vault row needs both. */
  creator: string;
  baseMint: string;
  baseDecimals: number;
  tokenDecimals: number;
  /** USD per whole base token, 1e6-scaled, as the program recorded it. */
  basePrice1e6: bigint;
  supplyAtoms: bigint;
  tokensForSale: bigint;
  feeBps: number;
  /**
   * Tokens sold off the curve so far, i.e. `tokensForSale - realToken`.
   *
   * Tracked because `Staked` needs it and does not carry it on either chain:
   * `xpForStake` weights the stake against *circulating* supply, and the
   * closest thing the stake events do carry (Solana's `eligible_staked`) is
   * total staked, which would score every staker as if they held the entire
   * float. Refreshed from each fill via {@link TokenRegistry.observeFill}.
   */
  circulatingAtoms: bigint;
}

function max0(v: bigint): bigint {
  return v > 0n ? v : 0n;
}

export function mintKey(net: Net, mint: string): string {
  return `${net}:${net === 'RH' ? mint.toLowerCase() : mint}`;
}

/**
 * Mint → ticker and curve constants, cached in memory and backed by `tokens`.
 *
 * The cache is not a performance nicety: a fill decoded from slot N needs the
 * launch that happened at slot M ≤ N, which may be in the same batch (learned
 * via {@link remember}), in an earlier batch (read back from `tokens`), or —
 * if the launch predates this indexer's `startPosition` — nowhere at all.
 * {@link resolve} returns `null` for that last case so the caller can
 * dead-letter the fill with a clear reason instead of materialising a row
 * under a made-up ticker.
 */
export class TokenRegistry {
  private readonly cache = new Map<string, TokenMeta>();

  constructor(private readonly db: Db) {}

  /** Learns a launch, so later events in the same batch can resolve it. */
  remember(meta: TokenMeta): void {
    this.cache.set(mintKey(meta.net, meta.mint), meta);
  }

  /**
   * Records the circulating supply a fill left behind, so a `Staked` later in
   * the same batch weights against the float as of that moment rather than as
   * of the last batch.
   */
  observeFill(net: Net, mint: string, circulatingAtoms: bigint): void {
    const key = mintKey(net, mint);
    const hit = this.cache.get(key);
    if (hit) this.cache.set(key, { ...hit, circulatingAtoms });
  }

  async resolve(net: Net, mint: string): Promise<TokenMeta | null> {
    const key = mintKey(net, mint);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const normalised = net === 'RH' ? mint.toLowerCase() : mint;
    const [row] = await this.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.mint, normalised)))
      .limit(1);
    if (!row) return null;
    // A row seeded before curve columns existed (or by the fixture producer)
    // has `'0'` in every curve column; it cannot price a fill, so treat it as
    // unresolved rather than dividing by zero.
    if (row.basePriceUsd1e6 === '0') return null;

    const tokensForSale = BigInt(row.curveTokensForSale);
    const meta: TokenMeta = {
      net,
      mint: normalised,
      sym: row.sym,
      creator: row.creator,
      baseMint: row.baseMint,
      baseDecimals: row.baseDecimals,
      tokenDecimals: row.tokenDecimals || TOKEN_DECIMALS[net],
      basePrice1e6: BigInt(row.basePriceUsd1e6),
      supplyAtoms: BigInt(Math.round(row.supply * 10 ** (row.tokenDecimals || TOKEN_DECIMALS[net]))),
      tokensForSale,
      feeBps: row.feeBps,
      circulatingAtoms: max0(tokensForSale - BigInt(row.curveRealToken)),
    };
    this.cache.set(key, meta);
    return meta;
  }

  /** Drops cached entries for a net — used after a reorg rollback removed launches. */
  forget(net: Net): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${net}:`)) this.cache.delete(key);
    }
  }

  get size(): number {
    return this.cache.size;
  }
}

export class UnknownMintError extends Error {
  constructor(
    readonly net: Net,
    readonly mint: string,
  ) {
    super(
      `${net} mint ${mint} has no TokenCreated on record — it launched before this indexer's start position, or a launch was dropped`,
    );
    this.name = 'UnknownMintError';
  }
}
