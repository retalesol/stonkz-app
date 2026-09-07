import { GRAD, usd } from '@stonkz/shared';
import { api, SIMULATED } from '../api/index.js';
import { drawFace } from '../canvas/face.js';
import { initFx } from '../fx/debris.js';
import { toast } from '../fx/toast.js';
import { $, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { closeClaim, initClaim, isClaimOpen } from '../modals/claim.js';
import { closeEdit, initEdit, isEditOpen } from '../modals/edit.js';
import { closeLaunch, initLaunch, isLaunchOpen, openLaunch } from '../modals/launch.js';
import { initNetPicker, isNetOpen, netOpen } from '../modals/netpicker.js';
import { initSettings, isSetOpen, openSet } from '../modals/settings.js';
import { closeStake, isStakeOpen } from '../modals/stake.js';
import { closeWiz, initWizard, isWizOpen, openWiz } from '../modals/wizard.js';
import { COINS, bySym } from '../state/coins.js';
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
import { type Route, back, navigate, onRoute, startRouting } from './route.js';
import { currentView, showView } from './view.js';
import { connectWallet, disconnectWallet, initWalletChip, isWmenuOpen, renderWallet, wmenu } from './wallet.js';

/**
 * The app shell: header, search, escape stack, footer and boot.
 *
 * `index.html:3987`
 */

/* --------------------------------- routing -------------------------------- */

function apply(r: Route): void {
  if (r.view === 'token') {
    const c = bySym(r.sym);
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
}

/* ------------------------------- escape stack ------------------------------ */

/**
 * Escape unwinds exactly one layer, innermost first.
 *
 * The order is the z-order: the six scrims (stake is opened from the token page
 * on top of everything, the wizard can be opened from inside claim), then the
 * two header menus, then the chat drawer, then the view stack.
 */
function onEscape(): void {
  if (isStakeOpen()) closeStake();
  else if (isWizOpen()) closeWiz();
  else if (isClaimOpen()) closeClaim();
  else if (isEditOpen()) closeEdit();
  else if (isSetOpen()) openSet(false);
  else if (isLaunchOpen()) closeLaunch();
  else if (isNetOpen()) netOpen(false);
  else if (isWmenuOpen()) wmenu(false);
  else if (isChatOpen()) chatOpen(false);
  else if (currentView() === 'rewards' || currentView() === 'profile') back();
  else if (TV.c) navigate({ view: 'board' });
}

/* ---------------------------------- boot ---------------------------------- */

export async function boot(): Promise<void> {
  drawFace(must<HTMLCanvasElement>('#brandFace'));
  initFx();
  loadUser();
  loadSettings();
  touchStreak();
  renderRank();

  must('#gradCap').textContent = usd(GRAD);
  must('#bootNote').textContent = SIMULATED
    ? 'SIMULATED MARKET ' + DOT + ' PRICES, TRADES AND BALANCES ARE FAKE ' + DOT + ' NOTHING HERE TOUCHES A CHAIN'
    : 'LIVE DATA ' + DOT + ' MAINNET';

  await api.ready();

  initBoard();
  initTape();
  initChat();
  initProfileView();
  initLaunch();
  initWizard();
  initSettings(() => {
    if (TV.c) drawTChart();
  });
  initEdit(() => {
    if (currentView() === 'profile') renderProfile();
  });
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
    openLaunch(must('#createBtn'));
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
  must('#searchform').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = must<HTMLInputElement>('#q');
    const c = bySym(q.value.trim().toUpperCase());
    if (!c) return;
    navigate({ view: 'token', sym: c.sym });
    q.value = '';
    filterBoard('');
  });
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
  document.documentElement.dataset['booted'] = 'true';
}
