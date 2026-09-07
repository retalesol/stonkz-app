import type { CrateTier, Fill, Net, Quote, SupplyOption, Wallet } from '@stonkz/shared';
import type { SimCoin } from '../state/coins.js';

/**
 * The adapter seam.
 *
 * Everything that will eventually cross the network goes through this
 * interface. `sim.ts` implements it against the in-memory model; `live.ts` is
 * the Phase 1+ implementation against the API, WS and the wallet adapters.
 * Views may read state directly — both adapters keep the same state modules
 * populated — but they may only *mutate* through here.
 *
 * @see plan steps 20 and 30
 */

export interface QuoteInput {
  coin: SimCoin;
  side: 'buy' | 'sell';
  /** Always in the chain's native unit: SOL on Solana, ETH on Robinhood. */
  amountIn: number;
}

export interface LaunchDraft {
  sym: string;
  name: string;
  desc: string;
  supply: SupplyOption | number;
  /** Curve fee, percent, 1.0-5.0. */
  tfee: number;
  /** Dev buy, in the base mint. */
  buy: number;
  base: string;
  cashback: boolean;
  x?: string;
  web?: string;
  tg?: string;
}

export interface ClaimResult {
  /** Native claimed, SOL or ETH. */
  native: number;
  /** Token allocations credited from cashback windows: sym -> amount. */
  tokens: Record<string, number>;
}

export interface StakeInput {
  sym: string;
  amount: number;
  /** Lock length in days. 0 = flex. */
  days: number;
  mult: number;
}

export interface StakeClaim {
  tokens: number;
  native: number;
}

export interface CrateResult {
  tier: CrateTier;
  /** `S` = Stonk Optionz, `I` = item. */
  kind: 'S' | 'I';
  /** Optionz credited, when `kind` is `S`. */
  amount: number;
  /** Item label, when `kind` is `I`. */
  item: string;
  /** Rendered reward label for the drop log. */
  label: string;
  /** Index into the tier's drop table, which is also its `RAR` rarity. */
  dropIndex: number;
  xp: number;
}

export interface StonkzApi {
  readonly mode: 'sim' | 'live';

  /** Hydrate the board, portfolio and rewards. Resolves before first paint. */
  ready(): Promise<void>;

  /** Start / stop the price stream. Sim = `setInterval`; live = the `board` WS. */
  startStream(): void;
  stopStream(): void;

  quote(input: QuoteInput): Promise<Quote>;
  trade(quote: Quote): Promise<Fill>;

  connect(net: Net): Promise<Wallet>;
  disconnect(): void;

  launch(draft: LaunchDraft): Promise<SimCoin>;
  claimCreatorFees(sym?: string): Promise<ClaimResult>;

  stake(input: StakeInput): Promise<void>;
  unstake(sym: string): Promise<number>;
  claimStake(sym: string): Promise<StakeClaim>;

  openCrate(tier: CrateTier): Promise<CrateResult>;
}
