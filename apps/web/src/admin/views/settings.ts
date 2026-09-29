import { adminSession, del, get, put } from '../api.js';
import {
  ago,
  busy,
  confirmTyped,
  dialog,
  errText,
  html,
  onOff,
  panel,
  render,
  table,
  toast,
  type Html,
} from '../ui.js';

interface Setting {
  key: string;
  group: string;
  label: string;
  type: 'boolean' | 'number' | 'string' | 'string[]' | 'json';
  wired: boolean;
  value: unknown;
  fallback: unknown;
  overridden: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

const GROUPS: Record<string, string> = {
  features: 'Feature flags & banner',
  limits: 'Rate limits',
  moderation: 'Moderation',
  launch: 'Base mints',
  game: 'Game tables & thresholds',
  oracle: 'Oracles',
};

function show(v: unknown, type: Setting['type']): string {
  if (type === 'json') return v === null ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  return String(v);
}

async function editSetting(s: Setting): Promise<boolean> {
  const value = await dialog<unknown>(
    s.label,
    (done) => {
      const id = `st${Math.random().toString(36).slice(2, 8)}`;
      queueMicrotask(() => {
        const btn = document.querySelector<HTMLButtonElement>(`[data-save="${id}"]`);
        btn?.addEventListener('click', () => {
          const el = document.getElementById(id) as
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
          if (!el) return;
          if (s.type === 'boolean') done(el.value === 'true');
          else if (s.type === 'number') done(Number(el.value));
          else if (s.type === 'string[]')
            done(
              el.value
                .split(/[\n,]/)
                .map((x) => x.trim())
                .filter(Boolean),
            );
          else if (s.type === 'json') {
            try {
              done(JSON.parse(el.value || 'null'));
            } catch (err) {
              toast('invalid JSON: ' + errText(err), 'red');
            }
          } else done(el.value);
        });
      });
      let field: Html;
      if (s.type === 'boolean')
        field = html`<select id="${id}" class="fld dark">
          <option value="true" ${s.value === true ? 'selected' : ''}>ENABLED</option>
          <option value="false" ${s.value === false ? 'selected' : ''}>DISABLED</option>
        </select>`;
      else if (s.type === 'number')
        field = html`<input
          id="${id}"
          class="fld"
          type="number"
          step="any"
          value="${String(s.value)}"
        />`;
      else if (s.type === 'string')
        field = html`<input id="${id}" class="fld" value="${String(s.value ?? '')}" />`;
      else if (s.type === 'string[]')
        field = html`<textarea id="${id}" class="fld" placeholder="one per line">
${(s.value as string[]).join('\n')}</textarea>`;
      else
        field = html`<textarea id="${id}" class="fld" style="min-height:160px">
${JSON.stringify(s.value, null, 2)}</textarea>`;
      return html`<div class="kv">
          <dt>key</dt>
          <dd class="mono">${s.key}</dd>
          <dt>fallback</dt>
          <dd class="mono">${show(s.fallback, s.type)}</dd>
          <dt>wired</dt>
          <dd>${onOff(s.wired, 'read by the API', 'stored only')}</dd>
        </div>
        <label><span class="lbl">New value</span>${field}</label>
        <div class="btns">
          <button type="button" class="btn ghost" data-close>Cancel</button
          ><span style="flex:1"></span
          ><button type="button" class="btn go" data-save="${id}">Save</button>
        </div>`;
    },
    { sub: s.key },
  );
  if (value === undefined) return false;
  await put(`/admin/settings/${encodeURIComponent(s.key)}`, { value });
  toast(`${s.key} saved`, 'green');
  return true;
}

export async function renderSettings(root: HTMLElement): Promise<void> {
  const { settings } = await get<{ settings: Setting[] }>('/admin/settings');
  const canWrite = ['owner', 'admin'].includes(adminSession()?.role ?? '');
  const groups = [...new Set(settings.map((s) => s.group))];
  render(
    root,
    html`<div class="sec-hd">
        <h1>Platform settings</h1>
        <span class="sub"
          >DB overrides env · hot-reloaded across API instances ·
          ${canWrite ? 'you can edit' : 'read-only for your role'}</span
        >
      </div>
      <p class="hint" style="margin-bottom:10px">
        WIRED means a read site in the API consults the key right now. STORED means it is persisted
        and audited but nothing reads it yet (see docs/admin-panel.md for the list).
      </p>
      <div class="grid" style="gap:10px">
        ${groups.map((g) =>
          panel(
            GROUPS[g] ?? g,
            table(
              ['setting', 'value', 'fallback', 'source', 'wired', 'updated', ''],
              settings
                .filter((s) => s.group === g)
                .map(
                  (s) =>
                    html`<tr data-key="${s.key}">
                      <td><b>${s.label}</b><br /><span class="dm mono">${s.key}</span></td>
                      <td class="mono">${show(s.value, s.type)}</td>
                      <td class="dm mono">${show(s.fallback, s.type)}</td>
                      <td>
                        ${s.overridden ? html`<span class="tag warn">db</span>` : html`<span class="tag">env</span>`}
                      </td>
                      <td>${onOff(s.wired, 'wired', 'stored')}</td>
                      <td class="dm">
                        ${s.updatedAt ? html`${ago(s.updatedAt)}<br />${s.updatedBy}` : '—'}
                      </td>
                      <td class="act">
                        ${canWrite ? html`<button type="button" class="btn sm" data-edit>Edit</button> ${s.overridden ? html`<button type="button" class="btn sm ghost" data-reset>Reset</button>` : ''}` : ''}
                      </td>
                    </tr>`,
                ),
            ),
          ),
        )}
      </div>`,
  );
  root.querySelectorAll<HTMLTableRowElement>('tr[data-key]').forEach((tr) => {
    const key = tr.dataset['key'] ?? '';
    const s = settings.find((x) => x.key === key);
    if (!s) return;
    tr.querySelector('[data-edit]')?.addEventListener('click', (e) =>
      busy(e.currentTarget as HTMLElement, async () => {
        if (await editSetting(s)) await renderSettings(root);
      }),
    );
    tr.querySelector('[data-reset]')?.addEventListener('click', (e) =>
      busy(e.currentTarget as HTMLElement, async () => {
        if (
          !(await confirmTyped(
            'Reset to fallback',
            'RESET',
            html`Drop the DB override for <b>${key}</b> and return to
              <span class="mono">${show(s.fallback, s.type)}</span>.`,
          ))
        )
          return;
        await del(`/admin/settings/${encodeURIComponent(key)}`);
        toast(`${key} reset`, 'green');
        await renderSettings(root);
      }),
    );
  });
}
