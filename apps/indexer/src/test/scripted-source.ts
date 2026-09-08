import type { Net } from '@stonkz/shared';
import { compareEvents, type ChainEvent } from '../events.js';
import type { EventSource, PollResult } from '../source.js';

/**
 * A fully-featured `EventSource` under test control.
 *
 * `FixtureEventSource` deliberately implements only the four required methods,
 * because that is what a fixture replay can honestly answer. The durability
 * tests need the optional four as well — a confirmation-gated head, a block
 * identity that can be *changed* to simulate a reorg, a `pollRange` that can
 * cover less than it was asked, and a bookmark — plus the ability to fail on
 * demand, which is the only way to test the dead-letter path.
 */
export interface ScriptedSourceOptions {
  net: Net;
  events?: readonly ChainEvent[];
  head?: number;
  startPosition?: number;
  confirmations?: number;
  /** Position → block hash. A position with no entry answers `null`, like a skipped slot. */
  hashes?: Map<number, string>;
  /** Caps how much of a requested range one pass covers, as Solana's paging does. */
  coverLimit?: number;
}

export class ScriptedSource implements EventSource {
  readonly net: Net;
  /** Every `pollRange` call, for asserting the cursor window arithmetic. */
  readonly polls: { from: number; to: number }[] = [];
  /** Set to make the next poll throw. Cleared by `clearFailure()`. */
  failure: Error | null = null;
  /** How many polls to fail before recovering. `Infinity` never recovers. */
  failuresRemaining = Number.POSITIVE_INFINITY;
  bookmark: string | null = null;
  restored: (string | null)[] = [];

  private events: ChainEvent[];
  private headPosition: number;
  private readonly confirmations: number;
  private readonly hashes: Map<number, string>;
  private readonly start: number;
  private readonly coverLimit: number;

  constructor(opts: ScriptedSourceOptions) {
    this.net = opts.net;
    this.events = [...(opts.events ?? [])].filter((e) => e.net === opts.net).sort(compareEvents);
    this.headPosition = opts.head ?? this.events.at(-1)?.chainPosition ?? 0;
    this.confirmations = opts.confirmations ?? 0;
    this.hashes = opts.hashes ?? new Map();
    this.start = opts.startPosition ?? this.events[0]?.chainPosition ?? 1;
    this.coverLimit = opts.coverLimit ?? Number.POSITIVE_INFINITY;
  }

  setEvents(events: readonly ChainEvent[]): void {
    this.events = [...events].filter((e) => e.net === this.net).sort(compareEvents);
  }

  setHead(position: number): void {
    this.headPosition = position;
  }

  /** Rewrites the hash at a position — what a reorg looks like from the outside. */
  setHash(position: number, hash: string | null): void {
    if (hash === null) this.hashes.delete(position);
    else this.hashes.set(position, hash);
  }

  /** Drops every event at or after `position`, as a reorg would. */
  orphanFrom(position: number): void {
    this.events = this.events.filter((e) => e.chainPosition < position);
  }

  failFor(count: number, error: Error): void {
    this.failure = error;
    this.failuresRemaining = count;
  }

  clearFailure(): void {
    this.failure = null;
    this.failuresRemaining = Number.POSITIVE_INFINITY;
  }

  async head(): Promise<number> {
    return this.headPosition;
  }

  async confirmedHead(): Promise<number> {
    return Math.max(0, this.headPosition - this.confirmations);
  }

  async startPosition(): Promise<number> {
    return this.start;
  }

  async blockIdentity(position: number): Promise<string | null> {
    return this.hashes.get(position) ?? null;
  }

  restoreBookmark(bookmark: string | null): void {
    this.restored.push(bookmark);
    this.bookmark = bookmark;
  }

  async poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]> {
    return (await this.pollRange(fromExclusive, toInclusive)).events;
  }

  async pollRange(fromExclusive: number, toInclusive: number): Promise<PollResult> {
    this.polls.push({ from: fromExclusive, to: toInclusive });

    if (this.failure && this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      const err = this.failure;
      if (this.failuresRemaining <= 0) this.clearFailure();
      throw err;
    }

    const coveredTo = Math.min(toInclusive, fromExclusive + this.coverLimit);
    const events = this.events.filter(
      (e) => e.chainPosition > fromExclusive && e.chainPosition <= coveredTo,
    );
    const last = events.at(-1);
    return {
      events,
      coveredTo,
      bookmark: last ? `${last.txSig}` : this.bookmark,
    };
  }
}
