import { GRAD, usd } from '@stonkz/shared';
import { api, DISCLOSURE } from '../api/index.js';
import { initFx } from '../fx/debris.js';
import { toast, initMememan } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { closeClaim, initClaim, isClaimOpen } from '../modals/claim.js';
import { closeEdit, initEdit, isEditOpen } from '../modals/edit.js';
import { closeLaunch, initLaunch, isLaunchOpen, openLaunch } from '../modals/launch.js';
import { dismissSplash } from './splash.js';
import { closeLegal, initLegal, isLegalOpen } from '../modals/legal.js';
import { initNetPicker, isNetOpen, netOpen } from '../modals/netpicker.js';
import { initSettings, isSetOpen, openSet } from '../modals/settings.js';
import { closeStake, isStakeOpen } from '../modals/stake.js';
import { closeSteps, initSteps, isStepsOpen } from '../modals/steps.js';
import { cancelPicker, initWalletPicker, isWalletPickerOpen } from '../modals/walletpicker.js';
import { closeWiz, initWizard, isWizOpen, openWiz } from '../modals/wizard.js';
import { COINS, byMint, bySym } from '../state/coins.js';
import { loadSettings } from '../state/settings.js';
import { USER, loadUser, saveUser, touchStreak } from '../state/user.js';
import { WALLET } from '../state/wallet.js';
import { filterBoard, initBoard, king } from '../views/board.js';
import { chatOpen, chatRender, initChat, isChatOpen } from '../views/chat.js';
import { initProfileView, openProfile, renderProfile } from '../views/profile.js';
import { openRewards, updateCrates } from '../views/rewards.js';
import { initTape } from '../views/tape.js';
import { TV, closeToken, drawTChart, openToken } from '../views/token.js';
import { startLoop } from './loop.js';
import { renderRank } from './rank.js';
import { type Route, back, current, navigate, onRoute, startRouting } from './route.js';
import { currentView, showView } from './view.js';
import { initWalletDiscovery } from '../wallet/index.js';
import {
  connectWallet,
  disconnectWallet,
  initWalletChip,
  isWmenuOpen,
  renderPracticeBadge,
  renderWallet,
  restoreWalletSession,
  wmenu,
} from './wallet.js';


/**
 * The app shell: header, search, escape stack, footer and boot.
 *
 * `index.html:3987`
 */

/* --------------------------------- routing -------------------------------- */

function apply(r: Route): void {
  if (r.view === 'token') {
    const c = (r.mint && byMint(r.mint)) || bySym(r.sym);
    if (!c) {
      // A dead link: say so once and fall back to the board rather than
      // rendering an empty page.
      toast('NO COIN CALLED ' + r.sym);
      navigate({ view: 'board' }, { replace: true });
      return;
    }
    if (TV.c !== c) openToken(c);
    else showView('token');
    return;
  }
  if (r.view === 'rewards') {
    openRewards();
    return;
  }
  if (r.view === 'profile') {
    openProfile(r.addr);
    return;
  }
  // The board is the only route that tears the token page down; rewards and
  // profile sit on top of it so BACK can return to a live chart.
  if (TV.c) closeToken();
  showView('board');
  window.scrollTo(0, 0);
  if (r.view === 'launch') openLaunch(must('#createBtn'));
  else closeLaunch();
}

/** Closing the stepper is a navigation, since `/launch` is a route. */
function leaveLaunch(): void {
  if (current().view === 'launch') navigate({ view: 'board' });
  else closeLaunch();
}

/* ------------------------------- escape stack ------------------------------ */

/**
 * Escape unwinds exactly one layer, innermost first.
 *
 * The order is the z-order: the transaction-step walker (opened from inside
 * the trade box, launch stepper or claim modal, so it outranks all of them),
 * the wallet picker (opened from the header, and the innermost thing on
 * screen while it is up), then the remaining scrims (stake is opened from the
 * token page on top of everything, the wizard can be opened from inside
 * claim), then the two header menus, then the chat drawer, then the view
 * stack.
 */
function onEscape(): void {
  if (isLegalOpen()) closeLegal();
  else if (isStepsOpen()) closeSteps();
  else if (isWalletPickerOpen()) cancelPicker();
  else if (isStakeOpen()) closeStake();
  else if (isWizOpen()) closeWiz();
  else if (isClaimOpen()) closeClaim();
  else if (isEditOpen()) closeEdit();
  else if (isSetOpen()) openSet(false);
  else if (isLaunchOpen()) leaveLaunch();
  else if (isNetOpen()) netOpen(false);
  else if (isWmenuOpen()) wmenu(false);
  else if (isChatOpen()) chatOpen(false);
  else if (currentView() === 'rewards' || currentView() === 'profile') back();
  else if (TV.c) navigate({ view: 'board' });
}

