import { GRAD, type Net, usd } from '@stonkz/shared';
import { api, disclosure } from '../api/index.js';
import { setNetSwitchHandler } from '../views/board.js';
import { netOf, savedNet, selectNet } from '../state/wallet.js';
import { isDeployed, loadChains } from '../wallet/chain.js';
import { initFx } from '../fx/debris.js';
import { toast, initMememan } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { closeClaim, initClaim, isClaimOpen } from '../modals/claim.js';
import { closeEdit, initEdit, isEditOpen } from '../modals/edit.js';
import {
  cancelCrop,
  closeLaunch,
  initLaunch,
  isCropOpen,
  isLaunchOpen,
  openLaunch,
} from '../modals/launch.js';
import { dismissSplash } from './splash.js';
import { closeLegal, initLegal, isLegalOpen } from '../modals/legal.js';
import { initNetPicker, isNetOpen, netOpen } from '../modals/netpicker.js';
import { initSettings, isSetOpen, openSet } from '../modals/settings.js';
import { closeStake, initStake, isStakeOpen } from '../modals/stake.js';
import { anyOpen, closeAll } from '../modals/scrim.js';
import { closeSteps, initSteps, isStepsOpen } from '../modals/steps.js';
import { cancelPicker, initWalletPicker, isWalletPickerOpen } from '../modals/walletpicker.js';
import { closeWiz, initWizard, isWizOpen, openWiz } from '../modals/wizard.js';
import { COINS, byMint, bySym, type SimCoin } from '../state/coins.js';
import { loadSettings } from '../state/settings.js';
import { USER, loadUser, saveUser, touchStreak } from '../state/user.js';
import { WALLET } from '../state/wallet.js';
import { initBoard, king, refreshNetChips } from '../views/board.js';
import { initSearch } from '../views/search.js';
import { chatOpen, chatRender, initChat, isChatOpen } from '../views/chat.js';
import { initProfileView, openProfile, renderProfile } from '../views/profile.js';
import { openRewards, updateCrates } from '../views/rewards.js';
import { initTape } from '../views/tape.js';
import { TV, closeToken, drawTChart, openToken, renderTab } from '../views/token.js';
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
    const local = (r.mint && byMint(r.mint)) || bySym(r.sym);
    // `?mint=` names one coin exactly. A ticker-only hit with another mint is
    // the same ticker on another chain, not this coin — look the address up
    // before settling for it.
    const c = r.mint && local?.mint !== r.mint ? null : local;
    if (!c) {
      void resolveToken(r);
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
  if (r.view === 'launch') {
    // A deep link or BACK into `/launch` gets the same gate as the button.
    if (!launchGate()) {
      navigate({ view: 'board' }, { replace: true });
      return;
    }
    openLaunch(must('#createBtn'));
  } else closeLaunch();
}

/**
 * A token link the board does not hold yet: a coin past the first page, or
 * on a chain the connected board is not showing. `api.search()` (live:
 * `GET /tokens?q=`, which merges hits into `COINS`) finds it by address or
 * ticker; only when that too misses is the link dead.
 */
async function resolveToken(r: Extract<Route, { view: 'token' }>): Promise<void> {
  let hit: SimCoin | null = null;
  try {
    const matches = await api.search(r.mint ?? r.sym);
    hit =
      (r.mint ? matches.find((m) => m.mint === r.mint) : undefined) ??
      matches.find((m) => m.sym === r.sym) ??
      null;
  } catch {
    hit = null;
  }
  // The same ticker on another chain is better than a dead end.
  if (!hit) hit = bySym(r.sym);
  // The user may have moved on while the lookup was in flight.
  const now = current();
  if (now.view !== 'token' || now.sym !== r.sym || now.mint !== r.mint) return;
  if (!hit) {
    // A dead link: say so once and fall back to the board rather than
    // rendering an empty page.
    toast('NO COIN CALLED ' + r.sym);
    navigate({ view: 'board' }, { replace: true });
    return;
  }
  if (TV.c !== hit) openToken(hit);
  else showView('token');
}

