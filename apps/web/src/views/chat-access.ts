/**
 * Chat room naming and the composer's gate states — pure, so `chat.test.ts`
 * can pin the copy and the state machine without a DOM.
 *
 * Rooms on the web side keep their `$`: `GLOBAL`, `$WOJAK`, `$WOJAK:PRIVATE`.
 * The server's key drops it (`WOJAK`, `WOJAK:PRIVATE`); {@link liveRoomKey}
 * converts. The rules the states mirror live in `apps/api/src/social/chat.ts`:
 * $100 lifetime volume to post in GLOBAL / a token room, $5 of the token
 * held to read or post in its private room.
 */

export const PRIVATE_SUFFIX = ':PRIVATE';

/** Mirrors the API's `ChatAccess` — what `GET /chat/:net/:room/access` returns. */
export interface ChatAccess {
  room: string;
  kind: 'global' | 'token' | 'private';
  sym: string | null;
  signedIn: boolean;
  canRead: boolean;
  canPost: boolean;
  reason:
    | 'unauthorized'
    | 'volume_required'
    | 'holder_required'
    | 'unknown_token'
    | 'net_mismatch'
    | null;
  volumeUsd: number | null;
  volumeRequiredUsd: number;
  holdingUsd: number | null;
  holdingRequiredUsd: number;
}

export function privateRoomOf(sym: string): string {
  return '$' + sym.toUpperCase() + PRIVATE_SUFFIX;
}

export function isPrivateRoom(room: string): boolean {
  return room.toUpperCase().endsWith(PRIVATE_SUFFIX);
}

/** `$WOJAK:PRIVATE` → `WOJAK`; `$WOJAK` → `WOJAK`; `GLOBAL` → `null`. */
export function roomSym(room: string): string | null {
  if (room === 'GLOBAL') return null;
  const bare = room.replace(/^\$/, '').toUpperCase();
  return bare.endsWith(PRIVATE_SUFFIX) ? bare.slice(0, -PRIVATE_SUFFIX.length) : bare;
}

/** The server's room key: uppercase, no leading `$`. */
export function liveRoomKey(room: string): string {
  return room.replace(/^\$/, '').toUpperCase();
}

/** Tab copy: `GLOBAL`, `$WOJAK`, `$WOJAK (PRIVATE)`. */
export function roomLabel(room: string): string {
  if (room === 'GLOBAL') return 'GLOBAL';
  const sym = roomSym(room) ?? '';
  return isPrivateRoom(room) ? `$${sym} (PRIVATE)` : `$${sym}`;
}

/** Drawer heading. */
export function roomTitle(room: string): string {
  if (room === 'GLOBAL') return 'GLOBAL CHAT';
  const sym = roomSym(room) ?? '';
  return isPrivateRoom(room) ? `$${sym} PRIVATE CHAT` : `$${sym} CHAT`;
}

/** `$42.50`, `$100`, never `$1.2K` — a progress line wants the exact figure. */
export function exactUsd(v: number): string {
  const safe = Number.isFinite(v) && v > 0 ? v : 0;
  const fixed = safe
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1');
  return '$' + fixed;
}

export function volumeNotice(access: Pick<ChatAccess, 'volumeUsd' | 'volumeRequiredUsd'>): string {
  return `TRADE ${exactUsd(access.volumeRequiredUsd)} TO UNLOCK CHAT · ${exactUsd(
    access.volumeUsd ?? 0,
  )} SO FAR`;
}

export function holderNotice(sym: string, requiredUsd = 5): string {
  return `HOLD ${exactUsd(requiredUsd)} OF $${sym.toUpperCase()} TO ENTER`;
}

export type ComposerMode =
  /** Sim mode, or a live wallet that clears every gate. */
  | 'ready'
  /** No wallet connected. */
  | 'connect'
  /** Access not fetched yet. */
  | 'loading'
  /** Under the lifetime-volume gate: read-only, progress shown. */
  | 'volume'
  /** Private room without the holding: nothing to read, nothing to post. */
  | 'locked'
  /** Private room for a token the API does not know. */
  | 'unavailable';

export interface ComposerState {
  mode: ComposerMode;
  disabled: boolean;
  placeholder: string;
  /** The line above the composer, or `null` for none. */
  notice: string | null;
  /** 0..1 toward the volume gate, only in `volume` mode. */
  progress: number | null;
  /** Whether the log itself is hidden behind the lock. */
  hidesLog: boolean;
}

export interface ComposerInput {
  room: string;
  live: boolean;
  walletOn: boolean;
  access: ChatAccess | null;
}

export function composerState(input: ComposerInput): ComposerState {
  const base: ComposerState = {
    mode: 'ready',
    disabled: false,
    placeholder: 'SAY SOMETHING',
    notice: null,
    progress: null,
    hidesLog: false,
  };
  if (!input.live) return base;

  const priv = isPrivateRoom(input.room);
  const sym = roomSym(input.room) ?? '';

  if (!input.walletOn) {
    return {
      ...base,
      mode: 'connect',
      disabled: true,
      placeholder: priv ? 'CONNECT A WALLET TO ENTER' : 'CONNECT A WALLET TO CHAT',
      notice: priv ? holderNotice(sym) : null,
      hidesLog: priv,
    };
  }

  const a = input.access;
  if (!a) {
    return {
      ...base,
      mode: 'loading',
      disabled: true,
      placeholder: priv ? 'CHECKING YOUR POSITION…' : 'CHECKING ACCESS…',
      hidesLog: priv,
    };
  }

  if (priv) {
    if (a.reason === 'unknown_token') {
      return {
        ...base,
        mode: 'unavailable',
        disabled: true,
        placeholder: 'ROOM UNAVAILABLE',
        notice: 'THIS TOKEN HAS NO PRIVATE ROOM YET',
        hidesLog: true,
      };
    }
    if (!a.canRead || !a.canPost) {
      return {
        ...base,
        mode: 'locked',
        disabled: true,
        placeholder: 'HOLDERS ONLY',
        notice: holderNotice(a.sym ?? sym, a.holdingRequiredUsd),
        hidesLog: true,
      };
    }
    return base;
  }

  if (a.canPost) return base;
  const required = a.volumeRequiredUsd || 100;
  const have = a.volumeUsd ?? 0;
  return {
    ...base,
    mode: 'volume',
    disabled: true,
    placeholder: 'READ ONLY UNTIL YOU TRADE',
    notice: volumeNotice(a),
    progress: Math.max(0, Math.min(1, have / required)),
  };
}