/* ---------------------------------- boot ---------------------------------- */

export async function boot(): Promise<void> {
  // EIP-6963 announcements only arrive in response to our request event, and
  // wallets that load after us re-announce, so ask as early as possible.
  initWalletDiscovery();
  initFx();
  initMememan();
  loadUser();
  loadSettings();
  touchStreak();
  renderRank();

  must('#gradCap').textContent = usd(GRAD);
  must('.foot .demo').textContent = DISCLOSURE;

  try {
    await api.ready();
  } catch (err) {
    console.warn('api.ready failed', err);
  }

  initBoard();
  initTape();
  initChat();
  initSteps();
  initWalletPicker();
  initProfileView();
  initLaunch(leaveLaunch);
  initWizard();
  initSettings(() => {
    if (TV.c) drawTChart();
  });
  initEdit(() => {
    renderWallet();
    if (currentView() === 'profile') renderProfile();
    chatRender();
  });
  initLegal();
  initClaim(() => renderWallet());

  initNetPicker((net) => void connectWallet(net));
  initWalletChip({
    onChange: () => {
      if (currentView() === 'profile') renderProfile();
    },
    onProfile: () => navigate({ view: 'profile' }),
    onSettings: () => openSet(true, must('#wchip')),
    onDisconnect: disconnectWallet,
  });
  renderWallet();
  renderPracticeBadge();

  // Silent reconnect + JWT refresh so a reload does not force another SIWS/SIWE.
  try {
    await restoreWalletSession();
  } catch (err) {
    console.warn('wallet restore failed', err);
  }

  /* header */
  must('#howBtn').addEventListener('click', () => openWiz(must('#howBtn')));
  must('#rankBtn').addEventListener('click', () => navigate({ view: 'rewards' }));
  must('#homeBtn').addEventListener('click', () => navigate({ view: 'board' }));
  must('#createBtn').addEventListener('click', () => {
    if (!WALLET.on) {
      toast('CONNECT A WALLET TO LAUNCH A COIN');
      netOpen(true);
      return;
    }
    navigate({ view: 'launch' });
  });

  /* hello card */
  const dismissHello = (): void => {
    USER.seenHello = true;
    saveUser();
    must('#hello').hidden = true;
  };
  must('#helloX').addEventListener('click', dismissHello);
  must('#helloWiz').addEventListener('click', () => {
    dismissHello();
    openWiz(must('#helloWiz'));
  });

  /* search */
  // Enter goes through `api.search()` — a local `COINS` filter in sim, the
  // server's `GET /tokens?q=` in live. Live search merges hits into `COINS`
  // so symbols beyond the initial board page can still open.
  must('#searchform').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = must<HTMLInputElement>('#q');
    const query = q.value.trim();
    if (!query) return;
    const exact = query.toUpperCase();
    void api
      .search(query)
      .then((matches) => {
        if (!matches.length) {
          toast('NO COIN MATCHES ' + exact);
          return;
        }
        const c =
          matches.find((m) => m.sym === exact) ||
          matches.find((m) => m.sym.startsWith(exact)) ||
          matches.find((m) => m.name.toUpperCase().includes(exact)) ||
          matches[0];
        if (!c) {
          toast('NO COIN MATCHES ' + exact);
          return;
        }
        q.value = '';
        filterBoard('');
        navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
      })
      .catch(() => {
        toast('SEARCH FAILED', 'red');
      });
  });
  // The as-you-type filter only ever hides/shows cards already on the
  // rendered board, so it stays a local scan in both modes.
  must('#q').addEventListener('input', () => filterBoard(must<HTMLInputElement>('#q').value));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onEscape();
  });

  /* chat seed */
  chatRender();

  window.addEventListener('resize', () => {
    if (TV.c) drawTChart();
  });
  window.setInterval(updateCrates, 1000);

  onRoute((r) => apply(r));
  startRouting();

  king();
  startLoop();
  api.startStream();

  const hello = $('#hello');
  if (hello) hello.hidden = WALLET.on || !!USER.seenHello;
  must('#count').textContent = COINS.length + ' COINS';
  // Dismiss before `data-booted` so e2e (and early clicks) never hit a
  // full-screen splash that still has pointer-events.
  await dismissSplash();
  document.documentElement.dataset['booted'] = 'true';
}
