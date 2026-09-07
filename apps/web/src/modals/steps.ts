import type { Net } from '@stonkz/shared';
import { SignerCancelledError, signAndConfirm, type UiStep } from '../app/signer.js';
import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { html, render } from '../lib/html.js';
import { WalletError, describeWalletError, isRejection } from '../wallet/index.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * The non-atomic transaction walker.
 *
 * `POST /trade/prepare` on Robinhood Chain (still, as of this phase —
 * `docs/rh-trade-atomicity-gap.md` §"Status: closed on the contract side,
 * open on the API side") returns an ordered `EvmStep[]` with `atomic: false`
 * and a `warning` explaining that stopping partway leaves the trader holding
 * an intermediate asset, not their original ETH. This modal is the one place
 * that plan requirement lives: every step is its own explicit click — never
 * an automatic loop — the warning stays pinned and visible for the whole
 * walk, and the header always says "STEP X OF N", never "confirm" as if it
 * were one action. `doLaunch`'s Robinhood dev-buy follow-up call and a
 * multi-symbol fee claim reuse it too — anything this app ever asks for more
 * than one signature in a row goes through here, atomic Solana single-step
 * flows never do.
 *
 * As of Phase B each step signs and broadcasts for real (`app/signer.ts`), so
 * "CONFIRMING ON CHAIN" is a genuine wait and a failed step pins the wallet's
 * or the chain's own reason above the button instead of one generic
 * "SIGNING FAILED" toast. A step that reverts leaves the walk exactly where
 * it was, retryable, because the earlier steps really did land.
 */

interface StepsState {
  net: Net;
  title: string;
  steps: UiStep[];
  warning: string | undefined;
  index: number;
  signing: boolean;
  /** The last real wallet/chain failure, pinned above the button. */
  error: string | undefined;
  resolve: (v: { signature: string }) => void;
  reject: (err: unknown) => void;
}

let st: StepsState | null = null;

function stepRow(s: UiStep, i: number, index: number): ReturnType<typeof html> {
  const mark = i < index ? '\u2713' : String(i + 1);
  return html`<li style="display:flex;gap:10px;align-items:center;padding:5px 0;opacity:${i > index ? '.55' : '1'}"
    ><b style="width:20px;text-align:center;flex:none">${mark}</b><span>${s.description}</span></li>`;
}

function renderSteps(): void {
  if (!st) return;
  const { steps, index, warning, title, signing, error } = st;
  const cur = steps[index] as UiStep;
  render(
    must('#txBody'),
    html`${warning
        ? html`<p class="hint" style="border:1px solid #ffa22b;border-radius:8px;padding:9px 10px;color:#ffa22b;margin-bottom:12px">${warning}</p>`
        : ''}<p class="hint" style="margin-bottom:8px">${title}</p>
      <ol style="list-style:none;margin:0 0 14px;padding:0">${steps.map((s, i) => stepRow(s, i, index))}</ol>
      ${error ? html`<p class="wp-err" style="margin-bottom:10px">${error}</p>` : ''}
      <p class="hint" style="margin-bottom:10px">STEP ${index + 1} OF ${steps.length} &#183; ${cur.description}</p>
      <button type="button" class="big" id="steps-go"${signing ? ' disabled' : ''}>${
        signing
          ? 'CONFIRMING ON CHAIN\u2026'
          : (error ? 'RETRY STEP ' : 'SIGN STEP ') + (index + 1) + ' OF ' + steps.length
      }</button>
      <button type="button" class="back" id="steps-cancel" style="width:100%;margin-top:8px">CANCEL</button>`,
  );
  refreshScrim('#txScrim');
  must('#steps-go').addEventListener('click', () => void advance());
  must('#steps-cancel').addEventListener('click', () => closeSteps());
}

/**
 * Run one step: its optional prepare call, then either an off-chain
 * signature or a real broadcast-and-confirm.
 */
async function signStep(net: Net, step: UiStep): Promise<{ signature: string }> {
  await step.run?.();
  if (step.signOffChain) return { signature: await step.signOffChain() };
  const payload = step.payload?.() ?? null;
  if (!payload) {
    // Every real caller supplies a payload; reaching here means a plan shape
    // this build does not understand, which must not look like a success.
    throw new WalletError('unknown', 'This step has nothing to sign — the API returned a plan this build cannot walk.');
  }
  return signAndConfirm(net, payload);
}

async function advance(): Promise<void> {
  if (!st || st.signing) return;
  const net = st.net;
  const step = st.steps[st.index];
  if (!step) return;
  st.signing = true;
  renderSteps();
  try {
    const result = await signStep(net, step);
    if (!st) return; // cancelled mid-sign
    if (st.index >= st.steps.length - 1) {
      const resolve = st.resolve;
      settle();
      resolve(result);
      return;
    }
    st.index++;
    st.signing = false;
    renderSteps();
  } catch (err) {
    if (!st) return;
    st.signing = false;
    st.error = describeWalletError(err);
    renderSteps();
    // A declined prompt is not a failure to retry past — the trader chose it,
    // and on a multi-step plan they are now holding an intermediate asset,
    // which is exactly what `warning` already told them.
    if (isRejection(err)) {
      const reject = st.reject;
      settle();
      reject(err);
      return;
    }
    toast(describeWalletError(err), 'red');
  }
}

function settle(): void {
  closeScrim('#txScrim');
  st = null;
}

/** Backs out of an in-flight walk (Escape, the backdrop, or the header X). */
export function closeSteps(): void {
  if (!st) return;
  const reject = st.reject;
  settle();
  reject(new SignerCancelledError());
}

export function isStepsOpen(): boolean {
  return isOpen('#txScrim');
}

/**
 * Opens the walker and resolves once every step has been signed and
 * "confirmed", or rejects with `SignerCancelledError` if the trader backs
 * out. `title` is the one-line summary above the step list (e.g. `BUY DOGE
 * \u00B7 ROBINHOOD CHAIN`); `warning` is `plan.warning` from `/trade/prepare`,
 * shown verbatim when the caller has one.
 */
export function openSteps(
  net: Net,
  title: string,
  steps: UiStep[],
  warning: string | undefined,
  opener?: Element | null,
): Promise<{ signature: string }> {
  return new Promise((resolve, reject) => {
    st = { net, title, steps, warning, index: 0, signing: false, error: undefined, resolve, reject };
    openScrim('#txScrim', opener);
    renderSteps();
  });
}

export function initSteps(): void {
  wireBackdrop('#txScrim', () => closeSteps());
}
