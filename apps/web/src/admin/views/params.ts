import {
  ALL_NETS,
  DEFAULT_CURVE_PARAMS,
  feeSplitOf,
  isEvmNet,
  packParamsWord,
  validateCurveParams,
  type CurveParams,
  type Net,
} from '@stonkz/shared';
import { adminSession, get, post } from '../api.js';
import { connectedAddress } from '../auth.js';
import {
  ago,
  busy,
  confirmTyped,
  errText,
  html,
  jsonBlock,
  netTag,
  panel,
  render,
  short,
  toast,
  type Html,
} from '../ui.js';
import { reviewAndSign, type Prepared } from './chain.js';

/**
 * Parameters: the launchpad's runtime tunables per chain — fee split,
 * creator-fee bounds, cashback window, graduation cap, supply cap and the
 * router's per-buy cap — as the API applies them (`GET /admin/chain/params`)
 * and whether they are the contract defaults or an explicit on-chain record.
 *
 * Editing goes through the same prepare → sign-in-wallet flow as Chain ops:
 * the form validates with the contract's own rules (`validateCurveParams`),
 * packs the EVM word client-side (`packParamsWord`) so what is signed is what
 * was shown, and the server re-validates before encoding. Owner role.
 */
interface Effective extends CurveParams {
  net: Net;
  source: 'chain' | 'default';
  set: boolean;
  matchesDefaults: boolean;
  readAt: number;
  error: string | null;
}

interface EvmChain {
  kind: 'evm';
  launchpad: string;
  router: string | null;
  chainId?: number;
  admin?: string | null;
  paramsWord?: string | null;
  trustedRouter?: string | null;
  routerConfig?: {
    maxBuyNative: string | null;
    pyth: string | null;
    attestationSink: string | null;
  } | null;
  error: string | null;
}

interface SolChain {
  kind: 'sol';
  programId: string;
  pda: string;
  params?: { initialised: boolean; gradMcapUsd1e6: string } & Record<string, unknown>;
  error: string | null;
}

interface ParamsView {
  net: Net;
  deployed: boolean;
  effective: Effective;
  chain: EvmChain | SolChain | null;
}

type WordKey =
  | 'feeProtocolBps'
  | 'feeOpsBps'
  | 'feeBurnBps'
  | 'minFeeBps'
  | 'maxFeeBps'
  | 'cbStartFeeBps'
  | 'cbWindowSecs'
  | 'gradUsd'
  | 'maxSupply';

const FIELDS: { key: WordKey; label: string; unit: string; step: string; evmOnly?: boolean }[] = [
  { key: 'feeProtocolBps', label: 'platform (protocol)', unit: 'bps', step: '1' },
  { key: 'feeOpsBps', label: '$STONKZ buyback (ops)', unit: 'bps', step: '1' },
  { key: 'feeBurnBps', label: 'RWA crate fund (burn)', unit: 'bps', step: '1' },
  { key: 'minFeeBps', label: 'min creator fee', unit: 'bps', step: '1' },
  { key: 'maxFeeBps', label: 'max creator fee', unit: 'bps', step: '1' },
  { key: 'cbStartFeeBps', label: 'cashback start fee', unit: 'bps', step: '1' },
  { key: 'cbWindowSecs', label: 'cashback window', unit: 'seconds', step: '1' },
  { key: 'gradUsd', label: 'graduation cap', unit: 'USD', step: '0.000001' },
  { key: 'maxSupply', label: 'max supply', unit: 'whole tokens', step: '1', evmOnly: true },
];

const isOwner = (): boolean => adminSession()?.role === 'owner';

const pct = (bps: number): string => (bps / 100).toFixed(bps % 100 ? 2 : 0) + '%';

