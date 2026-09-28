import { foldConfusables } from '../routes/launch-validate.js';

/**
 * Launch moderation — plan step 93's stub. Real moderation (image scanning,
 * ML text classification, human review queue) is explicitly Phase 5; this is
 * a flat bad-word match on `name`/`ticker`/`descr`, case-, accent-,
 * look-alike- and separator-insensitive, so it catches the trivial
 * `f-u-c-k` / Cyrillic `fuсk` dodge without pretending to be a real
 * content-safety system.
 *
 * Two lists, because a blind substring match on short words rejected
 * perfectly ordinary coins (`Spicy`, `Grape`, `Skyscraper`, `Therapeutic`,
 * `Flame Retardant`):
 *  - {@link SUBSTRING} terms are unambiguous and match anywhere, separators
 *    stripped;
 *  - {@link WHOLE_WORD} terms only match as a whole word (optionally plural /
 *    `-ed`), or as a whole field once separators are stripped (`s.p.i.c`).
 * Each field is checked on its own so a match cannot straddle two fields.
 */
const SUBSTRING = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'hitler',
  'terrorist',
] as const;

const WHOLE_WORD = ['retard', 'rape', 'nazi', 'kike', 'chink', 'spic', 'kys'] as const;

export interface ModerationResult {
  ok: boolean;
  /** Which blocklist terms matched, for the log line — never shown to the user beyond "rejected". */
  matched: string[];
}

function matchesField(raw: string): string[] {
  const folded = foldConfusables(raw);
  const collapsed = folded.replace(/[^a-z0-9]/g, '');
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  const hits: string[] = SUBSTRING.filter((w) => collapsed.includes(w));
  for (const w of WHOLE_WORD) {
    const re = new RegExp(`^${w}(s|es|ed)?$`);
    if (re.test(collapsed) || words.some((word) => re.test(word))) hits.push(w);
  }
  return hits;
}

export function moderateLaunch(fields: {
  name: string;
  ticker: string;
  descr: string;
}): ModerationResult {
  const matched = [
    ...new Set([
      ...matchesField(fields.name),
      ...matchesField(fields.ticker),
      ...matchesField(fields.descr),
    ]),
  ];
  return { ok: matched.length === 0, matched };
}
