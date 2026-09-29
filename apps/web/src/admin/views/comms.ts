import { ALL_NETS } from '@stonkz/shared';
import { adminSession, del, get, patch, post, put } from '../api.js';
import {
  ago,
  busy,
  checked,
  confirmTyped,
  html,
  netTag,
  onOff,
  panel,
  render,
  table,
  toast,
  val,
  when,
} from '../ui.js';

interface Notice {
  id: number;
  kind: string;
  net: string | null;
  text: string;
  severity: string;
  startsAt: number | null;
  endsAt: number | null;
  active: boolean;
  createdBy: string;
  createdAt: number;
}

const canWrite = (): boolean =>
  ['owner', 'admin', 'moderator'].includes(adminSession()?.role ?? '');

function toMs(v: string): number | undefined {
  if (!v) return undefined;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export async function renderComms(root: HTMLElement): Promise<void> {
  const { banner, notices } = await get<{
    banner: { text: string; severity: string };
    notices: Notice[];
  }>('/admin/notices');
  const w = canWrite();
  render(
    root,
    html`<div class="sec-hd">
        <h1>Comms</h1>
        <span class="sub"
          >banner + notices are read by every client via GET /platform/status (60s poll)</span
        >
      </div>
      <div class="grid c2">
        ${panel(
          'Global banner',
          html`<form id="bannerForm" class="frow">
              <label class="lg"
                ><span class="lbl">Text (empty clears)</span
                ><input
                  id="bText"
                  class="fld"
                  value="${banner.text}"
                  maxlength="280"
                  ${w ? '' : 'disabled'}
              /></label>
              <label class="sm"
                ><span class="lbl">Severity</span
                ><select id="bSev" class="fld dark" ${w ? '' : 'disabled'}>
                  ${['info', 'warn', 'critical'].map((s) => html`<option ${banner.severity === s ? 'selected' : ''}>${s}</option>`)}
                </select></label
              >
              ${w ? html`<button class="btn go" type="submit">Publish</button>` : ''}
            </form>
            <p class="hint">
              Stored as settings <span class="mono">banner.text</span> /
              <span class="mono">banner.severity</span>; hot-reloads across API instances.
            </p>`,
        )}
        ${panel(
          'Mememan announcement',
          html`<form id="annForm" class="frow">
              <label class="lg"
                ><span class="lbl">Message (system line in GLOBAL chat)</span
                ><input
                  id="aText"
                  class="fld"
                  maxlength="280"
                  placeholder="gm. maintenance in 30 minutes."
                  ${w ? '' : 'disabled'}
              /></label>
              <label class="sm"
                ><span class="lbl">Net</span
                ><select id="aNet" class="fld dark" ${w ? '' : 'disabled'}>
                  <option value="ALL">ALL NETS</option>
                  ${ALL_NETS.map((n) => html`<option>${n}</option>`)}
                </select></label
              >
              ${w ? html`<button class="btn go" type="submit">Announce</button>` : ''}
            </form>
            <p class="hint">
              Persists as wallet MEMEMAN and fans out live to every open drawer. Bypasses the chat
              rate limit and volume gate.
            </p>`,
        )}
        ${panel(
          'New notice / maintenance window',
          html`<form id="noticeForm" class="pnl-bd p0">
            <div class="frow">
              <label class="sm"
                ><span class="lbl">Kind</span
                ><select id="nKind" class="fld dark">
                  <option value="notice">notice</option>
                  <option value="maintenance">maintenance</option>
                  <option value="banner">banner</option>
                </select></label
              >
              <label class="sm"
                ><span class="lbl">Net</span
                ><select id="nNet" class="fld dark">
                  <option value="ALL">ALL</option>
                  ${ALL_NETS.map((n) => html`<option>${n}</option>`)}
                </select></label
              >
              <label class="sm"
                ><span class="lbl">Severity</span
                ><select id="nSev" class="fld dark">
                  <option>info</option>
                  <option>warn</option>
                  <option>critical</option>
                </select></label
              >
            </div>
            <label
              ><span class="lbl">Text</span
              ><input
                id="nText"
                class="fld"
                maxlength="500"
                placeholder="RH RPC degraded; trades may take longer to confirm"
            /></label>
            <div class="frow">
              <label
                ><span class="lbl">Starts (UTC, required for maintenance)</span
                ><input id="nStart" class="fld dark" type="datetime-local"
              /></label>
              <label
                ><span class="lbl">Ends (UTC)</span
                ><input id="nEnd" class="fld dark" type="datetime-local"
              /></label>
            </div>
            ${w ? html`<div class="btns"><button class="btn go" type="submit">Create</button></div>` : html`<p class="hint">moderator role required</p>`}
          </form>`,
        )}
      </div>
      <div class="mt10">
        ${panel(
          'Notices',
          table(
            ['id', 'kind', 'net', 'text', 'severity', 'window', 'active', 'by', ''],
            notices.map(
              (n) =>
                html`<tr>
                  <td>${n.id}</td>
                  <td>${n.kind}</td>
                  <td>${netTag(n.net)}</td>
                  <td>${n.text}</td>
                  <td>
                    <span
                      class="tag ${n.severity === 'critical' ? 'crit' : n.severity === 'warn' ? 'warn' : 'info'}"
                      >${n.severity}</span
                    >
                  </td>
                  <td class="dm">
                    ${n.startsAt ? when(n.startsAt) : 'now'} → ${n.endsAt ? when(n.endsAt) : '∞'}
                  </td>
                  <td>${onOff(n.active, 'active', 'off')}</td>
                  <td class="dm">${n.createdBy.slice(0, 8)} · ${ago(n.createdAt)}</td>
                  <td class="act">
                    ${w ? html`<button type="button" class="btn sm" data-toggle="${n.id}" data-active="${n.active ? '1' : '0'}">${n.active ? 'Deactivate' : 'Activate'}</button> <button type="button" class="btn sm danger" data-del="${n.id}">Delete</button>` : ''}
                  </td>
                </tr>`,
            ),
            'NO NOTICES',
          ),
        )}
      </div>`,
  );
  const refresh = (): Promise<void> => renderComms(root);
  root.querySelector('#bannerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void busy(null, async () => {
      await put('/admin/comms/banner', { text: val('#bText'), severity: val('#bSev') });
      toast(val('#bText') ? 'banner published' : 'banner cleared', 'green');
      await refresh();
    });
  });
  root.querySelector('#annForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void busy(null, async () => {
      const text = val('#aText');
      if (!text) return;
      const net = val('#aNet');
      if (
        !(await confirmTyped(
          'Mememan announcement',
          'ANNOUNCE',
          html`Post <b>"${text}"</b> to GLOBAL chat on <b>${net}</b>.`,
        ))
      )
        return;
      await post('/admin/comms/announce', { text, net, confirm: 'ANNOUNCE' });
      toast('announced', 'green');
      (root.querySelector('#aText') as HTMLInputElement | null)!.value = '';
    });
  });
  root.querySelector('#noticeForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void busy(null, async () => {
      const body: Record<string, unknown> = {
        kind: val('#nKind'),
        net: val('#nNet'),
        severity: val('#nSev'),
        text: val('#nText'),
      };
      const s = toMs(val('#nStart'));
      const en = toMs(val('#nEnd'));
      if (s !== undefined) body['startsAtMs'] = s;
      if (en !== undefined) body['endsAtMs'] = en;
      await post('/admin/notices', body);
      toast('notice created', 'green');
      await refresh();
    });
  });
  root.querySelectorAll<HTMLElement>('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        await patch(`/admin/notices/${b.dataset['toggle']}`, {
          active: b.dataset['active'] !== '1',
        });
        await refresh();
      }),
    ),
  );
  root.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const id = b.dataset['del'] ?? '';
        if (
          !(await confirmTyped(
            'Delete notice',
            `DELETE ${id}`,
            'Removes the notice permanently (the audit log keeps its content).',
            { danger: true },
          ))
        )
          return;
        await del(`/admin/notices/${id}`);
        await refresh();
      }),
    ),
  );
}

export { checked };
