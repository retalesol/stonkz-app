/**
 * Launch moderation — plan step 93's stub. Real moderation (image scanning,
 * ML text classification, human review queue) is explicitly Phase 5; this is
 * a flat bad-word substring match on `name`/`ticker`/`descr`, case- and
 * separator-insensitive, so it catches the trivial `f-u-c-k`-style dodge
 * without pretending to be a real content-safety system.
 */

const BLOCKLIST = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'rape',
  'nazi',
  'hitler',
  'kike',
  'chink',
  'spic',
  'terrorist',
  'kys',
] as const;

/** Strips anything that is not `a-z0-9`, so `f.u.c.k` / `F_U_C_K` still hit. */
function normalise(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ModerationResult {
  ok: boolean;
  /** Which blocklist terms matched, for the log line — never shown to the user beyond "rejected". */
  matched: string[];
}

export function moderateLaunch(fields: { name: string; ticker: string; descr: string }): ModerationResult {
  const haystack = normalise(`${fields.name} ${fields.ticker} ${fields.descr}`);
  const matched = BLOCKLIST.filter((word) => haystack.includes(word));
  return { ok: matched.length === 0, matched };
}
