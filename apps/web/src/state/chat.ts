import { fakeAddr } from '../lib/fmt.js';

/**
 * The global chat drawer.
 *
 * Phase 5.B replaces `push()` with a `chat` WS channel and a rate-limited
 * `POST /chat`; the drawer, the unread badge and the entry animation are
 * unchanged by that swap. `index.html:2990`
 */

export interface ChatMsg {
  who: string;
  t: string;
  text: string;
  mine: boolean;
}

export const CHAT: ChatMsg[] = [];

const SEED: Array<[string, string]> = [
  ['09:02', 'gm. who is farming the trench today'],
  ['09:03', 'giga curve is 88 percent, this one actually graduates'],
  ['09:05', 'bought larp at 4k, it is 9800 now, i am a genius'],
  ['09:06', 'ser you are up four hundred dollars, calm down'],
  ['09:11', 'cashback window on hopium is open, fee is basically free'],
];

const CHATTER = [
  'someone just moved 40 sol into bonkd',
  'wojak holders are eating today',
  'why is every new mint called something with trench in it',
  'staked my whole bag, locked 30 days, pray for me',
  'the tape is printing green, get in or stay poor',
  'my portfolio is down but my conviction is up',
  'gm to everyone except the guy who dumped tendie',
];

export function seedChat(): void {
  if (CHAT.length) return;
  SEED.forEach((m, i) => {
    CHAT.push({ who: fakeAddr(7100 + i * 311), t: m[0], text: m[1], mine: false });
  });
}

/** Cap the buffer so a long session cannot grow the DOM without bound. */
export function push(msg: ChatMsg): void {
  CHAT.push(msg);
  if (CHAT.length > 120) CHAT.shift();
}

export function ambientLine(): string {
  return CHATTER[(Math.random() * CHATTER.length) | 0] as string;
}

export function ambientWho(): string {
  return fakeAddr((Math.random() * 1e6) | 0);
}
