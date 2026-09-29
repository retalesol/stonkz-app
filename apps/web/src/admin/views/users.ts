import type { Net } from '@stonkz/shared';
import { adminSession, get, post, put } from '../api.js';
import {
  ago,
  busy,
  checked,
  confirmTyped,
  dialog,
  html,
  netSelect,
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

interface UserRow {
  net: Net;
  wallet: string;
  username: string | null;
  createdAt: number;
  xp: number;
  sp: number;
  stonkz: number;
  chatBanned: boolean;
  launchBanned: boolean;
  tradeBanned: boolean;
  commentsBanned: boolean;
  shadowMuted: boolean;
}
interface Moderation {
  chatBanned: boolean;
  commentsBanned: boolean;
  launchBanned: boolean;
  tradeBanned: boolean;
  shadowMuted: boolean;
  reason: string | null;
  until: number | null;
}
interface UserDetail {
  net: Net;
  wallet: string;
  profile: {
    username: string | null;
    bio: string | null;
    avatarUrl: string | null;
    xHandle: string | null;
    createdAt: number;
  } | null;
  balances: { xp: number; sp: number; stonkz: number };
  spLevel: { level: number; name?: string } | null;
  ledger: {
    id: number;
    asset: string;
    delta: number;
    balanceAfter: number;
    reason: string;
    createdAt: number;
  }[];
  crates: { tier: string; count: number }[];
  referrals: { code: string | null; referrer: string | null; referred: number };
  trades: { count: number; volumeUsd: number };
  sessions: {
    id: string;
    issuedAt: number;
    expiresAt: number;
    userAgent: string | null;
    ip: string | null;
  }[];
  moderation: Moderation;
}

const TIERS = ['BRONZE', 'IRON', 'SILVER', 'GOLD', 'PLATINUM', 'IRIDIUM', 'PALLADIUM', 'RHODIUM'];

function role(): string {
  return adminSession()?.role ?? 'viewer';
}
const canModerate = (): boolean => ['owner', 'admin', 'moderator'].includes(role());
const canGrant = (): boolean => ['owner', 'admin'].includes(role());

async function moderationDialog(u: UserDetail): Promise<boolean> {
  const m = u.moderation;
  const out = await dialog<Record<string, unknown>>(
    `Moderate ${short(u.wallet)}`,
    (done) => {
      queueMicrotask(() => {
        document.querySelector('[data-save-mod]')?.addEventListener('click', () => {
          const reason = val('#modReason');
          if (!reason) {
            toast('a reason is required', 'red');
            return;
          }
          const untilRaw = val('#modUntil');
          done({
            chatBanned: checked('#mChat'),
            commentsBanned: checked('#mComments'),
            launchBanned: checked('#mLaunch'),
            tradeBanned: checked('#mTrade'),
            shadowMuted: checked('#mShadow'),
            reason,
            ...(untilRaw ? { untilMs: new Date(untilRaw).getTime() } : {}),
          });
        });
      });
      const chk = (id: string, label: string, on: boolean, hint: string): Html =>
        html`<label class="chk"
          ><input type="checkbox" id="${id}" ${on ? 'checked' : ''} /> <b>${label}</b>
          <span class="dm">${hint}</span></label
        >`;
      return html`${chk('mChat', 'Chat ban', m.chatBanned, 'send is refused (WS + REST)')}
        ${chk('mComments', 'Comments ban', m.commentsBanned, 'wall posts refused')}
        ${chk('mLaunch', 'Launch ban', m.launchBanned, '/launch/prepare refused')}
        ${chk('mTrade', 'Trade ban', m.tradeBanned, '/trade/prepare refused (on-chain trading is not blockable)')}
        ${chk('mShadow', 'Shadow mute', m.shadowMuted, 'messages persist flagged; only the sender sees them')}
        <div class="frow">
          <label class="lg"
            ><span class="lbl">Reason (audited)</span
            ><input id="modReason" class="fld" value="${m.reason ?? ''}" placeholder="why"
          /></label>
          <label class="sm"
            ><span class="lbl">Until (optional, UTC)</span
            ><input
              id="modUntil"
              class="fld dark"
              type="datetime-local"
              value="${m.until ? new Date(m.until).toISOString().slice(0, 16) : ''}"
          /></label>
        </div>
        <div class="btns">
          <button type="button" class="btn ghost" data-close>Cancel</button
          ><span class="grow"></span
          ><button type="button" class="btn go" data-save-mod>Apply</button>
        </div>`;
    },
    { sub: `${u.net} · current: ${describeMod(m)}` },
  );
  if (!out) return false;
  await put(`/admin/users/${u.net}/${encodeURIComponent(u.wallet)}/moderation`, out);
  toast('moderation updated', 'green');
  return true;
}

function describeMod(m: Moderation): string {
  const bits = [];
  if (m.chatBanned) bits.push('chat');
  if (m.commentsBanned) bits.push('comments');
  if (m.launchBanned) bits.push('launch');
  if (m.tradeBanned) bits.push('trade');
  if (m.shadowMuted) bits.push('shadow');
  return bits.length ? 'banned: ' + bits.join(', ') : 'no restrictions';
}

async function grantDialog(u: UserDetail): Promise<boolean> {
  const out = await dialog<Record<string, unknown>>(
    `Grant / revoke · ${short(u.wallet)}`,
    (done) => {
      queueMicrotask(() => {
        const asset = document.getElementById('gAsset') as HTMLSelectElement | null;
        const tierRow = document.getElementById('gTierRow');
        const sync = (): void => {
          if (tierRow) tierRow.hidden = asset?.value !== 'CRATE';
        };
        asset?.addEventListener('change', sync);
        sync();
        document.querySelector('[data-save-grant]')?.addEventListener('click', () => {
          const delta = Number(val('#gDelta'));
          const reason = val('#gReason');
          if (!Number.isInteger(delta) || delta === 0)
            return toast('delta must be a non-zero integer', 'red');
          if (!reason) return toast('a reason is required', 'red');
          done({
            asset: val('#gAsset'),
            delta,
            reason,
            ...(val('#gAsset') === 'CRATE' ? { tier: val('#gTier') } : {}),
          });
          return undefined;
        });
      });
      return html`<div class="frow">
          <label class="sm"
            ><span class="lbl">Asset</span
            ><select id="gAsset" class="fld dark">
              <option value="SP">SP</option>
              <option value="CRATE">CRATE</option>
            </select></label
          >
          <label class="sm" id="gTierRow"
            ><span class="lbl">Tier</span
            ><select id="gTier" class="fld dark">
              ${TIERS.map((t) => html`<option>${t}</option>`)}
            </select></label
          >
          <label class="sm"
            ><span class="lbl">Delta (negative revokes)</span
            ><input id="gDelta" class="fld" type="number" step="1" value="0"
          /></label>
        </div>
        <label
          ><span class="lbl">Reason (audited)</span
          ><input id="gReason" class="fld" placeholder="contest prize, clawback…"
        /></label>
        <p class="hint">
          SP grants bypass the daily cap and sync crate levels. Balances never go below zero.
        </p>
        <div class="btns">
          <button type="button" class="btn ghost" data-close>Cancel</button
          ><span class="grow"></span
          ><button type="button" class="btn go" data-save-grant>Apply</button>
        </div>`;
    },
  );
  if (!out) return false;
  const r = await post<{ before: number; after: number }>(
    `/admin/users/${u.net}/${encodeURIComponent(u.wallet)}/grant`,
    out,
  );
  toast(`${String(out['asset'])}: ${r.before} → ${r.after}`, 'green');
  return true;
}

async function renderDetail(root: HTMLElement, net: Net, wallet: string): Promise<void> {
  const u = await get<UserDetail>(`/admin/users/${net}/${encodeURIComponent(wallet)}`);
  const m = u.moderation;
  render(
    root,
    html`<div class="sec-hd">
        <h1>User</h1>
        ${netTag(u.net)}<span class="mono">${u.wallet}</span><span class="grow"></span
        ><a class="btn ghost sm" href="#/users">← back</a>
      </div>
      <div class="grid c2">
        ${panel(
          'Profile',
          html`<dl class="kv">
              <dt>username</dt>
              <dd>${u.profile?.username ?? html`<span class="dm">—</span>`}</dd>
              <dt>bio</dt>
              <dd>${u.profile?.bio ?? html`<span class="dm">—</span>`}</dd>
              <dt>avatar</dt>
              <dd class="mono">${u.profile?.avatarUrl ?? html`<span class="dm">default</span>`}</dd>
              <dt>x</dt>
              <dd>${u.profile?.xHandle ?? '—'}</dd>
              <dt>joined</dt>
              <dd>${when(u.profile?.createdAt)}</dd>
              <dt>trades</dt>
              <dd>${u.trades.count} · ${'$' + num(u.trades.volumeUsd)}</dd>
              <dt>referrals</dt>
              <dd>
                code ${u.referrals.code ?? '—'} · referred ${u.referrals.referred} · by
                ${u.referrals.referrer ? short(u.referrals.referrer) : '—'}
              </dd>
            </dl>
            ${canModerate() ? html`<div class="btns"><button type="button" class="btn sm" data-reset="username">Reset username</button><button type="button" class="btn sm" data-reset="avatar">Reset avatar</button><button type="button" class="btn sm" data-reset="bio">Reset bio</button></div>` : ''}`,
        )}
        ${panel(
          'Moderation',
          html`<div>
              ${onOff(!m.chatBanned, 'chat', 'chat banned')}
              ${onOff(!m.commentsBanned, 'comments', 'comments banned')}
              ${onOff(!m.launchBanned, 'launch', 'launch banned')}
              ${onOff(!m.tradeBanned, 'trade', 'trade banned')}
              ${m.shadowMuted ? html`<span class="tag warn">shadow muted</span>` : ''}
            </div>
            <dl class="kv">
              <dt>reason</dt>
              <dd>${m.reason ?? '—'}</dd>
              <dt>until</dt>
              <dd>${when(m.until)}</dd>
            </dl>
            ${canModerate() ? html`<div class="btns"><button type="button" class="btn" data-moderate>Edit restrictions</button></div>` : ''}`,
        )}
        ${panel(
          'Game',
          html`<div class="grid c3">
              <div class="stat">
                <span class="lbl">XP</span><span class="v">${num(u.balances.xp)}</span>
              </div>
              <div class="stat">
                <span class="lbl">SP</span><span class="v am">${num(u.balances.sp)}</span
                ><span class="s">level ${u.spLevel?.level ?? '—'}</span>
              </div>
              <div class="stat">
                <span class="lbl">$STONKZ credits</span
                ><span class="v">${num(u.balances.stonkz)}</span>
              </div>
            </div>
            <div>
              <span class="lbl">Crate inventory</span
              >${u.crates.length ? u.crates.map((c) => html`<span class="pill">${c.tier} × ${c.count}</span> `) : html`<span class="dm">empty</span>`}
            </div>
            ${canGrant() ? html`<div class="btns"><button type="button" class="btn" data-grant>Grant / revoke SP or crates</button></div>` : ''}
            ${table(
              [
                'at',
                'asset',
                { label: 'delta', num: true },
                { label: 'after', num: true },
                'reason',
              ],
              u.ledger.map(
                (l) =>
                  html`<tr>
                    <td class="dm">${when(l.createdAt)}</td>
                    <td>${l.asset}</td>
                    <td class="n ${l.delta < 0 ? 'dn' : 'up'}">${l.delta}</td>
                    <td class="n">${l.balanceAfter}</td>
                    <td>${l.reason}</td>
                  </tr>`,
              ),
              'NO LEDGER ROWS',
            )}`,
          'last 50 ledger rows',
        )}
        ${panel(
          'Sessions',
          html`${table(
              ['issued', 'expires', 'ip', 'user agent', ''],
              u.sessions.map(
                (s) =>
                  html`<tr>
                    <td>${ago(s.issuedAt)}</td>
                    <td>${when(s.expiresAt)}</td>
                    <td>${s.ip ?? '—'}</td>
                    <td class="dm">${(s.userAgent ?? '').slice(0, 60)}</td>
                    <td class="act">
                      ${canModerate() ? html`<button type="button" class="btn sm danger" data-revoke="${s.id}">Revoke</button>` : ''}
                    </td>
                  </tr>`,
              ),
              'NO LIVE SESSIONS',
            )}
            ${canModerate() && u.sessions.length ? html`<div class="btns"><button type="button" class="btn danger" data-revoke="">Revoke all sessions</button></div>` : ''}
            <p class="hint">
              Revoking kills the refresh token; an access token already issued lives out its
              15-minute TTL.
            </p>`,
        )}
      </div>`,
  );
  const refresh = (): Promise<void> => renderDetail(root, net, wallet);
  root.querySelector('[data-moderate]')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      if (await moderationDialog(u)) await refresh();
    }),
  );
  root.querySelector('[data-grant]')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      if (await grantDialog(u)) await refresh();
    }),
  );
  root.querySelectorAll<HTMLElement>('[data-reset]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const field = b.dataset['reset'] ?? '';
        const reason = await promptText(`Reset ${field}`, 'Reason (audited)', {
          placeholder: 'impersonation, slur, …',
        });
        if (!reason) return;
        await post(`/admin/users/${net}/${encodeURIComponent(wallet)}/reset-profile`, {
          [field]: true,
          reason,
        });
        toast(`${field} reset`, 'green');
        await refresh();
      }),
    ),
  );
  root.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const sessionId = b.dataset['revoke'] || undefined;
        const phrase = `REVOKE ${wallet.slice(0, 6)}`;
        if (
          !(await confirmTyped(
            'Revoke sessions',
            phrase,
            sessionId ? 'Revoke this one session.' : 'Revoke every live session for this wallet.',
            { danger: true },
          ))
        )
          return;
        const r = await post<{ revoked: number }>(
          `/admin/users/${net}/${encodeURIComponent(wallet)}/sessions/revoke`,
          { confirm: phrase, ...(sessionId ? { sessionId } : {}) },
        );
        toast(`${r.revoked} session(s) revoked`, 'green');
        await refresh();
      }),
    ),
  );
}

