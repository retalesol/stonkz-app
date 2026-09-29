import type { ChatAccess } from '../views/chat-access.js';

/**
 * Chat rooms and their logs.
 *
 * One room per token plus GLOBAL. Phase 5.B replaces `HANDLES`/`GLINES`/
 * `TLINES` with a `chat` WS channel and a rate-limited `POST /chat`; the room
 * model, the 90-message cap and the unread counter survive that swap
 * unchanged. `index.html:3557`
 */

export interface ChatMsg {
  who: string;
  text: string;
  /** HH:MM. Filled in on push when absent. */
  t?: string;
  /** Handle colour. */
  col?: string;
  mine?: boolean;
  /** System line: rendered without an author row. */
  sys?: boolean;
  /** Full wallet when known — drives mememan seed + profile link. */
  wallet?: string;
  /** Custom PFP URL when set; otherwise mememan on a wallet colour. */
  avatarUrl?: string | null;
}

export interface ChatState {
  room: string;
  /** The token whose rooms (public + private) sit alongside GLOBAL, if any. */
  token: { sym: string; seed: number } | null;
  logs: Record<string, ChatMsg[]>;
  /** Total across rooms — what the tab badge shows. */
  unread: number;
  /** Per-room counts behind the tab chips. */
  unreadByRoom: Record<string, number>;
  /** Last `GET /chat/:net/:room/access` per room; `undefined` until fetched. */
  access: Record<string, ChatAccess | null>;
  open: boolean;
}

export const CHAT: ChatState = {
  room: 'GLOBAL',
  token: null,
  logs: { GLOBAL: [] },
  unread: 0,
  unreadByRoom: {},
  access: {},
  open: false,
};

/** One more unseen line in `room`. Returns the new total. */
export function bumpUnread(state: ChatState, room: string): number {
  state.unreadByRoom[room] = (state.unreadByRoom[room] ?? 0) + 1;
  state.unread++;
  return state.unread;
}

/** The user is looking at `room` now; its count folds out of the total. */
export function clearUnread(state: ChatState, room: string): number {
  const n = state.unreadByRoom[room] ?? 0;
  if (n) {
    state.unread = Math.max(0, state.unread - n);
    state.unreadByRoom[room] = 0;
  }
  return state.unread;
}

export function unreadIn(state: ChatState, room: string): number {
  return state.unreadByRoom[room] ?? 0;
}

export const HANDLES: Array<[string, string]> = [
  ['0xSCHIZO', '#ffd23f'],
  ['TRENCHRAT', '#4d9bff'],
  ['MEV_JANITOR', '#a273ff'],
  ['LP_MAXI', '#00d26a'],
  ['EXITLIQ', '#ff4c3b'],
  ['FLOORSEER', '#a273ff'],
  ['ANON_4488', '#cac6ba'],
  ['CURVEWATCH', '#26d0c4'],
  ['JEET_HUNTER', '#ff7ac0'],
];

export const GLINES = [
  'board is moving. three curves past 80% at the same time',
  'whoever is sniping every new mint in block zero, we see you',
  'gm to everyone still reading contract authority before buying',
  'the graduated lane is where the boring money is and i am fine with that',
  'prio fees are cheap right now, good window',
  'reminder: curve fill percent is not liquidity',
  'someone explain why every ticker today is four letters',
  'watching the new mints lane like it is a slot machine',
];

export const TLINES = [
  '$SYM chart is doing the thing again',
  'dev of $SYM has not touched the wallet once. checked twice',
  'if $SYM graduates i am telling my wife about it',
  'who is bidding $SYM up here, show yourself',
  '$SYM holders are early or delusional and it is the same thing',
  'curve on $SYM is filling faster than the last three',
  'just added to $SYM. no thesis, only vibes',
];

export function logFor(room: string): ChatMsg[] {
  let l = CHAT.logs[room];
  if (!l) {
    l = [];
    CHAT.logs[room] = l;
  }
  return l;
}

export function randomHandle(): [string, string] {
  return HANDLES[(Math.random() * HANDLES.length) | 0] as [string, string];
}
