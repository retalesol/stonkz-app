import { sigKey } from '../api/live-fills.js';

/**
 * Which prints the ticker tape has already shown.
 *
 * One fill can reach the strip several times: the `GET /tape` seed on boot,
 * the same seed again after a socket reconnect, `/trade/confirm`'s
 * provisional WS print and the indexer's authoritative twin, and a poll or
 * frame that races the seed. Every one of those carries the fill's `fid`
 * (`${sig}:${ordinal}`, the id `live-fills.ts`'s `FillLedger` keys the trades
 * tab on), so the tape prints a fill the first time it sees that id and
 * ignores every restatement.
 *
 * The transaction hash is the fallback for a print that has no `fid` (a
 * frame from before ids existed, or a sim print with only a `sig`), and a
 * bridge between the two forms: a fid print of a transaction that already
 * printed without an id is the same fill re-stated, not a second one.
 *
 * Bounded: the strip keeps ~60 prints, so remembering a few hundred ids is
 * plenty and the set can never grow with the session. DOM-free so it can be
 * unit tested (`tape-ledger.test.ts`).
 */

export interface TapeKey {
  fid?: string | undefined;
  sig?: string | undefined;
}

/** How many ids the ledger remembers before it forgets the oldest. */
export const TAPE_LEDGER_CAP = 600;

/** The fill's position in its transaction, from a `${sig}:${ordinal}` id. */
export function fidOrdinal(fid: string): number {
  const i = fid.lastIndexOf(':');
  if (i < 0) return 0;
  const n = Number.parseInt(fid.slice(i + 1), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** The transaction a fill id belongs to — the part before the ordinal. */
export function fidSig(fid: string): string {
  const i = fid.lastIndexOf(':');
  return i < 0 ? fid : fid.slice(0, i);
}

export class TapeLedger {
  /** Insertion-ordered so eviction drops the oldest first. `true` = printed with a fid. */
  private readonly fids = new Map<string, true>();
  /** Transactions printed so far; the value says whether the print carried a fid. */
  private readonly sigs = new Map<string, 'fid' | 'anon'>();

  constructor(private readonly cap = TAPE_LEDGER_CAP) {}

  /** `true` when this print is new to the strip and should be shown. */
  admit(f: TapeKey): boolean {
    const sig = f.sig ? sigKey(f.sig) : f.fid ? sigKey(fidSig(f.fid)) : null;
    if (f.fid) {
      if (this.fids.has(f.fid)) return false;
      // The first fill of a transaction that already printed without an id
      // is that same print, now identified; later fills of it are new.
      if (sig && this.sigs.get(sig) === 'anon' && fidOrdinal(f.fid) === 0) {
        this.fids.set(f.fid, true);
        this.sigs.set(sig, 'fid');
        this.trim();
        return false;
      }
      this.fids.set(f.fid, true);
      if (sig) this.sigs.set(sig, 'fid');
      this.trim();
      return true;
    }
    if (!sig) return true; // Nothing to key on: an invented sim print.
    if (this.sigs.has(sig)) return false;
    this.sigs.set(sig, 'anon');
    this.trim();
    return true;
  }

  /** Ids remembered right now — for tests and the memory bound. */
  get size(): number {
    return this.fids.size + this.sigs.size;
  }

  clear(): void {
    this.fids.clear();
    this.sigs.clear();
  }

  private trim(): void {
    while (this.fids.size > this.cap) {
      const oldest = this.fids.keys().next().value;
      if (oldest === undefined) break;
      this.fids.delete(oldest);
    }
    while (this.sigs.size > this.cap) {
      const oldest = this.sigs.keys().next().value;
      if (oldest === undefined) break;
      this.sigs.delete(oldest);
    }
  }
}
