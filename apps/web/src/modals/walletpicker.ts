import type { Net } from '@stonkz/shared';
import qrcode from 'qrcode-generator';
import { $, must } from '../lib/dom.js';
import { attr, html, render } from '../lib/html.js';
import {
  availableWallets,
  chainLabel,
  connectWalletFor,
  describeWalletError,
  onAvailableWalletsChange,
  type ConnectedWallet,
  type WalletChoice,
} from '../wallet/index.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * The wallet picker.
 *
 * Replaces the header's old 460ms "CONNECTING SOLANA..." pause — which was
 * theatre in front of a keypair that was already in `localStorage` — with the
 * real thing: which wallets this browser actually has, one click to authorise
 * one of them, and, for WalletConnect, the pairing QR a mobile-only Robinhood
 * Wallet needs (`docs/robinhood-chain.md` row 32).
 *
 * The QR is drawn into a `<canvas>` rather than injected as SVG, which keeps
 * it inside the same `img-src`/`script-src 'self'` CSP the rest of the
 * terminal lives under and out of `lib/html.ts`'s escaping path entirely.
 */

type Phase =
  | { t: 'pick' }
  | { t: 'connecting'; choice: WalletChoice }
  | { t: 'pairing'; choice: WalletChoice; uri: string }
  | { t: 'error'; message: string };

interface PickerState {
  net: Net;
  phase: Phase;
  resolve: (w: ConnectedWallet) => void;
  reject: (err: unknown) => void;
  abort: AbortController;
  offWalletsChange: () => void;
}

let st: PickerState | null = null;

export class WalletPickerCancelledError extends Error {
  constructor() {
    super('wallet selection cancelled');
    this.name = 'WalletPickerCancelledError';
  }
}

function choiceRow(c: WalletChoice): ReturnType<typeof html> {
  const disabled = !!c.unavailable;
  return html`<button
    type="button"
    class="wp-item${disabled ? ' off' : ''}"
    data-wallet="${attr(c.id)}"
    ${disabled ? html`disabled aria-describedby="wp-why-${attr(c.id)}"` : ''}
  >
    ${c.icon ? html`<img class="wp-ic" src="${attr(c.icon)}" alt="" width="26" height="26">` : html`<i class="wp-ic"></i>`}
    <span class="wp-nm"
      >${c.name}${c.kind === 'practice' ? html`<em class="wp-tag">PRACTICE</em>` : ''}${c.kind ===
    'evm-walletconnect'
      ? html`<em class="wp-tag wc">QR</em>`
      : ''}</span
    >
    <span class="wp-go">&#8250;</span>
  </button>
  ${disabled ? html`<p class="hint wp-why" id="wp-why-${attr(c.id)}">${c.unavailable}</p>` : ''}`;
}

function drawQr(uri: string): void {
  const canvas = $<HTMLCanvasElement>('#wp-qr');
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  // `0` is auto version selection; `L` keeps the module count low, which
  // matters because a `wc:` URI with a relay query string is long.
  const qr = qrcode(0, 'L');
  qr.addData(uri, 'Byte');
  qr.make();
  const cell = 4;
  const margin = 4;
  const size = (qr.getModuleCount() + margin * 2) * cell;
  canvas.width = size;
  canvas.height = size;
  ctx.fillStyle = '#cac6ba';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  ctx.translate(margin * cell, margin * cell);
  qr.renderTo2dContext(ctx, cell);
}

