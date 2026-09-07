import type { Net } from '@stonkz/shared';
import { compareEvents, type ChainEvent } from './events.js';

/**
 * Where events come from.
 *
 * `FixtureEventSource` replays a static scenario and is what the tests and
 * local dev run on; `chain/solana-source.ts` and `chain/evm-source.ts` are the
 * real ones. Everything past this interface — ingest, the cursors, the read
 * tables — is identical either way.
 *
 * The four original methods are still required and unchanged. Everything a
 * real chain needs but a fixture cannot answer (a confirmation-gated head, the
 * identity of a block, a resume bookmark, a partially-covered range) is an
 * **optional** method, so `FixtureEventSource` keeps working untouched and the
 * runner degrades to the old behaviour for any source that does not implement
 * them.
 */
export interface EventSource {
  readonly net: Net;
  /** Chain head — slot on Solana, block number on the EVM. */
  head(): Promise<number>;
  /**
   * The earliest position worth indexing: the slot or block the programs were
   * deployed at. A fresh cursor jumps here instead of crawling from zero —
   * Solana is 250M slots in, so starting at genesis is not a slow start, it is
   * an infinite one.
   */
  startPosition(): Promise<number>;
  /** Every event in `(fromExclusive, toInclusive]`, in chain order. */
  poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]>;

  /**
   * The highest position it is safe to materialise, i.e. the head minus this
   * chain's confirmation depth. Absent means "the raw head is safe", which is
   * true for a fixture replay and for nothing else.
   */
  confirmedHead?(): Promise<number>;

  /**
   * A stable identifier for the block/slot at `position` — the EVM block hash,
   * or Solana's blockhash. `null` when the source cannot answer (the position
   * is empty, pruned, or hash tracking is switched off). This is the only
   * input to reorg detection: if the chain's answer today differs from what
   * was recorded when the cursor last sat there, history moved.
   */
  blockIdentity?(position: number): Promise<string | null>;

  /**
   * `poll`, but able to say it covered less of the range than it was asked
   * for, and to hand back a resume hint. Solana needs both: signature paging
   * is bounded per pass, and `getSignaturesForAddress` resumes by signature
   * rather than by slot.
   */
  pollRange?(fromExclusive: number, toInclusive: number): Promise<PollResult>;

  /** Restores the resume hint persisted with the cursor, on boot or after a rewind. */
  restoreBookmark?(bookmark: string | null): void;
}

export interface PollResult {
  events: ChainEvent[];
  /**
   * Highest position fully scanned. The cursor must not advance past this even
   * if `toInclusive` was higher — a bounded pass that stopped early has not
   * seen the rest of the range.
   */
  coveredTo: number;
  /** Source-specific resume hint to persist alongside the cursor. */
  bookmark?: string | null;
}

/** Normalises a source to the `pollRange` shape, whether or not it implements it. */
export async function pollSource(
  source: EventSource,
  fromExclusive: number,
  toInclusive: number,
): Promise<PollResult> {
  if (source.pollRange) return source.pollRange(fromExclusive, toInclusive);
  return { events: await source.poll(fromExclusive, toInclusive), coveredTo: toInclusive };
}

/**
 * The confirmation-gated head, falling back to the raw head for a source that
 * does not gate (fixtures).
 */
export async function confirmedHeadOf(source: EventSource): Promise<number> {
  return source.confirmedHead ? source.confirmedHead() : source.head();
}

/** Replays a fixed event list, gated by the cursor window. */
export class FixtureEventSource implements EventSource {
  private readonly events: ChainEvent[];

  constructor(
    readonly net: Net,
    events: readonly ChainEvent[],
  ) {
    this.events = events.filter((e) => e.net === net).sort(compareEvents);
  }

  async head(): Promise<number> {
    return this.events.at(-1)?.chainPosition ?? 0;
  }

  async startPosition(): Promise<number> {
    return this.events[0]?.chainPosition ?? 0;
  }

  async poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]> {
    return this.events.filter((e) => e.chainPosition > fromExclusive && e.chainPosition <= toInclusive);
  }
}
