import { describe, expect, it } from 'vitest';
import type { Comment } from '../state/coins.js';
import { commentListHTML, commentsHTML, relTime } from './token-comments.js';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const ME = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const THEM = '0xb42f812a44c22cc6b861478900401ee759ebead6';

const LIST: Comment[] = [
  { id: 1, who: THEM, t: '11:55', at: NOW - 5 * 60_000, text: 'gm mememan', mine: false },
  { id: 2, who: ME, t: '11:59', at: NOW - 40_000, text: 'gm <b>bold</b> & co', mine: true },
];

function render(over: Partial<Parameters<typeof commentsHTML>[0]> = {}): string {
  return commentsHTML({
    list: LIST,
    now: NOW,
    canPost: true,
    gateNote: null,
    nameOf: (w) => (w === ME ? 'mememan.eth' : w.slice(0, 6)),
    replyTo: null,
    maxLen: 140,
    ...over,
  }).value.replace(/\s+/g, ' ');
}

describe('relTime', () => {
  it('rounds to the nearest sensible unit', () => {
    expect(relTime(NOW - 10_000, NOW)).toBe('JUST NOW');
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe('5M AGO');
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe('3H AGO');
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe('2D AGO');
    expect(relTime(NOW - 90 * 86_400_000, NOW)).toBe('3MO AGO');
  });
});

describe('commentsHTML', () => {
  it('renders relative times, own-comment styling and escaped text', () => {
    const out = render();
    expect(out).toContain('5M AGO');
    expect(out).toContain('JUST NOW');
    expect(out).toContain('class="cmt mine"');
    expect(out).toContain('mememan.eth');
    expect(out).toContain('gm &lt;b&gt;bold&lt;/b&gt; &amp; co');
    expect(out).not.toContain('<b>bold</b>');
    expect(out).toContain('data-at="' + (NOW - 5 * 60_000) + '"');
  });

  it("offers REPLY on other people's comments only when posting is allowed", () => {
    expect(render()).toContain(`data-reply="${THEM}"`);
    expect(render()).not.toContain(`data-reply="${ME}"`);
    expect(render({ canPost: false, gateNote: 'CONNECT A WALLET TO COMMENT.' })).not.toContain(
      'data-reply',
    );
  });

  it('prefills the composer for a reply', () => {
    const out = render({ replyTo: THEM });
    expect(out).toContain('value="@0xb42f "');
    expect(out).toContain('placeholder="REPLY TO 0xb42f"');
  });

  it('replaces the composer with the gate note when posting is closed', () => {
    const out = render({ canPost: false, gateNote: 'TRADE $100 TO UNLOCK CHAT · $27 SO FAR' });
    expect(out).not.toContain('id="cmt-form"');
    expect(out).toContain('id="cmt-gate"');
    expect(out).toContain('TRADE $100 TO UNLOCK CHAT');
  });

  it('caps the input at the room limit', () => {
    expect(render()).toContain('maxlength="140"');
  });

  it('shows loading and empty states', () => {
    expect(render({ list: null })).toContain('LOADING COMMENTS');
    expect(render({ list: [] })).toContain('NO COMMENTS YET');
  });

  it('renders the list alone for live updates', () => {
    const out = commentListHTML({ list: LIST, now: NOW, canPost: true, nameOf: (w) => w }).value;
    expect(out).not.toContain('cmt-form');
    expect(out.match(/class="cmt( mine)?"/g)?.length).toBe(2);
  });
});
