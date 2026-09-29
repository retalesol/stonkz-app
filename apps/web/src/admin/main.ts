import { ALL_NETS, NET_INFO, type Net } from '@stonkz/shared';
import { adminSession, onSessionChange } from './api.js';
import { adminLogout, initAdminWallets, stepUp, walletChoices, type StepUpPhase } from './auth.js';
import {
  closeDialog,
  dialog,
  errText,
  html,
  isDialogOpen,
  must,
  promptText,
  render,
  short,
  toast,
} from './ui.js';
import { renderAccess } from './views/access.js';
import { renderAudit } from './views/audit.js';
import { renderChain } from './views/chain.js';
import { renderComms } from './views/comms.js';
import { renderDashboard, unmountDashboard } from './views/dashboard.js';
import { renderSettings } from './views/settings.js';
import { renderTokens } from './views/tokens.js';
import { renderUsers } from './views/users.js';

/**
 * Stonkz admin console — a separate Vite entry (`admin.html`) so nothing here
 * ever reaches the terminal's bundle. Hash-routed sections in a left nav,
 * keyboard-first (1–8 jump sections, `/` focuses the first field, Esc closes),
 * mobile-tolerant (nav collapses under 820px).
 */
type Section = {
  id: string;
  label: string;
  key: string;
  render: (root: HTMLElement, params: URLSearchParams) => Promise<void>;
};

const SECTIONS: Section[] = [
  { id: 'dashboard', label: 'Dashboard', key: '1', render: (r) => renderDashboard(r) },
  { id: 'settings', label: 'Settings', key: '2', render: (r) => renderSettings(r) },
  { id: 'users', label: 'Users', key: '3', render: renderUsers },
  { id: 'tokens', label: 'Tokens', key: '4', render: renderTokens },
  { id: 'chain', label: 'Chain ops', key: '5', render: renderChain },
  { id: 'comms', label: 'Comms', key: '6', render: (r) => renderComms(r) },
  { id: 'audit', label: 'Audit log', key: '7', render: renderAudit },
  { id: 'access', label: 'Access', key: '8', render: (r) => renderAccess(r) },
];

