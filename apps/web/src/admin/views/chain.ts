import { ALL_NETS, isEvmNet, type Net } from '@stonkz/shared';
import type { SignPayload } from '../../wallet/index.js';
import { adminSession, get, post } from '../api.js';
import { connectedAddress, signPrepared } from '../auth.js';
import {
  ago,
  busy,
  checked,
  confirmTyped,
  dialog,
  downloadText,
  errText,
  html,
  jsonBlock,
  netTag,
  num,
  onOff,
  panel,
  promptText,
  render,
  short,
  table,
  toast,
  val,
  when,
  type Html,
} from '../ui.js';

/**
 * Chain ops: live admin state per net, treasury vaults, oracle legs, indexer
 * cursors, and the prepare → sign-in-wallet → report flow. The server only
 * ever prepares; the connected browser wallet signs.
 */
interface NetState {
  net: Net;
  deployed: boolean;
  cursor: number;
  launchpad?: string;
  programId?: string;
  chainId?: number;
  treasuries: { kind: string; nativeBalance: number; lifetimeCredited: number }[];
  state: Record<string, unknown> | null;
  error: string | null;
}
export interface Prepared {
  ok: true;
  net: Net;
  kind: string;
  tx: {
    to?: string;
    data?: string;
    value?: string;
    transaction?: string;
    lastValidBlockHeight?: number;
    summary: string;
    signer: string;
    chainId?: number;
  };
  safe?: Record<string, unknown>;
}

