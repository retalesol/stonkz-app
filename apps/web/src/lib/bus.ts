import type { AchievementKey, Fill } from '@stonkz/shared';

/**
 * A tiny typed event bus.
 *
 * State modules stay DOM-free by announcing what changed instead of reaching
 * into views. It is also the shape the Phase 1 WS client plugs into: `board`,
 * `token:{sym}` and `user:{addr}` frames will emit the same events, so the
 * renderers do not care whether a number moved because of `tick()` or because
 * the indexer said so.
 */
export interface BusEvents {
  /** XP was awarded. `gained` drives the header pulse. */
  xp: { amount: number; reason?: string | undefined; gained: boolean };
  /** Rank/XP/streak/balances changed — repaint the header widget and strip. */
  rank: void;
  /** An achievement unlocked. */
  achievement: { key: AchievementKey };
  /** Wallet connected, disconnected, or its balance moved. */
  wallet: void;
  /** The coin set changed shape (new mint, lane move) rather than just prices. */
  coins: void;
  /** A coin crossed a lane boundary. Carries the ticker, not the object. */
  lane: { sym: string; lane: 'new' | 'soon' | 'grad' };
  /** A coin was minted. */
  mint: { sym: string };
  /** Holdings or activity changed; the profile view repaints. */
  portfolio: void;
  /** One simulated/indexed beat completed. */
  tick: void;
  /**
   * A confirmed fill for the ticker tape — a real `board`/`tape` WS print in
   * live mode. `animate: false` is the initial seed batch on boot; `true` is
   * every fill after that. `plan step 65`
   */
  fill: { fill: Fill; animate: boolean };
  /** Board scope changed — wipe the strip before a fresh `GET /tape` seed. */
  tapeClear: void;
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

const handlers = new Map<keyof BusEvents, Set<(p: never) => void>>();

export function on<K extends keyof BusEvents>(event: K, fn: Handler<K>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(fn as (p: never) => void);
  return () => {
    set?.delete(fn as (p: never) => void);
  };
}

export function emit<K extends keyof BusEvents>(event: K, ...payload: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const fn of [...set]) (fn as Handler<K>)(payload[0] as BusEvents[K]);
}