/* ------------------------------ launch intent ------------------------------ */

/**
 * "+ LAUNCH A COIN" pressed while disconnected (or on a net with nothing
 * deployed): remember it, so finishing the connect opens the stepper instead
 * of making the user find the button again. Expires so a connect much later,
 * for some other reason, does not pop a dialog nobody asked for.
 */
let launchIntentAt = 0;
const LAUNCH_INTENT_TTL_MS = 3 * 60_000;

function wantsLaunch(): boolean {
  return launchIntentAt > 0 && Date.now() - launchIntentAt < LAUNCH_INTENT_TTL_MS;
}

/** True when the stepper may open now; otherwise explain, open the net picker and remember. */
function launchGate(): boolean {
  if (!WALLET.on) {
    launchIntentAt = Date.now();
    toast('CONNECT A WALLET TO LAUNCH A COIN');
    netOpen(true);
    return false;
  }
  if (api.mode === 'live' && !isDeployed(WALLET.net)) {
    launchIntentAt = Date.now();
    toast(
      "LAUNCHES AREN'T LIVE ON " + netOf().name + ' IN THIS ENVIRONMENT YET · PICK ANOTHER NETWORK',
      'red',
    );
    netOpen(true);
    return false;
  }
  return true;
}

/** Connect from the net picker, then resume a pending launch if there is one. */
async function connectThenResume(net: Net): Promise<void> {
  try {
    await connectWallet(net);
  } catch (err) {
    console.warn('connect failed', err);
  }
  if (!wantsLaunch()) return;
  if (!WALLET.on) return;
  launchIntentAt = 0;
  if (api.mode === 'live' && !isDeployed(WALLET.net)) {
    toast("LAUNCHES AREN'T LIVE ON " + netOf().name + ' IN THIS ENVIRONMENT YET', 'red');
    return;
  }
  navigate({ view: 'launch' });
}

/** The footer line names only the chains this environment actually runs on. */
function paintDisclosure(): void {
  must('.foot .demo').textContent = disclosure();
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
  else if (isCropOpen()) cancelCrop();
  else if (isLaunchOpen()) leaveLaunch();
  else if (isNetOpen()) netOpen(false);
  else if (isWmenuOpen()) wmenu(false);
  else if (isChatOpen()) chatOpen(false);
  // Any dialog no module above claimed: never leave the user stuck behind a scrim.
  else if (anyOpen()) closeAll();
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
  paintDisclosure();

  try {
    await api.ready();
  } catch (err) {
    console.warn('api.ready failed', err);
  }

  // `chains.json` also decides which NET chips the board offers: a chain with
  // nothing deployed (ARC today) is not a filter anyone can use.
  if (api.mode === 'live')
    void loadChains().then(() => {
      paintDisclosure();
      refreshNetChips();
    });
  const remembered = savedNet();
  if (remembered) selectNet(remembered);
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
  // Wires the stake dialog's × and backdrop; a stake / unstake / claim
  // repaints the open token tab so the position and Fees numbers move.
  initStake(() => {
    if (TV.c) renderTab();
  });

  initNetPicker((net) => void connectThenResume(net));
  setNetSwitchHandler((net) => void connectWallet(net));
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
    if (!launchGate()) return;
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
  // The FIND box: as-you-type board filter, the suggestion list and Enter's
  // `api.search()` all live in `views/search.ts`.
  initSearch();

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
  // Admin-panel comms (maintenance banner / notices): a lazy chunk, live mode only.
  if (api.mode === 'live') {
    void import('../admin/banner.js').then((m) =>
      m.mountBanner(import.meta.env['VITE_API_URL'] ?? '', () => (WALLET.on ? WALLET.net : null)),
    );
  }

  const hello = $('#hello');
  if (hello) hello.hidden = WALLET.on || !!USER.seenHello;
  must('#count').textContent = COINS.length + ' COINS';
  // Dismiss before `data-booted` so e2e (and early clicks) never hit a
  // full-screen splash that still has pointer-events.
  await dismissSplash();
  document.documentElement.dataset['booted'] = 'true';
}
