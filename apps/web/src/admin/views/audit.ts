import { API_BASE, adminSession, get } from '../api.js';
import {
  busy,
  downloadText,
  html,
  jsonBlock,
  netTag,
  render,
  short,
  table,
  toast,
  val,
  when,
} from '../ui.js';

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  actorNet: string;
  role: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  ok: boolean;
}

function query(params: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const k of ['actor', 'action', 'target', 'since', 'until', 'before']) {
    const v = params.get(k);
    if (v) q.set(k, v);
  }
  q.set('limit', '100');
  return q.toString();
}

export async function renderAudit(root: HTMLElement, params: URLSearchParams): Promise<void> {
  const { rows, nextBefore } = await get<{ rows: AuditRow[]; nextBefore: number | null }>(
    `/admin/audit?${query(params)}`,
  );
  render(
    root,
    html`<div class="sec-hd">
        <h1>Audit log</h1>
        <span class="sub">append-only · every mutating admin call · ${rows.length} shown</span
        ><span class="grow"></span
        ><button type="button" class="btn ghost sm" id="csv">Export CSV</button>
      </div>
      <form id="auditFilter" class="frow" style="margin-bottom:10px">
        <label
          ><span class="lbl">Actor</span
          ><input
            id="fActor"
            class="fld"
            value="${params.get('actor') ?? ''}"
            placeholder="0x… / base58"
        /></label>
        <label
          ><span class="lbl">Action</span
          ><input
            id="fAction"
            class="fld"
            value="${params.get('action') ?? ''}"
            placeholder="settings.set, user.moderation, chain.prepare…"
        /></label>
        <label
          ><span class="lbl">Target</span
          ><input
            id="fTarget"
            class="fld"
            value="${params.get('target') ?? ''}"
            placeholder="RH:0x…"
        /></label>
        <label class="sm"
          ><span class="lbl">Since (UTC)</span
          ><input
            id="fSince"
            class="fld dark"
            type="datetime-local"
            value="${params.get('since') ? new Date(Number(params.get('since'))).toISOString().slice(0, 16) : ''}"
        /></label>
        <label class="sm"
          ><span class="lbl">Until (UTC)</span
          ><input
            id="fUntil"
            class="fld dark"
            type="datetime-local"
            value="${params.get('until') ? new Date(Number(params.get('until'))).toISOString().slice(0, 16) : ''}"
        /></label>
        <button class="btn go" type="submit">Filter</button>
        <a class="btn ghost" href="#/audit">Clear</a>
      </form>
      ${table(
        ['id', 'at', 'actor', 'role', 'action', 'target', 'ok', 'ip', ''],
        rows.map(
          (r) =>
            html`<tr data-row="${r.id}">
                <td>${r.id}</td>
                <td class="dm">${when(r.at)}</td>
                <td class="mono" title="${r.actor}">${netTag(r.actorNet)} ${short(r.actor)}</td>
                <td>${r.role}</td>
                <td><b>${r.action}</b></td>
                <td class="mono dm">${r.target ?? ''}</td>
                <td>
                  ${r.ok ? html`<span class="tag on">ok</span>` : html`<span class="tag off">failed</span>`}
                </td>
                <td class="dm">${r.ip ?? ''}</td>
                <td class="act">
                  <button type="button" class="btn sm ghost" data-diff="${r.id}">Diff</button>
                </td>
              </tr>
              <tr hidden data-diff-row="${r.id}">
                <td colspan="9">
                  <div class="grid c2">
                    <div><span class="lbl">before</span>${jsonBlock(r.before)}</div>
                    <div><span class="lbl">after</span>${jsonBlock(r.after)}</div>
                  </div>
                  <span class="hint">request ${r.requestId ?? '—'}</span>
                </td>
              </tr>`,
        ),
        'NO AUDIT ROWS MATCH',
      )}
      ${nextBefore && rows.length >= 100 ? html`<div class="btns" style="margin-top:8px"><a class="btn ghost" href="#/audit?${query(params)}&before=${nextBefore}">Older →</a></div>` : ''}`,
  );
  root.querySelector('#auditFilter')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new URLSearchParams();
    if (val('#fActor')) q.set('actor', val('#fActor'));
    if (val('#fAction')) q.set('action', val('#fAction'));
    if (val('#fTarget')) q.set('target', val('#fTarget'));
    if (val('#fSince')) q.set('since', String(new Date(val('#fSince')).getTime()));
    if (val('#fUntil')) q.set('until', String(new Date(val('#fUntil')).getTime()));
    location.hash = `#/audit?${q.toString()}`;
  });
  root.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) =>
    b.addEventListener('click', () => {
      const row = root.querySelector<HTMLElement>(`[data-diff-row="${b.dataset['diff']}"]`);
      if (row) row.hidden = !row.hidden;
    }),
  );
  root.querySelector('#csv')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      const s = adminSession();
      if (!s) return;
      const res = await fetch(`${API_BASE}/admin/audit.csv?${query(params)}`, {
        headers: { Authorization: `Bearer ${s.adminToken}` },
      });
      if (!res.ok) return toast(`export failed (${res.status})`, 'red');
      downloadText(`stonkz-admin-audit-${Date.now()}.csv`, await res.text(), 'text/csv');
      return undefined;
    }),
  );
}