function route(): { id: string; params: URLSearchParams } {
  const h = location.hash.replace(/^#\/?/, '');
  const [id = 'dashboard', qs = ''] = h.split('?');
  return {
    id: SECTIONS.some((s) => s.id === id) ? id : 'dashboard',
    params: new URLSearchParams(qs),
  };
}

function paintNav(active: string): void {
  render(
    must('#admNav'),
    html`${SECTIONS.map((s) => html`<a href="#/${s.id}" class="${s.id === active ? 'on' : ''}">${s.label}<kbd>${s.key}</kbd></a>`)}
      <span class="grow"></span>
      <span class="navfoot">/ FOCUS · ESC CLOSE · 1-8 JUMP</span>`,
  );
}

let ttlTimer: number | null = null;

function paintSession(): void {
  const s = adminSession();
  const box = must('#admSession');
  if (ttlTimer) window.clearInterval(ttlTimer);
  ttlTimer = null;
  if (!s) {
    render(box, html`<span class="dm">not signed in</span>`);
    return;
  }
  const paint = (): void => {
    const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
    render(
      box,
      html`<span class="tag net-${s.net}">${s.net}</span><b class="addr">${short(s.wallet, 6)}</b
        ><span class="role ${s.role}">${s.role}</span
        >${s.mfa ? html`<span class="tag on">mfa</span>` : ''}<span class="ttl"
          >${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span
        ><button type="button" class="btn ghost sm" id="logout">Sign out</button>`,
    );
    box
      .querySelector('#logout')
      ?.addEventListener('click', () => void adminLogout().then(() => location.reload()));
    if (left <= 0) location.reload();
  };
  paint();
  ttlTimer = window.setInterval(paint, 1000);
}

/* ---------------------------------------------------------------- login */

function askTotp(): Promise<string | undefined> {
  return promptText('Two-factor', '6-digit TOTP code', { placeholder: '123456' });
}

async function pickWallet(choices: ReturnType<typeof walletChoices>): Promise<string | undefined> {
  return dialog<string>('Pick a wallet', (done) => {
    queueMicrotask(() => {
      document
        .querySelectorAll<HTMLElement>('[data-wallet]')
        .forEach((b) => b.addEventListener('click', () => done(b.dataset['wallet'])));
    });
    return html`<div class="btns stack">
      ${choices.map((c) => html`<button type="button" class="btn" data-wallet="${c.id}">${c.name}</button>`)}
    </div>`;
  });
}

function paintLogin(
  root: HTMLElement,
  phase: StepUpPhase | null = null,
  error: string | null = null,
): void {
  const steps: [StepUpPhase, string][] = [
    ['connect', 'Connect wallet'],
    ['session', 'Sign in (SIWS / SIWE)'],
    ['challenge', 'Fetch admin challenge'],
    ['sign', 'Sign step-up message'],
    ['verify', 'Verify (+ TOTP) → 15-minute admin token'],
  ];
  const order = steps.map((s) => s[0]);
  const idx = phase ? order.indexOf(phase) : -1;
  render(
    root,
    html`<div class="login">
      <div class="pnl">
        <div class="pnl-hd">
          Admin sign-in<span class="sub"
            >two signatures, no passwords, no chain keys on the server</span
          >
        </div>
        <div class="pnl-bd">
          ${error ? html`<div class="errbox">${error}</div>` : ''}
          <ul class="steps flush">
            ${steps.map(([, label], i) => html`<li class="${i < idx || phase === 'done' ? 'done' : i === idx ? 'on' : ''}"><i>${i < idx || phase === 'done' ? '✓' : i + 1}</i>${label}</li>`)}
          </ul>
          <span class="lbl">Sign in on</span>
          <div class="nets">
            ${ALL_NETS.map((n) => html`<button type="button" class="netbtn" data-net="${n}" ${phase && phase !== 'done' ? 'disabled' : ''}><b>${NET_INFO[n].name}</b><span>${walletChoices(n).length} wallet(s) detected</span></button>`)}
          </div>
          <p class="hint">
            Your wallet must be listed in ADMIN_WALLETS or hold a role granted by an owner. Anything
            else is a 404 — the panel does not confirm it exists.
          </p>
        </div>
      </div>
    </div>`,
  );
  root.querySelectorAll<HTMLButtonElement>('[data-net]').forEach((b) =>
    b.addEventListener('click', () => {
      const net = b.dataset['net'] as Net;
      void stepUp(net, { onPhase: (p) => paintLogin(root, p), askTotp, pickWallet })
        .then(() => {
          toast('admin session started', 'green');
          void go();
        })
        .catch((err) => paintLogin(root, null, errText(err)));
    }),
  );
}

/* ----------------------------------------------------------------- router */

let rendering = 0;

async function go(): Promise<void> {
  const root = must('#admMain');
  const { id, params } = route();
  paintSession();
  if (!adminSession()) {
    paintNav('');
    unmountDashboard();
    paintLogin(root);
    return;
  }
  paintNav(id);
  if (id !== 'dashboard') unmountDashboard();
  const section = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]!;
  document.title = `Stonkz Admin · ${section.label}`;
  const token = ++rendering;
  render(root, html`<div class="empty">LOADING ${section.label.toUpperCase()}…</div>`);
  try {
    await section.render(root, params);
  } catch (err) {
    if (token !== rendering) return;
    if (!adminSession()) {
      paintLogin(root, null, 'Admin session ended. Sign in again.');
      return;
    }
    render(root, html`<div class="errbox">${errText(err)}</div>`);
  }
}

function boot(): void {
  initAdminWallets();
  onSessionChange(() => void go());
  window.addEventListener('hashchange', () => void go());
  must('#admNavToggle').addEventListener('click', () => {
    const nav = must('#admNav');
    nav.classList.toggle('collapsed');
    must('#admNavToggle').setAttribute(
      'aria-expanded',
      nav.classList.contains('collapsed') ? 'false' : 'true',
    );
  });
  if (window.matchMedia('(max-width: 820px)').matches) must('#admNav').classList.add('collapsed');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isDialogOpen()) closeDialog();
      return;
    }
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey || isDialogOpen()) return;
    if (e.key === '/') {
      e.preventDefault();
      (
        document.querySelector(
          '#admMain input, #admMain select, #admMain textarea',
        ) as HTMLElement | null
      )?.focus();
      return;
    }
    const s = SECTIONS.find((x) => x.key === e.key);
    if (s && adminSession()) location.hash = `#/${s.id}`;
  });
  void go();
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