const EVM_ACTIONS: {
  kind: string;
  label: string;
  fields: [string, string, 'text' | 'bool' | 'number'][];
  owner?: boolean;
}[] = [
  {
    kind: 'setPause',
    label: 'setPause (admin: set every flag)',
    fields: [
      ['trading', 'trading paused', 'bool'],
      ['launch', 'launch paused', 'bool'],
      ['protocolWithdrawals', 'protocol withdrawals paused', 'bool'],
      ['opsWithdrawals', 'ops withdrawals paused', 'bool'],
      ['oracleGraduation', 'oracle graduation paused', 'bool'],
    ],
  },
  {
    kind: 'pause',
    label: 'pause (pauser: set-only emergency stop)',
    fields: [
      ['trading', 'trading', 'bool'],
      ['launch', 'launch', 'bool'],
      ['protocolWithdrawals', 'protocol withdrawals', 'bool'],
      ['opsWithdrawals', 'ops withdrawals', 'bool'],
      ['oracleGraduation', 'oracle graduation', 'bool'],
    ],
  },
  {
    kind: 'setPauser',
    label: 'setPauser',
    fields: [['pauser', 'pauser address (0x0 removes)', 'text']],
  },
  {
    kind: 'setPriceSource',
    label: 'setPriceSource',
    fields: [['source', 'IPriceSource address', 'text']],
    owner: true,
  },
  {
    kind: 'setMaxOracleStaleness',
    label: 'setMaxOracleStaleness',
    fields: [['seconds', 'seconds', 'number']],
  },
  {
    kind: 'setMigrator',
    label: 'setMigrator',
    fields: [
      ['migrator', 'migrator contract', 'text'],
      ['authority', 'migration authority', 'text'],
    ],
    owner: true,
  },
  {
    kind: 'setWithdrawAuthorities',
    label: 'setWithdrawAuthorities',
    fields: [
      ['protocol', 'protocol authority', 'text'],
      ['ops', 'ops authority', 'text'],
    ],
    owner: true,
  },
  {
    kind: 'proposeAdmin',
    label: 'proposeAdmin',
    fields: [['admin', 'new admin (timelock / Safe)', 'text']],
    owner: true,
  },
  { kind: 'acceptAdmin', label: 'acceptAdmin (signed by the pending admin)', fields: [] },
  {
    kind: 'setTrustedRouter',
    label: 'setTrustedRouter (the StonkzRouter the launchpad trusts)',
    fields: [['router', 'router address', 'text']],
    owner: true,
  },
  {
    kind: 'withdrawTreasury',
    label: 'withdrawTreasury',
    fields: [
      ['which', '0 protocol · 1 ops · 2 rwa', 'number'],
      ['baseToken', 'base token', 'text'],
      ['amountAtoms', 'amount (atoms)', 'text'],
      ['to', 'recipient', 'text'],
    ],
    owner: true,
  },
  {
    kind: 'pushPrice',
    label: 'pushPrice (oracle authority → PushPriceSource)',
    fields: [
      ['source', 'PushPriceSource address', 'text'],
      ['baseToken', 'base token', 'text'],
      ['price1e6', 'price × 1e6', 'text'],
      ['conf1e6', 'confidence × 1e6', 'text'],
    ],
  },
];
const SOL_ACTIONS: typeof EVM_ACTIONS = [
  {
    kind: 'set_pause',
    label: 'set_pause (admin: each flag optional)',
    fields: [
      ['trading', 'trading (true/false/blank)', 'text'],
      ['launch', 'launch', 'text'],
      ['protocolWithdrawals', 'protocol withdrawals', 'text'],
      ['opsWithdrawals', 'ops withdrawals', 'text'],
    ],
  },
  {
    kind: 'pause',
    label: 'pause (pauser: set-only)',
    fields: [
      ['trading', 'trading', 'bool'],
      ['launch', 'launch', 'bool'],
      ['protocolWithdrawals', 'protocol withdrawals', 'bool'],
      ['opsWithdrawals', 'ops withdrawals', 'bool'],
    ],
  },
  {
    kind: 'set_pauser',
    label: 'set_pauser',
    fields: [['pauser', 'pauser pubkey (11111111111111111111111111111111 removes)', 'text']],
  },
  {
    kind: 'set_oracle_authority',
    label: 'set_oracle_authority',
    fields: [['authority', 'oracle authority', 'text']],
    owner: true,
  },
  {
    kind: 'set_max_oracle_staleness',
    label: 'set_max_oracle_staleness',
    fields: [['seconds', 'seconds', 'number']],
  },
  {
    kind: 'set_withdraw_authorities',
    label: 'set_withdraw_authorities',
    fields: [
      ['protocol', 'protocol authority (blank keeps)', 'text'],
      ['ops', 'ops authority (blank keeps)', 'text'],
    ],
    owner: true,
  },
  {
    kind: 'propose_admin',
    label: 'propose_admin',
    fields: [['admin', 'new admin', 'text']],
    owner: true,
  },
  { kind: 'accept_admin', label: 'accept_admin (signed by the pending admin)', fields: [] },
  {
    kind: 'withdraw_treasury',
    label: 'withdraw_treasury',
    fields: [
      ['which', '0 protocol · 1 ops · 2 rwa', 'number'],
      ['baseMint', 'base mint', 'text'],
      ['amountAtoms', 'amount (atoms)', 'text'],
      ['to', 'recipient wallet (ATA derived)', 'text'],
    ],
    owner: true,
  },
  {
    kind: 'push_price',
    label: 'push_price (oracle authority)',
    fields: [
      ['baseMint', 'base mint', 'text'],
      ['price1e6', 'price × 1e6', 'text'],
      ['conf1e6', 'confidence × 1e6', 'text'],
    ],
  },
];

const isOwner = (): boolean => adminSession()?.role === 'owner';
const canPrepare = (): boolean => ['owner', 'admin'].includes(adminSession()?.role ?? '');

function pausedTags(p: Record<string, boolean> | undefined): Html {
  if (!p) return html`<span class="dm">—</span>`;
  return html`${Object.entries(p).map(([k, v]) => (v ? html`<span class="tag off">${k} PAUSED</span>` : html`<span class="tag on">${k}</span>`))}`;
}

