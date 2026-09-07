import { type Net, num } from '@stonkz/shared';
import { api } from '../api/index.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, must, reflow } from '../lib/dom.js';
import { DOT, shortAddr } from '../lib/fmt.js';
import { copyText, selectText } from '../lib/clipboard.js';
import { reducedMotion } from '../lib/motion.js';
import { NATIVE_PRICE, NETS, WALLET, nativeUnit, netOf, selectNet } from '../state/wallet.js';
import { USER } from '../state/user.js';
import { netOpen } from '../modals/netpicker.js';
import { WalletPickerCancelledError, openWalletPicker } from '../modals/walletpicker.js';
import { addChat } from '../views/chat.js';
import {
  activeWallet,
  describeWalletError,
  disconnectActive,
  isPracticeSession,
  onActiveWalletChange,
} from '../wallet/index.js';
import { clearSession } from './session.js';

/**
 * The wallet chip, its menu, the connect flow and the practice-mode badge.
 *
 * Phase B replaced the connect flow's centrepiece. It used to be a 460ms
 * `setTimeout` labelled "CONNECTING SOLANA…" in front of a keypair that was
 * already sitting in `localStorage`; it is now `modals/walletpicker.ts` —
 * the wallets this browser really has, a real authorisation prompt, and for
 * Robinhood Chain a WalletConnect QR, because Robinhood Wallet is mobile-only
 * (`docs/robinhood-chain.md` row 32). `api.connect()` then runs the SIWS/SIWE
 * handshake with that wallet's own key.
 *
 * In sim mode none of that happens: `simApi.connect()` still fabricates an
 * address, which is correct for a sandbox with no server to authenticate
 * against, and `renderWallet()` renders whatever the adapter reports either
 * way. `index.html:2498`
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

/**
 * The persistent practice-mode badge.
 *
 * Not dismissible and not conditional on anything the user can change: if the
 * active signer is `wallet/practice.ts`, this strip states that nothing
 * settles for as long as the session lasts.
 */
export function renderPracticeBadge(): void {
  const badge = must('#practiceBadge');
  const on = isPracticeSession();
  badge.hidden = !on;
  if (on) {
    must('#practiceBadgeText').textContent =
      'BROWSER-LOCAL KEY \u00b7 NOTHING SETTLES ON CHAIN \u00b7 ' + (activeWallet()?.address ?? '');
  }
}

export async function connectWallet(netKey: Net): Promise<void> {
  const n = NETS[netKey] ?? NETS.SOL;
  selectNet(n.k);
  netOpen(false);
  const b = must('#connectBtn');

  // Sim mode has no wallet to pick: `simApi.connect()` fabricates an address
  // for a sandbox with no server behind it, and asking a real extension to
  // authorise that would be worse than not asking.
  if (api.mode === 'live') {
    try {
      await openWalletPicker(n.k, b);
    } catch (err) {
      if (err instanceof WalletPickerCancelledError) {
        toast('CONNECT CANCELLED');
        return;
      }
      toast(describeWalletError(err), 'red');
      return;
    }
  }

  b.classList.add('connecting');
  b.textContent = 'SIGNING IN TO ' + n.name + '...';
  try {
    await api.connect(n.k);
  } finally {
    b.classList.remove('connecting');
    b.textContent = 'CONNECT WALLET';
  }
  renderWallet();
  renderPracticeBadge();
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
  const suffix = api.mode !== 'live' ? ' ' + DOT + ' SIMULATED' : isPracticeSession() ? ' ' + DOT + ' PRACTICE KEY' : '';
  toast(n.name + ' CONNECTED ' + DOT + ' ' + WALLET.addr + suffix);
  addChat('GLOBAL', { sys: true, who: '', text: 'WALLET CONNECTED ' + DOT + ' ' + n.name + ' ' + DOT + ' ' + WALLET.addr }, true);
}

export function disconnectWallet(): void {
  // Release the wallet session and the JWT it signed for, not just the chip:
  // leaving an authorised extension listening, or a bearer token in memory
  // for an address the user just walked away from, would both be wrong.
  void disconnectActive();
  clearSession();
  api.disconnect();
  renderWallet();
  renderPracticeBadge();
  toast('WALLET DISCONNECTED');
}

export function initWalletChip(opts: {
  onChange: () => void;
  onProfile: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
}): void {
  afterChange = opts.onChange;

  // A wallet can drop us on its own — locked, account switched away, or the
  // WalletConnect session ended from the phone. Reflect that immediately
  // rather than keep rendering an address that can no longer sign.
  onActiveWalletChange(() => {
    const wallet = activeWallet();
    if (api.mode === 'live' && WALLET.on && !wallet) {
      clearSession();
      api.disconnect();
      renderWallet();
      renderPracticeBadge();
      toast('WALLET DISCONNECTED \u00b7 THE WALLET ENDED THE SESSION', 'red');
      return;
    }
    if (wallet && WALLET.on && WALLET.full !== wallet.address) {
      // Account switched inside the wallet: the old JWT is bound to the old
      // address, so it has to go.
      clearSession();
      WALLET.addr = shortAddr(wallet.address);
      WALLET.full = wallet.address;
      renderWallet();
      renderPracticeBadge();
      toast('ACCOUNT SWITCHED \u00b7 ' + WALLET.addr + ' \u00b7 SIGN IN AGAIN TO TRADE');
    }
  });

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
