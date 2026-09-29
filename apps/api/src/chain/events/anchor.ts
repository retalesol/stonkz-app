import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';
import { BorshReader } from './borsh.js';

/**
 * Anchor's two event framings, decoded properly rather than string-matched.
 *
 * `emit!` (what `programs/solana/programs/launchpad` uses everywhere — see the
 * `emit!` calls in `instructions/*.rs`) serialises the event with Borsh and
 * hands it to the `sol_log_data` syscall, which the RPC surfaces as a
 * `Program data: <base64>` line in `meta.logMessages`. The bytes are:
 *
 *     [0..8]  sha256("event:<Name>")[..8]   — which event
 *     [8..]   borsh-serialised fields
 *
 * `emit_cpi!` instead publishes a self-CPI whose instruction data prefixes the
 * same pair with Anchor's fixed `EVENT_IX_TAG`:
 *
 *     [0..8]   EVENT_IX_TAG (0x1d9acb512ea545e4, little-endian)
 *     [8..16]  sha256("event:<Name>")[..8]
 *     [16..]   borsh-serialised fields
 *
 * The launchpad does not use `emit_cpi!` today, but RPC providers are allowed
 * to truncate `logMessages`, and the standard mitigation is to move a critical
 * event to `emit_cpi!`. Supporting both here means that change would not
 * require a decoder change — and the tag is checked *plus* the discriminator,
 * because the tag alone only answers "is this an Anchor event", never "is this
 * my event".
 */

/** Anchor's `EVENT_IX_TAG` as it appears on the wire (little-endian). */
export const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xe5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const PROGRAM_DATA_PREFIX = 'Program data: ';
export const PROGRAM_RETURN_PREFIX = 'Program return: ';

/** `sha256("event:<Name>")[..8]` — Anchor's `eventDiscriminator`. */
export function eventDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`event:${name}`)).subarray(0, 8);
}

/** One `#[event]` struct: its name and how to read its body. */
export interface EventLayout<T> {
  name: string;
  read(r: BorshReader): T;
}

export interface DecodedAnchorEvent<T> {
  name: string;
  data: T;
}

/**
 * Dispatch table keyed by discriminator. Built once per program, not per log
 * line: the discriminators are `sha256` calls and the hot path is every log of
 * every transaction the program touched.
 */
export class AnchorEventCoder<T> {
  private readonly byDiscriminator = new Map<string, EventLayout<T>>();

  constructor(layouts: readonly EventLayout<T>[]) {
    for (const layout of layouts) {
      this.byDiscriminator.set(eventDiscriminator(layout.name).toString('base64'), layout);
    }
  }

  /** Known event names, for tests and for the `/metrics` label set. */
  names(): string[] {
    return [...this.byDiscriminator.values()].map((l) => l.name);
  }

  /**
   * Decodes one `Program data:` payload. `null` for a payload whose
   * discriminator belongs to some other program's event (or to an Anchor
   * account, which shares the framing) — that is not an error, it is the
   * normal case for a program that logs anything else.
   */
  decode(base64Payload: string): DecodedAnchorEvent<T> | null {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64Payload, 'base64');
    } catch {
      return null;
    }
    return this.decodeBytes(bytes);
  }

  decodeBytes(bytes: Buffer): DecodedAnchorEvent<T> | null {
    // An `emit_cpi!` payload carries the tag in front; strip it first so both
    // framings converge on "discriminator, then body".
    let body = bytes;
    if (body.length >= 16 && body.subarray(0, 8).equals(EVENT_IX_TAG)) {
      body = body.subarray(8);
    }
    if (body.length < 8) return null;

    const layout = this.byDiscriminator.get(body.subarray(0, 8).toString('base64'));
    if (!layout) return null;

    const reader = new BorshReader(body.subarray(8));
    const data = layout.read(reader);
    reader.assertExhausted(layout.name);
    return { name: layout.name, data };
  }

  /**
   * Decodes an `emit_cpi!` inner-instruction payload, which **must** carry
   * `EVENT_IX_TAG`. Without the tag the bytes are an ordinary instruction to
   * the program, not an event: `decodeBytes` treats the tag as optional (it
   * also serves `Program data:` lines), so feeding it raw inner-instruction
   * data would let any instruction whose first eight bytes happen to equal an
   * event discriminator be read as that event.
   */
  decodeCpiBytes(bytes: Buffer): DecodedAnchorEvent<T> | null {
    if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
    return this.decodeBytes(bytes);
  }
}

const INVOKE_LINE = /^Program (\S+) invoke \[(\d+)\]$/;
const SUCCESS_LINE = /^Program (\S+) success$/;
const FAILED_LINE = /^Program (\S+) failed(?::|$)/;

/**
 * The `Program data:` payloads that `programId` itself emitted, in log order.
 *
 * Log lines are not attributed to a program by the RPC, but the log stream is
 * structured: `Program <id> invoke [depth]` pushes a frame, `Program <id>
 * success` / `failed` pops it, and a `Program data:` line belongs to whichever
 * program is on top of that stack when it is written. A discriminator match
 * alone is NOT proof of origin: discriminators and Borsh layouts are public,
 * so any program can `sol_log_data` a byte-exact `Trade` in a transaction
 * that merely references the launchpad. Only data written while the
 * launchpad's own frame is on top counts.
 *
 * Nested CPIs (the launchpad calling the token program) push and pop their
 * own frames, so a data line written while a callee is on top is rejected,
 * and one written after the callee returns is accepted again. A `failed`
 * frame pops like `success` does. Truncated logs simply end the walk.
 */
export function programDataPayloads(logs: readonly string[], programId: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = INVOKE_LINE.exec(line);
    if (invoke) {
      stack.push(invoke[1] as string);
      continue;
    }
    const done = SUCCESS_LINE.exec(line) ?? FAILED_LINE.exec(line);
    if (done) {
      // Pop to the matching frame rather than blindly: a malformed or
      // interleaved log must not leave a stale launchpad frame on top.
      const at = stack.lastIndexOf(done[1] as string);
      if (at !== -1) stack.length = at;
      continue;
    }
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    if (stack[stack.length - 1] !== programId) continue;
    const payload = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    if (payload) out.push(payload);
  }
  return out;
}

/**
 * `emit_cpi!` payloads: the instruction data of every inner instruction whose
 * program is `programId`, base58 as the JSON-encoded RPC returns it.
 *
 * `accountKeys` must be the full key list — static keys followed by
 * `meta.loadedAddresses.writable` then `.readonly` — or an instruction whose
 * program id was resolved through a lookup table is missed. Callers decode
 * each payload with `AnchorEventCoder.decodeCpiBytes`, which requires the
 * `EVENT_IX_TAG`; this function only establishes which program ran it.
 */
export function cpiEventPayloads(
  innerInstructions: readonly {
    instructions: readonly { programIdIndex?: number; programId?: string; data?: string }[];
  }[],
  accountKeys: readonly string[],
  programId: string,
): Buffer[] {
  const out: Buffer[] = [];
  for (const group of innerInstructions) {
    for (const ix of group.instructions) {
      const owner =
        ix.programId ??
        (ix.programIdIndex !== undefined ? accountKeys[ix.programIdIndex] : undefined);
      if (owner !== programId || !ix.data) continue;
      try {
        out.push(Buffer.from(bs58.decode(ix.data)));
      } catch {
        // Not base58 — some RPCs return jsonParsed inner instructions, which
        // carry no raw data at all. Nothing to decode, and not an error.
      }
    }
  }
  return out;
}