function weiToNative(wei: string | null | undefined): string {
  if (!wei || !/^[0-9]+$/.test(wei)) return '—';
  if (wei === '0') return 'uncapped';
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac.slice(0, 6) : ''} native (${wei} wei)`;
}

function splitBar(p: CurveParams): Html {
  const s = feeSplitOf(p);
  const legs: [string, number, string][] = [
    ['creator', s.creatorBucket, 'creator bucket'],
    ['protocol', s.protocol, 'platform'],
    ['buyback', s.buyback, '$STONKZ buyback'],
    ['rwa', s.rwa, 'RWA crates'],
  ];
  return html`<div class="split-bar" role="img" aria-label="fee split">
      ${legs.map(([k, v]) => html`<i class="s-${k}" data-w="${(v * 100).toFixed(2)}"></i>`)}
    </div>
    <div>
      ${legs.map(([k, v, label]) => html`<span class="split-leg"><i class="s-${k}"></i>${label} ${(v * 100).toFixed((v * 100) % 1 ? 2 : 0)}%</span>`)}
    </div>`;
}

/** CSP forbids inline styles: widths are set from `data-w` after render. */
function sizeSplitBars(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.split-bar i[data-w]').forEach((i) => {
    i.style.flexBasis = `${i.dataset['w']}%`;
  });
}

function effectiveList(v: ParamsView): Html {
  const e = v.effective;
  return html`<dl class="kv">
    <dt>status</dt>
    <dd>
      ${e.source === 'chain' ? html`<span class="tag on">read from chain</span>` : html`<span class="tag warn">defaults (fallback)</span>`}
      ${e.set ? html`<span class="tag info">set on chain</span>` : html`<span class="tag">never set · contract defaults</span>`}
      ${e.matchesDefaults ? html`<span class="tag">= defaults</span>` : html`<span class="tag warn">differs from defaults</span>`}
    </dd>
    ${
      e.error
        ? html`<dt>note</dt>
            <dd class="dm">${e.error}</dd>`
        : ''
    }
    <dt>fee split</dt>
    <dd>${splitBar(e)}</dd>
    <dt>creator fee</dt>
    <dd>${pct(e.minFeeBps)} – ${pct(e.maxFeeBps)}</dd>
    <dt>cashback</dt>
    <dd>opens at ${pct(e.cbStartFeeBps)}, decays over ${e.cbWindowSecs}s</dd>
    <dt>graduation</dt>
    <dd>$${e.gradUsd.toLocaleString('en-US')}</dd>
    <dt>max supply</dt>
    <dd>
      ${e.maxSupply.toLocaleString('en-US')}${isEvmNet(v.net) ? '' : html` <span class="dm">(not a Solana field)</span>`}
    </dd>
    <dt>max buy</dt>
    <dd>
      ${weiToNative(e.maxBuyNative)}${isEvmNet(v.net) ? '' : html` <span class="dm">(EVM router only)</span>`}
    </dd>
    <dt>read</dt>
    <dd class="dm">${ago(e.readAt)} · API cache 60s</dd>
  </dl>`;
}

function chainList(v: ParamsView): Html {
  const c = v.chain;
  if (!c) return html``;
  if (c.kind === 'evm') {
    return html`<dl class="kv mt6">
      <dt>launchpad</dt>
      <dd class="mono">${c.launchpad}</dd>
      <dt>router</dt>
      <dd class="mono">${c.router ?? 'not configured'}</dd>
      <dt>trusted router</dt>
      <dd class="mono">
        ${c.trustedRouter === null || c.trustedRouter === undefined ? 'n/a (implementation predates params)' : c.trustedRouter}
      </dd>
      <dt>params word</dt>
      <dd class="mono pword">
        ${c.paramsWord === null || c.paramsWord === undefined ? 'n/a (paramsWord() reverts)' : c.paramsWord}
      </dd>
      ${
        c.routerConfig
          ? html`<dt>router pyth</dt>
              <dd class="mono">${c.routerConfig.pyth ?? 'n/a'}</dd>
              <dt>router attestation sink</dt>
              <dd class="mono">${c.routerConfig.attestationSink ?? 'n/a'}</dd>`
          : ''
      }
      ${
        c.error
          ? html`<dt>error</dt>
              <dd class="dn">${c.error}</dd>`
          : ''
      }
    </dl>`;
  }
  return html`<dl class="kv mt6">
    <dt>program</dt>
    <dd class="mono">${c.programId}</dd>
    <dt>params PDA</dt>
    <dd class="mono">
      ${c.pda}
      ${c.params?.initialised ? html`<span class="tag on">exists</span>` : html`<span class="tag">absent</span>`}
    </dd>
    ${
      c.error
        ? html`<dt>error</dt>
            <dd class="dn">${c.error}</dd>`
        : ''
    }
  </dl>`;
}

/* ------------------------------------------------------------------ forms */

function readForm(box: ParentNode, base: CurveParams): CurveParams {
  const out: CurveParams = { ...base };
  for (const f of FIELDS) {
    const el = box.querySelector<HTMLInputElement>(`[data-p="${f.key}"]`);
    if (!el) continue;
    const n = Number(el.value);
    out[f.key] = Number.isFinite(n) ? n : Number.NaN;
  }
  return out;
}

function paramsForm(v: ParamsView): Html {
  const evm = isEvmNet(v.net);
  const e = v.effective;
  return html`<div class="pgrid" data-pform>
      ${FIELDS.filter((f) => evm || !f.evmOnly).map(
        (f) =>
          html`<label
            ><span class="lbl">${f.label} <span class="unit">${f.unit}</span></span
            ><input
              class="fld"
              type="number"
              data-p="${f.key}"
              step="${f.step}"
              min="0"
              value="${String(e[f.key])}"
              autocomplete="off"
          /></label>`,
      )}
    </div>
    <div data-preview></div>
    <div class="errbox" data-errs hidden></div>
    <div class="btns">
      <button type="button" class="btn ghost sm" data-defaults>Fill contract defaults</button>
      <span class="grow"></span>
      <button type="button" class="btn go" data-prepare-params disabled>
        Prepare ${evm ? 'setParams' : 'set_params'} →
      </button>
    </div>
    <p class="hint">
      ${
        evm
          ? 'Packed into one uint256 in the browser (the same word the contract stores); the server unpacks and re-validates before encoding setParams(uint256).'
          : 'Encoded as set_params(ParamsArgs); max supply and max buy are not Solana fields.'
      }
      Rules: protocol + ops + burn ≤ 10000 · min ≤ max ≤ cashback start ≤ 10000 · max > 0 · window >
      0 · graduation > 0 · supply in (0, 1e12].
    </p>`;
}

function routerForm(v: ParamsView): Html {
  const c = v.chain?.kind === 'evm' ? v.chain : null;
  const cfg = c?.routerConfig;
  return html`<div class="pgrid" data-rform>
      <label
        ><span class="lbl">max buy <span class="unit">wei · 0 = uncapped</span></span
        ><input
          class="fld"
          data-r="maxBuyNative"
          value="${cfg?.maxBuyNative ?? v.effective.maxBuyNative}"
          autocomplete="off"
          spellcheck="false"
      /></label>
      <label
        ><span class="lbl">pyth <span class="unit">address</span></span
        ><input
          class="fld"
          data-r="pyth"
          value="${cfg?.pyth ?? ''}"
          autocomplete="off"
          spellcheck="false"
      /></label>
      <label
        ><span class="lbl">attestation sink <span class="unit">address</span></span
        ><input
          class="fld"
          data-r="attestationSink"
          value="${cfg?.attestationSink ?? ''}"
          autocomplete="off"
          spellcheck="false"
      /></label>
    </div>
    <div class="btns">
      <span class="grow"></span>
      <button type="button" class="btn go" data-prepare-router ${c?.router ? '' : 'disabled'}>
        Prepare router.setConfig →
      </button>
    </div>
    <p class="hint">
      ${
        c?.router
          ? html`Targets the router <span class="mono">${short(c.router, 8)}</span>; gated on-chain
              to the launchpad admin. A router that predates setConfig reverts (its maxBuyNative()
              still reads).`
          : 'No StonkzRouter is configured for this net in this environment.'
      }
    </p>`;
}

/* ---------------------------------------------------------------- actions */

async function prepareAndSign(
  net: Net,
  action: Record<string, unknown>,
  summary: Html,
  refresh: () => Promise<void>,
): Promise<void> {
  const signer = connectedAddress();
  if (!signer) return toast('connect a wallet first', 'red');
  const kind = String(action['kind']);
  const phrase = `PREPARE ${kind}`;
  if (!(await confirmTyped('Prepare transaction', phrase, summary))) return;
  let prepared: Prepared;
  try {
    prepared = await post<Prepared>(`/admin/chain/prepare/${net}`, {
      action,
      signer,
      confirm: phrase,
    });
  } catch (err) {
    return toast(errText(err), 'red');
  }
  await reviewAndSign(prepared, refresh);
}

function wireNet(card: HTMLElement, v: ParamsView, refresh: () => Promise<void>): void {
  const evm = isEvmNet(v.net);
  const form = card.querySelector<HTMLElement>('[data-pform]');
  const preview = card.querySelector<HTMLElement>('[data-preview]');
  const errs = card.querySelector<HTMLElement>('[data-errs]');
  const go = card.querySelector<HTMLButtonElement>('[data-prepare-params]');
  if (!form || !preview || !errs || !go) return;

  let current: CurveParams = { ...v.effective };
  const sync = (): void => {
    current = readForm(form, {
      ...v.effective,
      // Solana has no supply field; validate it as the default so it cannot fail.
      ...(evm ? {} : { maxSupply: DEFAULT_CURVE_PARAMS.maxSupply }),
    });
    const problems = validateCurveParams({ ...current, maxBuyNative: '0' });
    let word: bigint | null = null;
    if (evm && problems.length === 0) {
      try {
        word = packParamsWord(current);
      } catch (err) {
        problems.push(errText(err));
      }
    }
    render(
      preview,
      html`${problems.length === 0 ? splitBar(current) : ''}
      ${
        word !== null
          ? html`<span class="lbl">word</span>
              <div class="mono pword">${word.toString()}</div>`
          : ''
      }`,
    );
    sizeSplitBars(preview);
    errs.hidden = problems.length === 0;
    render(errs, html`${problems.map((p) => html`<div>${p}</div>`)}`);
    go.disabled = problems.length > 0 || !isOwner();
  };
  form.addEventListener('input', sync);
  card.querySelector('[data-defaults]')?.addEventListener('click', () => {
    for (const f of FIELDS) {
      const el = form.querySelector<HTMLInputElement>(`[data-p="${f.key}"]`);
      if (el) el.value = String(DEFAULT_CURVE_PARAMS[f.key]);
    }
    sync();
  });
  sync();

  go.addEventListener('click', () =>
    busy(go, async () => {
      sync();
      if (go.disabled) return;
      if (evm) {
        const word = packParamsWord(current).toString();
        await prepareAndSign(
          v.net,
          { kind: 'setParams', word },
          html`<b>setParams</b> on ${v.net}: ${jsonBlock({ ...current, maxBuyNative: undefined })}
            <span class="lbl">word</span>
            <div class="mono pword">${word}</div>`,
          refresh,
        );
      } else {
        const params = {
          feeProtocolBps: current.feeProtocolBps,
          feeOpsBps: current.feeOpsBps,
          feeBurnBps: current.feeBurnBps,
          minFeeBps: current.minFeeBps,
          maxFeeBps: current.maxFeeBps,
          cbStartFeeBps: current.cbStartFeeBps,
          cbWindowSecs: current.cbWindowSecs,
          gradMcapUsd1e6: BigInt(Math.round(current.gradUsd * 1e6)).toString(),
        };
        await prepareAndSign(
          v.net,
          { kind: 'set_params', params },
          html`<b>set_params</b> on SOL: ${jsonBlock(params)}`,
          refresh,
        );
      }
    }),
  );

  const rgo = card.querySelector<HTMLButtonElement>('[data-prepare-router]');
  if (rgo && evm) {
    if (!isOwner()) rgo.disabled = true;
    rgo.addEventListener('click', () =>
      busy(rgo, async () => {
        const val = (k: string): string =>
          card.querySelector<HTMLInputElement>(`[data-r="${k}"]`)?.value.trim() ?? '';
        const action = {
          kind: 'setRouterConfig',
          maxBuyNative: val('maxBuyNative'),
          pyth: val('pyth'),
          attestationSink: val('attestationSink'),
        };
        if (!/^[0-9]+$/.test(action.maxBuyNative))
          return toast('max buy must be a whole number of wei (0 = uncapped)', 'red');
        if (
          !/^0x[0-9a-fA-F]{40}$/.test(action.pyth) ||
          !/^0x[0-9a-fA-F]{40}$/.test(action.attestationSink)
        )
          return toast('pyth and attestation sink must be EVM addresses', 'red');
        await prepareAndSign(
          v.net,
          action,
          html`<b>router.setConfig</b> on ${v.net}: ${jsonBlock(action)}
            (${weiToNative(action.maxBuyNative)})`,
          refresh,
        );
        return undefined;
      }),
    );
  }
}

/* ------------------------------------------------------------------- view */

export async function renderParams(root: HTMLElement): Promise<void> {
  const views = await Promise.all(
    ALL_NETS.map((net) =>
      get<ParamsView>(`/admin/chain/params/${net}`).catch((err): ParamsView => ({
        net,
        deployed: false,
        effective: {
          ...DEFAULT_CURVE_PARAMS,
          net,
          source: 'default',
          set: false,
          matchesDefaults: true,
          readAt: 0,
          error: errText(err),
        },
        chain: null,
      })),
    ),
  );
  const refresh = (): Promise<void> => renderParams(root);
  render(
    root,
    html`<div class="sec-hd">
        <h1>Parameters</h1>
        <span class="sub"
          >launchpad tunables per chain · what the API quotes and validates with ·
          ${isOwner() ? 'owner: you can prepare changes' : 'owner role prepares changes'}</span
        ><span class="grow"></span
        ><button type="button" class="btn ghost sm" id="paramsRefresh">Refresh</button>
      </div>
      <p class="hint mb10">
        The API reads these from chain every 60 s (defaults when a view reverts or the RPC is down)
        and the terminal picks them up from <span class="mono">GET /platform/status</span>. Changing
        them is a signed admin transaction: the form below prepares it, your wallet signs, and the
        audit log keeps both halves.
      </p>
      <div class="grid c2">
        ${views.map((v) =>
          panel(
            v.net,
            html`<div data-net="${v.net}">
              ${
                v.deployed
                  ? html`${effectiveList(v)}${chainList(v)}
                      <div class="mt10">
                        <span class="lbl">${isEvmNet(v.net) ? 'setParams' : 'set_params'}</span
                        >${paramsForm(v)}
                      </div>
                      ${isEvmNet(v.net) ? html`<div class="mt10"><span class="lbl">router config</span>${routerForm(v)}</div>` : ''}`
                  : html`<div class="empty">NOT DEPLOYED ON THIS ENVIRONMENT</div>
                      ${effectiveList(v)}`
              }
            </div>`,
            v.deployed
              ? v.chain?.kind === 'evm'
                ? `chain ${v.chain.chainId ?? ''}`
                : 'solana'
              : undefined,
            netTag(v.net),
          ),
        )}
      </div>`,
  );
  sizeSplitBars(root);
  root.querySelector('#paramsRefresh')?.addEventListener('click', () => void refresh());
  for (const v of views) {
    const card = root.querySelector<HTMLElement>(`[data-net="${v.net}"]`);
    if (card && v.deployed) wireNet(card, v, refresh);
  }
}
