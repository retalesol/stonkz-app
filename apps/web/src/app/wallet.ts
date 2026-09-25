import { type Net, num } from '@stonkz/shared';
import { api } from '../api/index.js';
import { toast } from '../fx/toast.js';
import { paintAvatar } from '../lib/avatar.js';
import { $, must, reflow } from '../lib/dom.js';
import { DOT, shortAddr } from '../lib/fmt.js';
import { copyText, selectText } from '../lib/clipboard.js';
import { myDisplayName } from '../lib/identity.js';
import { reducedMotion } from '../lib/motion.js';
import { NATIVE_PRICE, NETS, WALLET, nativeUnit, netOf, selectNet } from '../state/wallet.js';
import { USER, saveUser } from '../state/user.js';
import { netOpen } from '../modals/netpicker.js';
import { WalletPickerCancelledError, openWalletPicker } from '../modals/walletpicker.js';
import {
  activeWallet,
  clearLastWallet,
  connectWalletFor,
  describeWalletError,
  disconnectActive,
  isPracticeSession,
  loadLastWallet,
  onActiveWalletChange,
  waitForWalletChoice,
} from '../wallet/index.js';
import { clearSession, logoutSession } from './session.js';

const API_BASE = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';

/**
 * The wallet chip, its menu, the connect flow and the practice-mode badge.
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
    const seed = WALLET.full || WALLET.addr || WALLET.seed;
    paintAvatar($<HTMLCanvasElement>('#wchip canvas'), {
      seed,
      avatarUrl: USER.avatarUrl ?? null,
      size: 18,
    });
    const menuAv = $<HTMLCanvasElement>('#wMenuAv');
    if (menuAv) {
      paintAvatar(menuAv, { seed, avatarUrl: USER.avatarUrl ?? null, size: 40 });
    }
    const uname = $('#wUserName');
    if (uname) uname.textContent = myDisplayName();
    must('#wNetDot').style.background = n.col;
    must('#wNetDot2').style.background = n.col;
    must('#wNetName').textContent = n.name;
    must('#wchip').title = n.name + ' ' + DOT + ' ' + n.sub;
    must('#wAddr').textContent = myDisplayName();
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
  const suffix =
    api.mode !== 'live'
      ? ' ' + DOT + ' SIMULATED'
      : isPracticeSession()
        ? ' ' + DOT + ' PRACTICE KEY'
        : '';
  toast(n.name + ' CONNECTED ' + DOT + ' ' + WALLET.addr + suffix);
}

export function disconnectWallet(): void {
  clearLastWallet();
  void disconnectActive();
  void logoutSession(API_BASE);
  api.disconnect();
  renderWallet();
  renderPracticeBadge();
  toast('WALLET DISCONNECTED');
}

/**
 * After a reload: reconnect the last wallet (no picker) and refresh the
 * SIWS/SIWE session so the user is not asked to sign again for ≥24h.
 */
export async function restoreWalletSession(): Promise<boolean> {
  if (api.mode !== 'live') return false;
  const pref = loadLastWallet();
  if (!pref) {
    console.info('[stonkz] wallet restore: no saved wallet');
    return false;
  }

  const choice = await waitForWalletChoice(pref.net, pref.walletId, 6000);
  if (!choice || choice.unavailable) {
    console.warn('[stonkz] wallet restore: wallet not available', pref.walletId, pref.net);
    return false;
  }

  try {
    // Paint the chip immediately from storage so a slow extension does not
    // look like a logged-out reload.
    selectNet(pref.net);
    WALLET.on = true;
    WALLET.addr = shortAddr(pref.address);
    WALLET.full = pref.address;
    renderWallet();

    const wallet = await connectWalletFor(pref.net, { id: choice.id, silent: true });
    const same =
      pref.net === 'RH'
        ? wallet.address.toLowerCase() === pref.address.toLowerCase()
        : wallet.address === pref.address;
    if (!same) {
      clearSession();
    }
    await api.connect(pref.net);
    renderWallet();
    renderPracticeBadge();
    return WALLET.on;
  } catch (err) {
    console.warn('[stonkz] wallet restore failed', err);
    WALLET.on = false;
    renderWallet();
    renderPracticeBadge();
    return false;
  }
}

export function initWalletChip(opts: {
  onChange: () => void;
  onProfile: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
}): void {
  afterChange = opts.onChange;

  onActiveWalletChange(() => {
    const wallet = activeWallet();
    if (api.mode === 'live' && WALLET.on && !wallet) {
      clearLastWallet();
      clearSession();
      api.disconnect();
      renderWallet();
      renderPracticeBadge();
      toast('WALLET DISCONNECTED \u00b7 THE WALLET ENDED THE SESSION', 'red');
      return;
    }
    if (wallet && WALLET.on && WALLET.full !== wallet.address) {
      clearSession();
      // Drop the previous wallet's display name so the chip cannot keep
      // showing e.g. Solana "Mememan" under a new RH address.
      delete USER.name;
      delete USER.bio;
      delete USER.avatarUrl;
      saveUser();
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