async function prepareFlow(n: NetState, refresh: () => Promise<void>): Promise<void> {
  const actions = isEvmNet(n.net) ? EVM_ACTIONS : SOL_ACTIONS;
  const chosen = await dialog<{ kind: string; args: Record<string, unknown> }>(
    `Prepare on ${n.net}`,
    (done) => {
      queueMicrotask(() => {
        const sel = document.getElementById('paKind') as HTMLSelectElement | null;
        const fieldsBox = document.getElementById('paFields');
        const paint = (): void => {
          const a = actions.find((x) => x.kind === sel?.value);
          if (!a || !fieldsBox) return;
          render(
            fieldsBox,
            html`${a.owner && !isOwner() ? html`<div class="warnbox">owner role required for ${a.kind}</div>` : ''}
            ${a.fields.map(([key, label, type]) =>
              type === 'bool'
                ? html`<label class="chk"
                    ><input type="checkbox" data-f="${key}" /> ${label}</label
                  >`
                : html`<label
                    ><span class="lbl">${label}</span
                    ><input
                      class="fld"
                      data-f="${key}"
                      type="${type === 'number' ? 'number' : 'text'}"
                      autocomplete="off"
                      spellcheck="false"
                  /></label>`,
            )}`,
          );
        };
        sel?.addEventListener('change', paint);
        paint();
        document.querySelector('[data-pa-go]')?.addEventListener('click', () => {
          const a = actions.find((x) => x.kind === sel?.value);
          if (!a) return;
          const args: Record<string, unknown> = {};
          for (const [key, , type] of a.fields) {
            const el = document.querySelector<HTMLInputElement>(`[data-f="${key}"]`);
            if (!el) continue;
            if (type === 'bool') args[key] = el.checked;
            else if (type === 'number') args[key] = Number(el.value);
            else if (a.kind === 'set_pause') {
              const v = el.value.trim().toLowerCase();
              if (v === 'true' || v === 'false') args[key] = v === 'true';
            } else if (a.kind === 'set_withdraw_authorities') {
              if (el.value.trim()) args[key] = el.value.trim();
            } else args[key] = el.value.trim();
          }
          done({ kind: a.kind, args });
        });
      });
      return html`<label
          ><span class="lbl">Action</span
          ><select id="paKind" class="fld dark">
            ${actions.map((a) => html`<option value="${a.kind}">${a.label}</option>`)}
          </select></label
        >
        <div id="paFields" class="pnl-bd p0"></div>
        <p class="hint">
          The server encodes the call and returns it unsigned. Your connected wallet
          (${short(connectedAddress())}) signs; make sure it holds the on-chain role the action
          needs.
        </p>
        <div class="btns">
          <button type="button" class="btn ghost" data-close>Cancel</button
          ><span class="grow"></span
          ><button type="button" class="btn go" data-pa-go>Prepare →</button>
        </div>`;
    },
  );
  if (!chosen) return;
  const signer = connectedAddress();
  if (!signer) return toast('connect a wallet first', 'red');
  const phrase = `PREPARE ${chosen.kind}`;
  if (
    !(await confirmTyped(
      'Prepare transaction',
      phrase,
      html`<b>${chosen.kind}</b> on ${n.net} with ${jsonBlock(chosen.args)}`,
    ))
  )
    return;
  let prepared: Prepared;
  try {
    prepared = await post<Prepared>(`/admin/chain/prepare/${n.net}`, {
      action: { kind: chosen.kind, ...chosen.args },
      signer,
      confirm: phrase,
    });
  } catch (err) {
    return toast(errText(err), 'red');
  }
  await reviewAndSign(prepared, refresh);
}

export async function reviewAndSign(p: Prepared, refresh: () => Promise<void>): Promise<void> {
  await dialog<void>(
    `Sign ${p.kind} · ${p.net}`,
    (done) => {
      queueMicrotask(() => {
        document.querySelector('[data-safe]')?.addEventListener('click', () => {
          downloadText(
            `stonkz-${p.net}-${p.kind}.json`,
            JSON.stringify(p.safe, null, 2),
            'application/json',
          );
        });
        document.querySelector('[data-copy]')?.addEventListener('click', () => {
          void navigator.clipboard
            ?.writeText(p.tx.data ?? p.tx.transaction ?? '')
            .then(() => toast('copied'));
        });
        const signBtn = document.querySelector<HTMLElement>('[data-sign]');
        signBtn?.addEventListener('click', () =>
          busy(signBtn, async () => {
            const payload: SignPayload = isEvmNet(p.net)
              ? { net: p.net, to: p.tx.to ?? '', data: p.tx.data ?? '0x', value: p.tx.value ?? '0' }
              : {
                  net: 'SOL',
                  transaction: p.tx.transaction ?? '',
                  ...(p.tx.lastValidBlockHeight
                    ? { lastValidBlockHeight: p.tx.lastValidBlockHeight }
                    : {}),
                };
            const out = await signPrepared(p.net, payload);
            await post('/admin/chain/submitted', {
              net: p.net,
              kind: p.kind,
              txHash: out.signature,
              summary: p.tx.summary,
            });
            toast(`submitted ${short(out.signature, 10)}`, 'green');
            done(undefined);
            await refresh();
          }),
        );
      });
      return html`<div class="warnbox">
          Must be signed by the on-chain <b>${p.tx.signer}</b>. Your wallet:
          <span class="mono">${connectedAddress() ?? '—'}</span>
        </div>
        <dl class="kv">
          <dt>summary</dt>
          <dd>${p.tx.summary}</dd>
          ${
            p.tx.to
              ? html`<dt>to</dt>
                  <dd class="mono">${p.tx.to}</dd>
                  <dt>chain</dt>
                  <dd>${p.tx.chainId}</dd>`
              : ''
          }
        </dl>
        <span class="lbl">${p.tx.data ? 'calldata' : 'unsigned transaction (base64)'}</span>
        ${jsonBlock(p.tx.data ?? p.tx.transaction ?? '')}
        <div class="btns">
          <button type="button" class="btn ghost" data-copy>Copy</button>
          ${p.safe ? html`<button type="button" class="btn ghost" data-safe>Safe Tx Builder JSON ↓</button>` : ''}
          <span class="grow"></span>
          <button type="button" class="btn ghost" data-close>Later</button>
          <button type="button" class="btn go" data-sign>Sign in wallet</button>
        </div>
        <p class="hint">
          Later: paste the calldata into your Safe / multisig. The prepare is already in the audit
          log; signing reports the hash back.
        </p>`;
    },
    { sub: p.tx.signer },
  );
}

