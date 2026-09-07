import { type Net, num } from '@stonkz/shared';
import { api } from '../api/index.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, must, reflow } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { copyText, selectText } from '../lib/clipboard.js';
import { reducedMotion } from '../lib/motion.js';
import { NATIVE_PRICE, NETS, WALLET, nativeUnit, netOf, selectNet } from '../state/wallet.js';
import { USER } from '../state/user.js';
import { netOpen } from '../modals/netpicker.js';
import { addChat } from '../views/chat.js';

/**
 * The wallet chip, its menu, and the connect flow.
 *
 * Phase 1.B replaces `connect()` inside the adapter with SIWS / SIWE; this file
 * only ever renders what the adapter reports, which is why the fake 460ms
 * "CONNECTING" pause lives here and the fake address does not.
 * `index.html:2498`
 */

let afterChange: () => void = () => undefined;

export function renderWallet(): void {
  const on = WALLET.on;
  must('#connectBtn').hidden = on;
  must('#wchip').hidden = !on;
  if (!on) {
    wmenu(false);
    netOpen(false);
  }
  if (on) {
    const n = netOf();
    pix($<HTMLCanvasElement>('#wchip canvas'), WALLET.seed);
    must('#wNetDot').style.background = n.col;
    must('#wNetDot2').style.background = n.col;
    must('#wNetName').textContent = n.name;
    must('#wchip').title = n.name + ' ' + DOT + ' ' + n.sub;
    must('#wAddr').textContent = WALLET.addr;
    const unit = nativeUnit();
    must('#wBal').textContent = WALLET.sol.toFixed(2) + ' ' + unit;
    must('#wUsd').textContent = '\u2248 $' + num(WALLET.sol * NATIVE_PRICE.usd);
    must('.wbal .lbl').textContent = unit + ' BALANCE';
    must('#wFull').textContent = WALLET.full.slice(0, 10) + '\u2026' + WALLET.full.slice(-6);
  }
  (must('#rankBtn').parentNode as HTMLElement).hidden = !on;
  const hello = $('#hello');
  if (hello) hello.hidden = on || !!USER.seenHello;
  const l = must('#createBtn');
  l.classList.toggle('on', on);
  // Never leave the CTA lit while it is disabled.
  if (!on) l.classList.remove('wake', 'nudge');
  l.setAttribute('aria-disabled', on ? 'false' : 'true');
  l.title = on ? '' : 'CONNECT A WALLET FIRST';
  afterChange();
}

export function wmenu(v: boolean): void {
  must('#wmenu').hidden = !v;
  must('#wchip').classList.toggle('open', v);
  must('#wchip').setAttribute('aria-expanded', v ? 'true' : 'false');
}

export function isWmenuOpen(): boolean {
  return !must('#wmenu').hidden;
}

export async function connectWallet(netKey: Net): Promise<void> {
  const n = NETS[netKey] ?? NETS.SOL;
  selectNet(n.k);
  netOpen(false);
  const b = must('#connectBtn');
  b.classList.add('connecting');
  b.textContent = 'CONNECTING ' + n.name + '...';
  // The pause is theatre in the sim and a real round trip in Phase 1.B.
  await new Promise((r) => setTimeout(r, 460));
  b.classList.remove('connecting');
  b.textContent = 'CONNECT WALLET';
  await api.connect(n.k);
  renderWallet();
  const l = must('#createBtn');
  if (!reducedMotion()) {
    l.classList.remove('wake', 'nudge');
    reflow(l);
    l.classList.add('wake');
    l.addEventListener('animationend', function done() {
      l.classList.remove('wake');
      l.removeEventListener('animationend', done);
    });
  }
  toast(n.name + ' CONNECTED ' + DOT + ' ' + WALLET.addr + ' ' + DOT + ' SIMULATED');
  addChat('GLOBAL', { sys: true, who: '', text: 'WALLET CONNECTED ' + DOT + ' ' + n.name + ' ' + DOT + ' ' + WALLET.addr }, true);
}

export function disconnectWallet(): void {
  api.disconnect();
  renderWallet();
  toast('WALLET DISCONNECTED');
}

export function initWalletChip(opts: {
  onChange: () => void;
  onProfile: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
}): void {
  afterChange = opts.onChange;

  must('#wFull').addEventListener('click', (e) => {
    e.stopPropagation();
    const el = must('#wFull');
    copyText(WALLET.full, (ok) => {
      el.classList.add('copied');
      if (ok) {
        el.textContent = 'ADDRESS COPIED';
        toast('ADDRESS COPIED ' + DOT + ' ' + WALLET.addr);
      } else {
        // Clipboard blocked: hand them a selection instead.
        el.textContent = WALLET.full;
        selectText(el);
        toast('SELECT AND PRESS CTRL+C ' + DOT + ' CLIPBOARD BLOCKED HERE');
      }
      setTimeout(
        () => {
          el.classList.remove('copied');
          renderWallet();
        },
        ok ? 1500 : 4000,
      );
    });
  });

  must('#wchip').addEventListener('click', () => wmenu(!isWmenuOpen()));
  must('#wmenu').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-w]');
    if (!b) return;
    wmenu(false);
    const w = b.dataset['w'];
    if (w === 'profile') opts.onProfile();
    else if (w === 'settings') opts.onSettings();
    else opts.onDisconnect();
  });

  document.addEventListener('mousedown', (e) => {
    if ((e.target as Element | null)?.closest('#walletArea')) return;
    if (isWmenuOpen()) wmenu(false);
    if (!must('#netMenu').hidden) netOpen(false);
  });
}
