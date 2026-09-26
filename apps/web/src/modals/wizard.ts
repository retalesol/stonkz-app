import { paintWizArt, WIZART } from '../canvas/wizart.js';
import { moneyRain } from '../fx/moneyRain.js';
import { toast } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { USER, saveUser } from '../state/user.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * The three-step "how it works" wizard, plus its once-per-device payoff.
 * `index.html:2719`
 */

interface WizStep {
  k: string;
  tag: string;
  t: string;
  s: string;
}

const WIZ_STEPS: WizStep[] = [
  {
    k: 'pick',
    tag: 'THE BOARD',
    t: 'Pick a coin.',
    s: 'THREE LANES: NEW MINTS, ABOUT TO GRADUATE, GRADUATED. EVERY CARD CARRIES MARKET CAP, HOLDERS AND HOW FULL ITS BONDING CURVE IS.',
  },
  {
    k: 'buy',
    tag: 'THE TICKET',
    t: 'Buy on the curve.',
    s: 'YOUR SOL GOES IN, TOKENS COME OUT. PRICE CLIMBS AS THE CURVE FILLS, AND THE QUOTE REFRESHES EVERY EIGHT SECONDS.',
  },
  {
    k: 'grad',
    tag: 'GRADUATION',
    t: 'Token graduates at $69K.',
    s: 'THE CURVE FILLS, LIQUIDITY MIGRATES TO THE DEX AND THE LP BURNS. FROM DEGENS TO DEGREES.',
  },
];

const WIZ = { step: 0 };

function wizArt(k: string, tag: string): Html {
  const src = WIZART[k];
  return html`<div class="wiz-art">
    ${src ? html`<img src="${attr(src)}" alt="" />` : html`<canvas data-art="${attr(k)}"></canvas>`}<span
      class="tagname"
      >${tag}</span
    >
  </div>`;
}

function renderWiz(): void {
  const i = WIZ.step;
  const st = WIZ_STEPS[i] as WizStep;
  must('#wiz-count').textContent = 'STEP ' + (i + 1) + ' OF 3';
  render(
    must('#wizBody'),
    html`${wizArt(st.k, st.tag)}
      <div>
        <div class="wiz-step">${st.t}</div>
        <div class="wiz-sub">${st.s}</div>
      </div>
      <div class="wiz-foot">
        <span class="wiz-dots"
          >${WIZ_STEPS.map(
            (_, n) => html`<i class="wiz-dot${n === i ? ' on' : n < i ? ' done' : ''}"></i>`,
          )}</span
        ><span class="grow"></span
        ><button class="wiz-btn" id="wiz-back" ${i ? '' : ' disabled'}>BACK</button
        ><button class="wiz-btn go" id="wiz-next">
          ${i === WIZ_STEPS.length - 1 ? 'FINISH' : 'NEXT'}
        </button>
      </div>`,
  );
  paintWizArt(must('#wizBody'));
  refreshScrim('#wizScrim');
  $('#wiz-back')?.addEventListener('click', () => {
    if (WIZ.step > 0) {
      WIZ.step--;
      renderWiz();
    }
  });
  $('#wiz-next')?.addEventListener('click', () => {
    if (WIZ.step < WIZ_STEPS.length - 1) {
      WIZ.step++;
      renderWiz();
    } else {
      wizFinish();
    }
  });
}

function wizFinish(): void {
  // The payoff plays once per device.
  if (USER.seenWiz) {
    closeWiz();
    toast('YOU KNOW THE DRILL ' + DOT + ' GO FIND A GEM');
    return;
  }
  USER.seenWiz = true;
  saveUser();
  must('#wiz-count').textContent = 'VERY NICE';
  render(
    must('#wizBody'),
    html`${wizArt('finish', 'STONKZ')}
      <div class="wiz-fin">
        <div class="big-line">VERY NICE!</div>
        <div class="sub">
          THAT IS THE WHOLE GAME. FIND A GEM, APE RESPONSIBLY, AND REMEMBER NONE OF THIS IS REAL
          MONEY.
        </div>
      </div>
      <div class="wiz-foot">
        <span class="grow"></span><button class="wiz-btn go" id="wiz-done">LETS GO</button>
      </div>`,
  );
  paintWizArt(must('#wizBody'));
  refreshScrim('#wizScrim');
  $('#wiz-done')?.addEventListener('click', closeWiz);
  moneyRain(36);
}

export function openWiz(opener?: Element | null): void {
  WIZ.step = 0;
  renderWiz();
  openScrim('#wizScrim', opener);
}

export function closeWiz(): void {
  closeScrim('#wizScrim');
}

export function isWizOpen(): boolean {
  return isOpen('#wizScrim');
}

export function initWizard(): void {
  wireBackdrop('#wizScrim', closeWiz);
}