async function renderOracle(box: HTMLElement, net: Net): Promise<void> {
  const o = await get<Record<string, unknown>>(`/admin/chain/oracle/${net}`);
  const legs = (o['legs'] as Record<string, unknown>[]) ?? [];
  render(
    box,
    html`<dl class="kv">
        <dt>feeds</dt>
        <dd>${JSON.stringify(o['feeds'])}</dd>
        ${
          o['priceSource']
            ? html`<dt>price source</dt>
                <dd class="mono">${String(o['priceSource'])}</dd>`
            : ''
        }
        ${
          o['oracleAuthority']
            ? html`<dt>oracle authority</dt>
                <dd class="mono">${String(o['oracleAuthority'])}</dd>`
            : ''
        }
        <dt>max staleness</dt>
        <dd>${String(o['maxOracleStaleness'] ?? '—')}s</dd>
        ${
          o['error']
            ? html`<dt>error</dt>
                <dd class="dn">${String(o['error'])}</dd>`
            : ''
        }
      </dl>
      ${table(
        [
          'base',
          'mint / oracle',
          { label: 'price (1e6)', num: true },
          { label: 'age', num: true },
          'fresh',
          'error',
        ],
        legs.map(
          (l) =>
            html`<tr>
              <td><b>${String(l['symbol'])}</b></td>
              <td class="mono dm">
                ${short(String(l['mint']), 8)}${l['oracle'] ? html`<br />${short(String(l['oracle']), 8)}` : ''}
              </td>
              <td class="n">${l['price1e6'] ? String(l['price1e6']) : '—'}</td>
              <td class="n">
                ${l['ageSeconds'] === undefined || l['ageSeconds'] === null ? '—' : String(l['ageSeconds']) + 's'}
              </td>
              <td>${onOff(l['fresh'] === true, 'fresh', 'stale')}</td>
              <td class="dm">${l['error'] ? String(l['error']) : ''}</td>
            </tr>`,
        ),
        'NO BASE MINTS KNOWN ON THIS NET',
      )}`,
  );
}

