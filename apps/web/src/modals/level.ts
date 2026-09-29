import { CRATES, type CrateTier, crateBy } from '@stonkz/shared';
import { drawCrate } from '../canvas/crate.js';
import { burst } from '../fx/debris.js';
import { $, $$, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * The SP level-up ceremony: which level landed, which crates it dropped into
 * inventory, and a single CTA to the rewards page. Grants are automatic on
 * the server (`SpLevelService.sync`), so there is nothing to "claim" here —
 * the dialog exists so a grant that arrived mid-trade is not missed.
 *
 * The scrim is built on first use rather than living in `index.html`, so the
 * page markup does not need to know about it; it plugs into the shared
 * `scrim` open/close path like every other dialog. Deliberately DOM-only:
 * `state/user.ts` calls in here, so this module must not import state.
 */

export interface LevelUpInfo {
  level: number;
  grants: Partial<Record<CrateTier, number>>;
  totalSp: number;
  /** SP required for the next level, or null at max. */
  next: number | null;
}

let queue: LevelUpInfo[] = [];
let onOpenRewards: (() => void) | null = null;

/** Wire the CTA once from the shell (`openRewards` lives in views, which we must not import). */
export function initLevelModal(openRewards: () => void): void {
  onOpenRewards = openRewards;
}

function ensureScrim(): HTMLElement {
  const existing = $('#levelScrim');
  if (existing) return existing;
  const el = document.createElement('div');
  el.className = 'scrim';
  el.id = 'levelScrim';
  render(
    el,
    html`<div
      class="win lvl-win"
      role="dialog"
      aria-modal="true"
      aria-label="SP level up"
      style="max-width:440px"
    >
      <div class="win-hd">
        <h2>Level Up</h2>
        <span class="sub" id="lvl-sub"></span>
        <button class="x" aria-label="Close">&#10005;</button>
      </div>
      <div class="win-bd" id="lvl-bd"></div>
    </div>`,
  );
  document.body.appendChild(el);
  wireBackdrop('#levelScrim', closeLevelModal);
  return el;
}

export function levelUpHTML(info: LevelUpInfo): Html {
  const rows = (Object.entries(info.grants) as [CrateTier, number][])
    .filter(([, n]) => n > 0)
    .map(([tier, n]) => {
      const c = crateBy(tier);
      return html`<div class="lvl-grant" data-tier="${attr(tier)}">
        <canvas width="72" height="72" aria-hidden="true"></canvas>
        <b style="color:${attr(c?.col ?? '#d7dde3')}">${tier}</b>
        <span>×${n}</span>
      </div>`;
    });
  return html`<div class="lvl-hero">
      <span class="lvl-k">STONK POINTZ</span>
      <span class="lvl-n">LV ${info.level}</span>
      <span class="lvl-s"
        >${rows.length ? 'CRATES ADDED TO YOUR INVENTORY' : 'NO CRATES AT THIS LEVEL'}</span
      >
    </div>
    <div class="lvl-grants">${rows}</div>
    <p class="hint">
      ${
        info.next === null
          ? `MAX LEVEL ${DOT} EVERY CRATE TIER UNLOCKED`
          : `${(info.next - info.totalSp).toLocaleString()} SP TO LV ${info.level + 1} ${DOT} TRADE TO EARN SP`
      }
    </p>
    <button type="button" class="openbtn" id="lvl-go">OPEN CRATES</button>`;
}

function paint(info: LevelUpInfo): void {
  const el = ensureScrim();
  const sub = $('#lvl-sub', el);
  if (sub)
    sub.textContent = `LEVEL ${info.level} OF ${maxLevel()} ${DOT} ${info.totalSp.toLocaleString()} SP`;
  render(must('#lvl-bd', el), levelUpHTML(info));
  for (const g of $$('.lvl-grant', el)) {
    const tier = g.dataset['tier'] as CrateTier | undefined;
    const canvas = $<HTMLCanvasElement>('canvas', g);
    if (tier && canvas) drawCrate(canvas, crateBy(tier)?.col ?? '#d7dde3');
  }
  $('#lvl-go', el)?.addEventListener('click', () => {
    closeLevelModal();
    onOpenRewards?.();
  });
}

let maxLevelHint = 20;
function maxLevel(): number {
  return maxLevelHint;
}
/** The API may serve an operator ladder longer or shorter than the shipped one. */
export function setLevelCount(n: number): void {
  if (Number.isFinite(n) && n > 0) maxLevelHint = n;
}

/** Show one level-up; further ones queue and play after the current dialog closes. */
export function showLevelUp(info: LevelUpInfo): void {
  if (!document.body) return;
  if (isLevelModalOpen()) {
    queue.push(info);
    return;
  }
  paint(info);
  openScrim('#levelScrim');
  if (!reducedMotion()) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    burst(cx - 80, cy - 40, 80, { n: 30, gold: true, spread: 1.8 });
    burst(cx + 80, cy - 40, 80, { n: 30, gold: true, spread: 1.8 });
  }
}

export function closeLevelModal(): void {
  if (!$('#levelScrim')) return;
  closeScrim('#levelScrim');
  const next = queue.shift();
  if (next) showLevelUp(next);
}

export function isLevelModalOpen(): boolean {
  return !!$('#levelScrim') && isOpen('#levelScrim');
}

/** Tests / hot paths: drop anything still queued. */
export function resetLevelQueue(): void {
  queue = [];
}

export const LEVEL_TIERS = CRATES.map((c) => c.k);
