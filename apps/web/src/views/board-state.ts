import type { Coin, Net } from '@stonkz/shared';
import { parseNet } from '@stonkz/shared';

/**
 * The board's filter state as pure data — what the SORT and NET chips and the
 * FIND box hold, how it round-trips through the URL, and the comparators the
 * lanes sort with. No DOM here so `board.ts` can stay thin and this file can
 * be unit tested (`board-state.test.ts`).
 */

export type SortKey = 'new' | 'mc' | 'chg' | 'rep';
export type NetFilter = Net | 'ALL';

export const SORT_KEYS: readonly SortKey[] = ['new', 'mc', 'chg', 'rep'];

export interface BoardParams {
  sort: SortKey;
  net: NetFilter;
  q: string;
}

export const DEFAULT_PARAMS: BoardParams = { sort: 'new', net: 'ALL', q: '' };

export function parseSortKey(raw: string | null | undefined): SortKey | null {
  return (SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as SortKey) : null;
}

export function parseNetFilter(raw: string | null | undefined): NetFilter | null {
  const v = (raw ?? '').toUpperCase();
  if (v === 'ALL') return 'ALL';
  return parseNet(v);
}

/**
 * `?sort=mc&net=SOL&q=pepe` -> board state. Unknown or missing values fall
 * back to the defaults so a stale link never breaks the board; `q` is
 * trimmed and capped so a hostile URL cannot stuff the input.
 */
export function parseBoardParams(search: string): BoardParams {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return {
    sort: parseSortKey(sp.get('sort')) ?? DEFAULT_PARAMS.sort,
    net: parseNetFilter(sp.get('net')) ?? DEFAULT_PARAMS.net,
    q: (sp.get('q') ?? '').trim().slice(0, 80),
  };
}

/** Board state -> the query string, defaults omitted so `/` stays `/`. */
export function boardParamsToSearch(p: BoardParams): string {
  const sp = new URLSearchParams();
  if (p.sort !== DEFAULT_PARAMS.sort) sp.set('sort', p.sort);
  if (p.net !== DEFAULT_PARAMS.net) sp.set('net', p.net);
  if (p.q.trim()) sp.set('q', p.q.trim());
  const s = sp.toString();
  return s ? '?' + s : '';
}

/** The nets the NET strip offers: every chain in sim, only deployed ones live. */
export function visibleNets(all: readonly Net[], deployed: (net: Net) => boolean): Net[] {
  return all.filter(deployed);
}

/** A card's sortable fields — `launchedAt` when the API sent it, else the coarse `age`. */
export type Sortable = Pick<Coin, 'mc' | 'chg' | 'reps' | 'age' | 'id'> & {
  launchedAt?: number | undefined;
};

/**
 * NEWEST orders on the launch timestamp the API sends (ms), falling back to
 * `age` (minutes) for sim coins; the two never mix on one board. Every key
 * breaks ties the same way the server does — newer first, then id — so the
 * client order matches `GET /tokens?sort=` and never flickers between polls.
 */
export function compareCoins(sort: SortKey): (a: Sortable, b: Sortable) => number {
  const newer = (a: Sortable, b: Sortable): number => {
    if (a.launchedAt !== undefined && b.launchedAt !== undefined)
      return b.launchedAt - a.launchedAt;
    return a.age - b.age;
  };
  const byId = (a: Sortable, b: Sortable): number => b.id - a.id;
  return (a, b) => {
    const d =
      sort === 'mc'
        ? b.mc - a.mc
        : sort === 'chg'
          ? b.chg - a.chg
          : sort === 'rep'
            ? b.reps - a.reps
            : 0;
    return d || newer(a, b) || byId(a, b);
  };
}

/** What the FIND box matches as you type — the same fields the server search reads. */
export interface Searchable {
  sym: string;
  name: string;
  dev: string;
  mint?: string | undefined;
}

export function matchesQuery(c: Searchable, upperQuery: string): boolean {
  if (!upperQuery) return true;
  if (c.sym.toUpperCase().indexOf(upperQuery) > -1) return true;
  if (c.name.toUpperCase().indexOf(upperQuery) > -1) return true;
  if (c.dev.toUpperCase().indexOf(upperQuery) > -1) return true;
  const mint = (c.mint ?? '').toUpperCase();
  return (
    mint !== '' && (mint === upperQuery || (upperQuery.length >= 6 && mint.startsWith(upperQuery)))
  );
}

/**
 * Rank search hits for Enter: an exact ticker first, then a ticker prefix, a
 * name hit, an address hit; within a tier the bigger cap wins. Stable for
 * equal ranks so the server's order (newest first) breaks the last tie.
 */
export function rankMatches<T extends Searchable & { mc: number }>(
  matches: T[],
  query: string,
): T[] {
  const q = query.trim().toUpperCase();
  const tier = (c: T): number => {
    const sym = c.sym.toUpperCase();
    const mint = (c.mint ?? '').toUpperCase();
    if (sym === q) return 0;
    if (mint !== '' && mint === q) return 1;
    if (sym.startsWith(q)) return 2;
    if (c.name.toUpperCase().includes(q)) return 3;
    if (mint !== '' && mint.startsWith(q)) return 4;
    return 5;
  };
  return matches
    .map((c, i) => ({ c, i, t: tier(c) }))
    .sort((a, b) => a.t - b.t || b.c.mc - a.c.mc || a.i - b.i)
    .map((x) => x.c);
}