function renderPicker(): void {
  if (!st) return;
  const { net, phase } = st;
  const body = must('#walletBody');

  if (phase.t === 'connecting') {
    render(
      body,
      html`<p class="hint" style="margin-bottom:10px">${chainLabel(net)}</p>
        <p class="wp-wait">WAITING FOR ${phase.choice.name.toUpperCase()}&hellip;</p>
        <p class="hint" style="margin-top:8px">APPROVE THE CONNECTION IN YOUR WALLET.</p>
        <button type="button" class="back" id="wp-cancel" style="width:100%;margin-top:12px">CANCEL</button>`,
    );
  } else if (phase.t === 'pairing') {
    render(
      body,
      html`<p class="hint" style="margin-bottom:10px">
          SCAN WITH ROBINHOOD WALLET (OR ANY WALLETCONNECT WALLET) &#183; ${chainLabel(net)}
        </p>
        <div class="wp-qrwrap"><canvas id="wp-qr" aria-label="WalletConnect pairing QR code"></canvas></div>
        <a class="wp-deep" id="wp-deep" href="${attr(phase.uri)}">OPEN IN A WALLET ON THIS DEVICE</a>
        <button type="button" class="back" id="wp-copy" style="width:100%;margin-top:8px">COPY PAIRING LINK</button>
        <button type="button" class="back" id="wp-cancel" style="width:100%;margin-top:6px">CANCEL</button>`,
    );
    drawQr(phase.uri);
  } else if (phase.t === 'error') {
    render(
      body,
      html`<p class="wp-err">${phase.message}</p>
        <button type="button" class="big" id="wp-retry">BACK TO WALLETS</button>
        <button type="button" class="back" id="wp-cancel" style="width:100%;margin-top:8px">CANCEL</button>`,
    );
  } else {
    const choices = availableWallets(net);
    render(
      body,
      html`<p class="hint" style="margin-bottom:10px">${chainLabel(net)}</p>
        ${choices.length === 0
          ? html`<p class="wp-err">
              ${net === 'SOL'
                ? 'NO SOLANA WALLET DETECTED. INSTALL PHANTOM, SOLFLARE OR BACKPACK AND RELOAD.'
                : 'NO ROBINHOOD CHAIN WALLET AVAILABLE.'}
            </p>`
          : html`<div class="wp-list">${choices.map(choiceRow)}</div>`}
        <button type="button" class="back" id="wp-cancel" style="width:100%;margin-top:10px">CANCEL</button>`,
    );
  }

  refreshScrim('#walletScrim');
  $('#wp-cancel')?.addEventListener('click', () => cancelPicker());
  $('#wp-retry')?.addEventListener('click', () => {
    if (!st) return;
    st.phase = { t: 'pick' };
    renderPicker();
  });
  $('#wp-copy')?.addEventListener('click', () => {
    if (st?.phase.t !== 'pairing') return;
    void navigator.clipboard?.writeText(st.phase.uri).catch(() => undefined);
  });
  for (const btn of body.querySelectorAll<HTMLElement>('[data-wallet]')) {
    btn.addEventListener('click', () => void pick(btn.dataset['wallet'] as string));
  }
}

async function pick(id: string): Promise<void> {
  if (!st) return;
  const choice = availableWallets(st.net).find((c) => c.id === id);
  if (!choice || choice.unavailable) return;
  st.phase = { t: 'connecting', choice };
  renderPicker();
  const net = st.net;
  try {
    const wallet = await connectWalletFor(net, {
      id,
      onWalletConnectUri: (uri) => {
        if (!st) return;
        st.phase = { t: 'pairing', choice, uri };
        renderPicker();
      },
    });
    if (!st) {
      // Cancelled while the wallet prompt was open — do not leave an
      // authorised-but-unused session behind.
      await wallet.disconnect().catch(() => undefined);
      return;
    }
    const resolve = st.resolve;
    settle();
    resolve(wallet);
  } catch (err) {
    if (!st) return;
    st.phase = { t: 'error', message: describeWalletError(err) };
    renderPicker();
  }
}

function settle(): void {
  st?.offWalletsChange();
  closeScrim('#walletScrim');
  st = null;
}

export function cancelPicker(): void {
  if (!st) return;
  const reject = st.reject;
  st.abort.abort();
  settle();
  reject(new WalletPickerCancelledError());
}

export function isWalletPickerOpen(): boolean {
  return isOpen('#walletScrim');
}

/**
 * Opens the picker and resolves with the connected wallet, or rejects with
 * `WalletPickerCancelledError` if the user backs out.
 */
export function openWalletPicker(net: Net, opener?: Element | null): Promise<ConnectedWallet> {
  cancelPicker();
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    st = {
      net,
      phase: { t: 'pick' },
      resolve,
      reject,
      abort,
      // A wallet extension can announce itself after the picker is already
      // open (EIP-6963 announcements and Wallet Standard registrations are
      // both asynchronous), so keep the list live.
      offWalletsChange: onAvailableWalletsChange(() => {
        if (st?.phase.t === 'pick') renderPicker();
      }),
    };
    openScrim('#walletScrim', opener);
    renderPicker();
  });
}

export function initWalletPicker(): void {
  wireBackdrop('#walletScrim', () => cancelPicker());
}