async function renderVaults(box: HTMLElement, net: Net): Promise<void> {
  const v = await get<Record<string, unknown>>(`/admin/chain/vaults/${net}`);
  const onChain = (v['onChain'] as Record<string, unknown>[]) ?? [];
  const indexed =
    (v['indexed'] as { kind: string; nativeBalance: number; lifetimeCredited: number }[]) ?? [];
  render(
    box,
    html`<span class="lbl">Indexed (native units)</span>
      ${table(
        ['vault', { label: 'balance', num: true }, { label: 'lifetime', num: true }],
        indexed.map(
          (t) =>
            html`<tr>
              <td>${t.kind}</td>
              <td class="n">${num(t.nativeBalance, 6)}</td>
              <td class="n">${num(t.lifetimeCredited, 6)}</td>
            </tr>`,
        ),
      )}
      <span class="lbl">On chain per base token (atoms)</span>
      ${table(
        ['base', 'mint', 'protocol', 'ops', 'rwa', ''],
        onChain.map(
          (r) =>
            html`<tr>
              <td><b>${String(r['symbol'])}</b></td>
              <td class="mono dm">${short(String(r['mint']), 8)}</td>
              <td class="mono">
                ${r['protocol'] !== undefined ? String(r['protocol']) : ((r['vaults'] as Record<string, string> | undefined)?.['protocol'] ?? '—')}
              </td>
              <td class="mono">
                ${r['ops'] !== undefined ? String(r['ops']) : ((r['vaults'] as Record<string, string> | undefined)?.['ops'] ?? '—')}
              </td>
              <td class="mono">
                ${r['rwa'] !== undefined ? String(r['rwa']) : ((r['vaults'] as Record<string, string> | undefined)?.['rwa'] ?? '—')}
              </td>
              <td class="dm">${r['error'] ? String(r['error']) : ''}</td>
            </tr>`,
        ),
        'NOT DEPLOYED / NO BASES',
      )}`,
  );
}

async function renderCursors(box: HTMLElement): Promise<void> {
  const { cursors } = await get<{ cursors: Record<string, unknown>[] }>('/admin/indexer/cursors');
  render(
    box,
    table(
      [
        'net',
        { label: 'position', num: true },
        { label: 'chain head', num: true },
        { label: 'confirmed', num: true },
        { label: 'fails', num: true },
        { label: 'reorgs', num: true },
        'last event',
        'last error',
        '',
      ],
      cursors.map(
        (c) =>
          html`<tr>
            <td>${netTag(String(c['net']))}</td>
            <td class="n">${String(c['position'])}</td>
            <td class="n">${String(c['chainHead'])}</td>
            <td class="n">${String(c['confirmedHead'])}</td>
            <td class="n">${String(c['failedAttempts'])}</td>
            <td class="n">${String(c['reorgs'])}</td>
            <td>${ago(c['lastEventAt'] as number | null)}</td>
            <td class="dm">${c['lastError'] ? String(c['lastError']).slice(0, 80) : ''}</td>
            <td class="act">
              ${isOwner() ? html`<button type="button" class="btn sm danger" data-cursor="${String(c['net'])}">Set…</button>` : ''}
            </td>
          </tr>`,
      ),
    ),
  );
  box.querySelectorAll<HTMLElement>('[data-cursor]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const net = b.dataset['cursor'] ?? '';
        const pos = Number(
          await promptText(`Set ${net} cursor`, 'New position (the indexer re-reads from here)', {
            placeholder: '0',
          }),
        );
        if (!Number.isInteger(pos) || pos < 0) return toast('bad position', 'red');
        const phrase = `SET CURSOR ${net}`;
        if (
          !(await confirmTyped(
            'Move the live cursor',
            phrase,
            `Rewinding replays history (idempotent). Advancing SKIPS blocks and loses events permanently.`,
            { danger: true },
          ))
        )
          return;
        await post(`/admin/indexer/cursors/${net}`, { position: pos, confirm: phrase });
        toast(`${net} cursor set to ${pos}`, 'green');
        await renderCursors(box);
        return undefined;
      }),
    ),
  );
}