export async function renderUsers(root: HTMLElement, params: URLSearchParams): Promise<void> {
  const netP = params.get('net');
  const walletP = params.get('wallet');
  if (netP && walletP) return renderDetail(root, netP as Net, walletP);
  const q = params.get('q') ?? '';
  const net = (params.get('net') as Net | null) ?? 'ALL';
  const { users } = await get<{ users: UserRow[] }>(
    `/admin/users?q=${encodeURIComponent(q)}${net !== 'ALL' ? `&net=${net}` : ''}`,
  );
  render(
    root,
    html`<div class="sec-hd">
        <h1>Users</h1>
        <span class="sub">${users.length} shown</span>
      </div>
      <form class="frow mb10" id="userSearch">
        <label class="lg"
          ><span class="lbl">Wallet prefix or username</span
          ><input id="uq" class="fld" value="${q}" placeholder="0x… / base58… / name" autofocus
        /></label>
        <label class="sm"><span class="lbl">Net</span>${netSelect('unet', net)}</label>
        <button class="btn go" type="submit">Search</button>
      </form>
      ${table(
        [
          'net',
          'wallet',
          'username',
          { label: 'xp', num: true },
          { label: 'sp', num: true },
          'restrictions',
          'joined',
          '',
        ],
        users.map(
          (u) =>
            html`<tr>
              <td>${netTag(u.net)}</td>
              <td class="mono">${u.wallet}</td>
              <td>${u.username ?? html`<span class="dm">—</span>`}</td>
              <td class="n">${num(u.xp)}</td>
              <td class="n">${num(u.sp)}</td>
              <td>
                ${u.chatBanned ? html`<span class="tag off">chat</span>` : ''}${u.commentsBanned ? html`<span class="tag off">comments</span>` : ''}${u.launchBanned ? html`<span class="tag off">launch</span>` : ''}${u.tradeBanned ? html`<span class="tag off">trade</span>` : ''}${u.shadowMuted ? html`<span class="tag warn">shadow</span>` : ''}
              </td>
              <td class="dm">${ago(u.createdAt)}</td>
              <td class="act">
                <a class="btn sm" href="#/users?net=${u.net}&wallet=${encodeURIComponent(u.wallet)}"
                  >Open</a
                >
              </td>
            </tr>`,
        ),
        q ? 'NO MATCHES' : 'SEARCH FOR A WALLET OR USERNAME',
      )}`,
  );
  root.querySelector('#userSearch')?.addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/users?q=${encodeURIComponent(val('#uq'))}&net=${val('#unet')}`;
  });
}
