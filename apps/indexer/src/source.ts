import type { Net } from '@stonkz/shared';
import { compareEvents, type ChainEvent } from './events.js';

/**
 * Where events come from.
 *
 * The on-chain programs do not exist yet (Phase 2), so the worker takes its
 * event source as an interface. `FixtureEventSource` is what runs today and in
 * the tests; the Solana log subscriber and the EVM `eth_getLogs` poller will
 * implement the same two methods and nothing downstream will change.
 */
export interface EventSource {
  readonly net: Net;
  /** Chain head — slot on Solana, block number on the EVM. */
  head(): Promise<number>;
  /** Every event in `(fromExclusive, toInclusive]`, in chain order. */
  poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]>;
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

  async poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]> {
    return this.events.filter((e) => e.chainPosition > fromExclusive && e.chainPosition <= toInclusive);
  }
}
