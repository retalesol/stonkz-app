import { adminSession, clearAdminSession, del, get, post, put } from '../api.js';
import {
  busy,
  confirmTyped,
  dialog,
  html,
  onOff,
  panel,
  promptText,
  render,
  table,
  toast,
  val,
} from '../ui.js';

interface RoleRow {
  wallet: string;
  role: string;
  source: 'env' | 'db';
  grantedBy: string | null;
  note: string | null;
  totp: boolean;
}

export async function renderAccess(root: HTMLElement): Promise<void> {
  const me = await get<{
    address: string;
    role: string;
    mfa: boolean;
    totpEnabled: boolean;
    env: string;
  }>('/admin/me');
  const { roles } = await get<{ roles: RoleRow[] }>('/admin/access/roles');
  const owner = me.role === 'owner';
  render(
    root,
    html`<div class="sec-hd">
        <h1>Access</h1>
        <span class="sub">roles + your two-factor</span>
      </div>
      <div class="grid c2">
        ${panel(
          'Your session',
          html`<dl class="kv">
              <dt>wallet</dt>
              <dd class="mono">${me.address}</dd>
              <dt>role</dt>
              <dd>${me.role}</dd>
              <dt>mfa this session</dt>
              <dd>${onOff(me.mfa, 'verified', 'no')}</dd>
              <dt>totp</dt>
              <dd>${onOff(me.totpEnabled, 'enrolled', 'not enrolled')}</dd>
              <dt>api env</dt>
              <dd>${me.env}</dd>
            </dl>
            <div class="btns">
              ${me.totpEnabled ? html`<button type="button" class="btn danger" id="totpOff">Disable TOTP</button>` : html`<button type="button" class="btn go" id="totpOn">Enrol TOTP</button>`}
            </div>
            <p class="hint">
              Once enrolled, every step-up needs a 6-digit code. Codes are RFC 6238 (Google
              Authenticator, 1Password, Authy). The secret is sealed under the admin secret at rest.
            </p>`,
        )}
        ${panel(
          'Roles',
          html`${table(
              ['wallet', 'role', 'source', 'totp', 'note', ''],
              roles.map(
                (r) =>
                  html`<tr>
                    <td class="mono">${r.wallet}</td>
                    <td><span class="tag ${r.role === 'owner' ? 'warn' : ''}">${r.role}</span></td>
                    <td>
                      ${r.source === 'env' ? html`<span class="tag info">ADMIN_WALLETS</span>` : html`<span class="tag">db</span>`}
                    </td>
                    <td>${onOff(r.totp, 'on', 'off')}</td>
                    <td class="dm">
                      ${r.note ?? ''}${r.grantedBy ? html` · by ${r.grantedBy.slice(0, 8)}` : ''}
                    </td>
                    <td class="act">
                      ${owner && r.source === 'db' ? html`<button type="button" class="btn sm" data-edit="${r.wallet}" data-role="${r.role}">Change</button> <button type="button" class="btn sm danger" data-revoke="${r.wallet}">Revoke</button>` : ''}
                    </td>
                  </tr>`,
              ),
            )}
            ${owner ? html`<div class="btns"><button type="button" class="btn" id="grant">Grant a role</button></div>` : html`<p class="hint">owner role required to change roles</p>`}
            <p class="hint">
              viewer: read everything · moderator: bans, resets, token flags, comms · admin:
              settings, grants, metadata, reindex, prepare chain txs · owner: roles, cursors,
              treasury/admin handover txs. Env owners cannot be removed here.
            </p>`,
        )}
      </div>`,
  );
  const refresh = (): Promise<void> => renderAccess(root);

  root.querySelector('#totpOn')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      const { secret, otpauth } = await post<{ secret: string; otpauth: string }>(
        '/admin/totp/enrol',
      );
      const code = await dialog<string>('Enrol TOTP', (done) => {
        queueMicrotask(() => {
          document
            .querySelector('[data-confirm-totp]')
            ?.addEventListener('click', () => done(val('#totpCode')));
        });
        return html`<p class="hint">
            Add this secret to your authenticator (or paste the otpauth URI into an app that accepts
            one), then enter the current code.
          </p>
          <span class="lbl">Secret</span>
          <pre class="code">${secret}</pre>
          <span class="lbl">otpauth URI</span>
          <pre class="code">${otpauth}</pre>
          <label
            ><span class="lbl">Current 6-digit code</span
            ><input
              id="totpCode"
              class="fld"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
          /></label>
          <div class="btns">
            <button type="button" class="btn ghost" data-close>Cancel</button
            ><span class="grow"></span
            ><button type="button" class="btn go" data-confirm-totp>Enable</button>
          </div>`;
      });
      if (!code) return;
      await post('/admin/totp/confirm', { code });
      toast('TOTP enabled — sign in again with a code', 'green');
      clearAdminSession();
    }),
  );
  root.querySelector('#totpOff')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      const code = await promptText('Disable TOTP', 'Current 6-digit code');
      if (!code) return;
      await post('/admin/totp/disable', { code });
      toast('TOTP disabled', 'green');
      await refresh();
    }),
  );
  root.querySelector('#grant')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      const wallet = await promptText('Grant a role', 'Wallet address (EVM 0x… or Solana base58)');
      if (!wallet) return;
      const role = (
        await promptText('Grant a role', 'Role: viewer | moderator | admin | owner', {
          placeholder: 'moderator',
        })
      )?.toLowerCase();
      if (!role) return;
      const note = await promptText('Grant a role', 'Note (optional)', { required: false });
      if (
        !(await confirmTyped(
          'Grant role',
          `GRANT ${role.toUpperCase()}`,
          html`Give <span class="mono">${wallet}</span> the <b>${role}</b> role.`,
        ))
      )
        return;
      await put(`/admin/access/roles/${encodeURIComponent(wallet)}`, { role, note: note || null });
      toast('role granted', 'green');
      await refresh();
    }),
  );
  root.querySelectorAll<HTMLElement>('[data-edit]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const wallet = b.dataset['edit'] ?? '';
        const role = (
          await promptText('Change role', 'Role: viewer | moderator | admin | owner', {
            initial: b.dataset['role'] ?? '',
          })
        )?.toLowerCase();
        if (!role) return;
        await put(`/admin/access/roles/${encodeURIComponent(wallet)}`, { role });
        toast('role updated', 'green');
        await refresh();
      }),
    ),
  );
  root.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const wallet = b.dataset['revoke'] ?? '';
        if (
          !(await confirmTyped(
            'Revoke role',
            `REVOKE ${wallet.slice(0, 6)}`,
            html`<span class="mono">${wallet}</span> loses admin access on their next request.`,
            { danger: true },
          ))
        )
          return;
        await del(`/admin/access/roles/${encodeURIComponent(wallet)}`);
        toast('role revoked', 'green');
        if (wallet === adminSession()?.wallet.toLowerCase()) clearAdminSession();
        else await refresh();
      }),
    ),
  );
}