export async function renderChain(root: HTMLElement, params: URLSearchParams): Promise<void> {
  const { nets } = await get<{ nets: NetState[] }>('/admin/chain/state');
  const focus =
    (params.get('net') as Net | null) ??
    ALL_NETS.find((n) => nets.find((x) => x.net === n)?.deployed) ??
    'SOL';
  const refresh = (): Promise<void> => renderChain(root, params);
  render(
    root,
    html`<div class="sec-hd">
        <h1>Chain ops</h1>
        <span class="sub">server prepares · your wallet signs · nothing custodial</span
        ><span class="grow"></span
        ><button type="button" class="btn ghost sm" id="chainRefresh">Refresh</button>
      </div>
      <div class="grid c2 mb10">
        ${nets.map((n) => {
          const s = n.state ?? {};
          return panel(
            n.net,
            html`${
                !n.deployed
                  ? html`<div class="empty">NOT DEPLOYED ON THIS ENVIRONMENT</div>`
                  : n.error
                    ? html`<div class="errbox">${n.error}</div>`
                    : html`<dl class="kv">
                        <dt>contract</dt>
                        <dd class="mono">${n.launchpad ?? n.programId ?? '—'}</dd>
                        <dt>admin</dt>
                        <dd class="mono">${String(s['admin'] ?? '—')}</dd>
                        <dt>pending admin</dt>
                        <dd class="mono">${String(s['pendingAdmin'] ?? '—')}</dd>
                        <dt>pauser</dt>
                        <dd class="mono">${String(s['pauser'] ?? '—')}</dd>
                        ${
                          s['priceSource']
                            ? html`<dt>price source</dt>
                                <dd class="mono">${String(s['priceSource'])}</dd>`
                            : ''
                        }
                        ${
                          s['oracleAuthority']
                            ? html`<dt>oracle authority</dt>
                                <dd class="mono">${String(s['oracleAuthority'])}</dd>`
                            : ''
                        }
                        <dt>withdraw</dt>
                        <dd class="mono">
                          protocol ${short(String(s['protocolWithdrawAuthority'] ?? ''))} · ops
                          ${short(String(s['opsWithdrawAuthority'] ?? ''))}
                        </dd>
                        <dt>migration</dt>
                        <dd class="mono">
                          ${short(String(s['migrationAuthority'] ?? ''))}${s['migrator'] ? html` via ${short(String(s['migrator']))}` : ''}
                        </dd>
                        <dt>staleness</dt>
                        <dd>${String(s['maxOracleStaleness'] ?? '—')}s</dd>
                        ${
                          s['trustedRouter'] !== undefined
                            ? html`<dt>trusted router</dt>
                                <dd class="mono">
                                  ${s['trustedRouter'] ? String(s['trustedRouter']) : 'n/a (pre-params implementation)'}
                                </dd>`
                            : ''
                        }
                        <dt>tokens</dt>
                        <dd>${String(s['tokenCount'] ?? '—')} · cursor ${n.cursor}</dd>
                        <dt>switches</dt>
                        <dd>${pausedTags(s['paused'] as Record<string, boolean> | undefined)}</dd>
                      </dl>`
              }
              <div>
                ${n.treasuries.map((t) => html`<span class="pill">${t.kind} ${num(t.nativeBalance, 4)}</span> `)}
              </div>
              ${n.deployed && canPrepare() ? html`<div class="btns"><button type="button" class="btn go" data-prepare="${n.net}">Prepare admin tx</button><a class="btn ghost" href="#/chain?net=${n.net}">Oracle & vaults</a></div>` : ''}`,
            n.deployed ? `chain ${n.chainId ?? 'solana'}` : undefined,
            netTag(n.net),
          );
        })}
      </div>
      <div class="grid c2">
        ${panel(`Oracle legs · ${focus}`, html`<div id="oracleBox"><div class="empty">LOADING…</div></div>`, 'on-chain source vs staleness bound')}
        ${panel(`Treasury vaults · ${focus}`, html`<div id="vaultBox"><div class="empty">LOADING…</div></div>`, 'indexed + live reads')}
      </div>
      <div class="mt10">
        ${panel('Indexer cursors', html`<div id="cursorBox"><div class="empty">LOADING…</div></div>`, 'owner may set a cursor with typed confirmation')}
      </div>`,
  );
  root.querySelector('#chainRefresh')?.addEventListener('click', () => void refresh());
  root.querySelectorAll<HTMLElement>('[data-prepare]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const n = nets.find((x) => x.net === b.dataset['prepare']);
        if (n) await prepareFlow(n, refresh);
      }),
    ),
  );
  const oracleBox = root.querySelector<HTMLElement>('#oracleBox');
  const vaultBox = root.querySelector<HTMLElement>('#vaultBox');
  const cursorBox = root.querySelector<HTMLElement>('#cursorBox');
  if (oracleBox)
    void renderOracle(oracleBox, focus).catch((e) =>
      render(oracleBox, html`<div class="errbox">${errText(e)}</div>`),
    );
  if (vaultBox)
    void renderVaults(vaultBox, focus).catch((e) =>
      render(vaultBox, html`<div class="errbox">${errText(e)}</div>`),
    );
  if (cursorBox)
    void renderCursors(cursorBox).catch((e) =>
      render(cursorBox, html`<div class="errbox">${errText(e)}</div>`),
    );
}

export { when, val, checked };
