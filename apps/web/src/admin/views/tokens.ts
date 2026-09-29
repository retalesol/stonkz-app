import type { Net } from '@stonkz/shared';
import { adminSession, get, patch, post, put } from '../api.js';
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
  usd,
  val,
  when,
} from '../ui.js';

interface TokenRow {
  net: Net;
  sym: string;
  name: string;
  mint: string;
  creator: string;
  mc: number;
  lane: string;
  holders: number;
  launchedAt: number;
  featured: boolean;
  kothOverride: boolean;
  hidden: boolean;
  scamWarning: string | null;
}
interface TokenDetail {
  token: TokenRow & {
    descr: string;
    imageUrl: string | null;
    xHandle: string | null;
    website: string | null;
    telegram: string | null;
    feeBps: number;
    baseSymbol: string;
    baseMint: string;
    supply: number;
    graduatedAt: number | null;
  };
  moderation: {
    featured: boolean;
    kothOverride: boolean;
    hidden: boolean;
    scamWarning: string | null;
    reason: string | null;
  };
  creatorVault: {
    unclaimedNative: number;
    unclaimedTokens: number;
    stakerPoolNative: number;
    lifetimeNative: number;
    claimedNative: number;
  } | null;
  stakers: {
    count: number;
    staked: number;
    top: { wallet: string; amount: number; lockDays: number }[];
  };
  treasuries: { kind: string; nativeBalance: number; lifetimeCredited: number }[];
  economics: { trades24h: number; volume24hUsd: number };
}
interface DeadLetter {
  id: number;
  net: Net;
  scope: string;
  kind: string;
  txSig: string;
  chainPosition: number;
  fromPosition: number;
  toPosition: number;
  error: string;
  attempts: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

const role = (): string => adminSession()?.role ?? 'viewer';
const canModerate = (): boolean => ['owner', 'admin', 'moderator'].includes(role());
const canAdmin = (): boolean => ['owner', 'admin'].includes(role());

async function moderationDialog(t: TokenDetail): Promise<boolean> {
  const m = t.moderation;
  const out = await dialog<Record<string, unknown>>(`Moderate $${t.token.sym}`, (done) => {
    queueMicrotask(() => {
      document.querySelector('[data-save-tm]')?.addEventListener('click', () => {
        const reason = val('#tmReason');
        if (!reason) return toast('a reason is required', 'red');
        done({
          featured: checked('#tmFeatured'),
          kothOverride: checked('#tmKoth'),
          hidden: checked('#tmHidden'),
          scamWarning: val('#tmScam') || null,
          reason,
        });
        return undefined;
      });
    });
    return html`<label class="chk"
        ><input type="checkbox" id="tmFeatured" ${m.featured ? 'checked' : ''} /> <b>Featured</b>
        <span class="dm">flag for the board (stored)</span></label
      >
      <label class="chk"
        ><input type="checkbox" id="tmKoth" ${m.kothOverride ? 'checked' : ''} /> <b>Pin as KOTH</b>
        <span class="dm">replaces the crown on ${t.token.net} while set</span></label
      >
      <label class="chk"
        ><input type="checkbox" id="tmHidden" ${m.hidden ? 'checked' : ''} /> <b>Hide / delist</b>
        <span class="dm">off the board and search — never off the chain</span></label
      >
      <label
        ><span class="lbl">Scam warning (shown to users; empty clears)</span
        ><input
          id="tmScam"
          class="fld"
          value="${m.scamWarning ?? ''}"
          placeholder="e.g. creator wallet linked to rug"
      /></label>
      <label
        ><span class="lbl">Reason (audited)</span
        ><input id="tmReason" class="fld" placeholder="why"
      /></label>
      <div class="btns">
        <button type="button" class="btn ghost" data-close>Cancel</button
        ><span style="flex:1"></span
        ><button type="button" class="btn go" data-save-tm>Apply</button>
      </div>`;
  });
  if (!out) return false;
  if (out['hidden'] === true && !m.hidden) {
    const phrase = `HIDE ${t.token.sym}`;
    if (
      !(await confirmTyped(
        'Hide token from the board',
        phrase,
        `$${t.token.sym} disappears from the board, lanes and search for every user. Trading on chain is unaffected.`,
        { danger: true },
      ))
    )
      return false;
    out['confirm'] = phrase;
  }
  await put(`/admin/tokens/${t.token.net}/${encodeURIComponent(t.token.mint)}/moderation`, out);
  toast('token moderation updated', 'green');
  return true;
}

async function metadataDialog(t: TokenDetail): Promise<boolean> {
  const k = t.token;
  const out = await dialog<Record<string, unknown>>(`Edit metadata · $${k.sym}`, (done) => {
    queueMicrotask(() => {
      document.querySelector('[data-save-md]')?.addEventListener('click', () => {
        const reason = val('#mdReason');
        if (!reason) return toast('a reason is required', 'red');
        done({
          name: val('#mdName'),
          descr: val('#mdDescr'),
          imageUrl: val('#mdImage'),
          xHandle: val('#mdX'),
          website: val('#mdWeb'),
          telegram: val('#mdTg'),
          reason,
        });
        return undefined;
      });
    });
    return html`<label
        ><span class="lbl">Name</span><input id="mdName" class="fld" value="${k.name}"
      /></label>
      <label
        ><span class="lbl">Description</span
        ><textarea id="mdDescr" class="fld">${k.descr}</textarea>
      </label>
      <label
        ><span class="lbl">Image URL (https)</span
        ><input id="mdImage" class="fld" value="${k.imageUrl ?? ''}"
      /></label>
      <div class="frow">
        <label
          ><span class="lbl">X</span
          ><input id="mdX" class="fld" value="${k.xHandle ?? ''}" /></label
        ><label
          ><span class="lbl">Website</span
          ><input id="mdWeb" class="fld" value="${k.website ?? ''}" /></label
        ><label
          ><span class="lbl">Telegram</span
          ><input id="mdTg" class="fld" value="${k.telegram ?? ''}"
        /></label>
      </div>
      <label
        ><span class="lbl">Reason (audited with before/after)</span
        ><input id="mdReason" class="fld" placeholder="typo, takedown request…"
      /></label>
      <p class="hint">
        Edits the indexer's copy only. On-chain metadata (Metaplex URI / ERC-20 name) is immutable.
      </p>
      <div class="btns">
        <button type="button" class="btn ghost" data-close>Cancel</button
        ><span style="flex:1"></span><button type="button" class="btn go" data-save-md>Save</button>
      </div>`;
  });
  if (!out) return false;
  await patch(`/admin/tokens/${k.net}/${encodeURIComponent(k.mint)}/metadata`, out);
  toast('metadata saved', 'green');
  return true;
}

async function renderDetail(root: HTMLElement, net: Net, mint: string): Promise<void> {
  const t = await get<TokenDetail>(`/admin/tokens/${net}/${encodeURIComponent(mint)}`);
  const k = t.token;
  const m = t.moderation;
  render(
    root,
    html`<div class="sec-hd">
        <h1>$${k.sym}</h1>
        ${netTag(k.net)}<span class="sub">${k.name}</span><span class="grow"></span
        ><a
          class="btn ghost sm"
          href="/t/${encodeURIComponent(k.sym)}?mint=${encodeURIComponent(k.mint)}"
          target="_blank"
          rel="noopener"
          >open in terminal ↗</a
        ><a class="btn ghost sm" href="#/tokens">← back</a>
      </div>
      <div class="grid c2">
        ${panel(
          'Token',
          html`<dl class="kv">
              <dt>mint</dt>
              <dd class="mono">${k.mint}</dd>
              <dt>creator</dt>
              <dd class="mono">${k.creator}</dd>
              <dt>base</dt>
              <dd>${k.baseSymbol} <span class="dm mono">${k.baseMint}</span></dd>
              <dt>lane</dt>
              <dd>${k.lane}${k.graduatedAt ? html` · graduated ${when(k.graduatedAt)}` : ''}</dd>
              <dt>mc</dt>
              <dd>${usd(k.mc)}</dd>
              <dt>holders</dt>
              <dd>${k.holders}</dd>
              <dt>fee</dt>
              <dd>${k.feeBps} bps</dd>
              <dt>24h</dt>
              <dd>${t.economics.trades24h} trades · ${usd(t.economics.volume24hUsd)}</dd>
              <dt>launched</dt>
              <dd>${when(k.launchedAt)}</dd>
              <dt>descr</dt>
              <dd>${k.descr || html`<span class="dm">—</span>`}</dd>
              <dt>links</dt>
              <dd>
                ${k.xHandle ? '@' + k.xHandle + ' ' : ''}${k.website ?? ''} ${k.telegram ?? ''}
              </dd>
              <dt>image</dt>
              <dd class="mono">${k.imageUrl ?? '—'}</dd>
            </dl>
            ${canAdmin() ? html`<div class="btns"><button type="button" class="btn" data-meta>Edit metadata</button><button type="button" class="btn ghost" data-reindex>Force reindex</button></div>` : ''}`,
        )}
        ${panel(
          'Moderation',
          html`<div>
              ${m.featured ? html`<span class="tag on">featured</span>` : ''}${m.kothOverride ? html`<span class="tag warn">koth pin</span>` : ''}${m.hidden ? html`<span class="tag off">hidden</span>` : html`<span class="tag on">listed</span>`}${m.scamWarning ? html`<span class="tag crit">scam warning</span>` : ''}
            </div>
            <dl class="kv">
              <dt>warning</dt>
              <dd>${m.scamWarning ?? '—'}</dd>
              <dt>reason</dt>
              <dd>${m.reason ?? '—'}</dd>
            </dl>
            ${canModerate() ? html`<div class="btns"><button type="button" class="btn" data-moderate>Edit flags</button></div>` : ''}`,
        )}
        ${panel(
          'Fees & treasury',
          html`${
              t.creatorVault
                ? html`<dl class="kv">
                    <dt>creator unclaimed</dt>
                    <dd>
                      ${num(t.creatorVault.unclaimedNative, 6)} native ·
                      ${num(t.creatorVault.unclaimedTokens)} tokens
                    </dd>
                    <dt>staker pool</dt>
                    <dd>${num(t.creatorVault.stakerPoolNative, 6)}</dd>
                    <dt>lifetime</dt>
                    <dd>
                      ${num(t.creatorVault.lifetimeNative, 6)} · claimed
                      ${num(t.creatorVault.claimedNative, 6)}
                    </dd>
                  </dl>`
                : html`<span class="dm">no creator vault row yet</span>`
            }
            <span class="lbl">Protocol vaults on ${k.net} (indexed, all tokens)</span>
            ${table(
              ['vault', { label: 'balance', num: true }, { label: 'lifetime', num: true }],
              t.treasuries.map(
                (v) =>
                  html`<tr>
                    <td>${v.kind}</td>
                    <td class="n">${num(v.nativeBalance, 6)}</td>
                    <td class="n">${num(v.lifetimeCredited, 6)}</td>
                  </tr>`,
              ),
            )}`,
        )}
        ${panel(
          'Stakers',
          html`<div class="grid c2">
              <div class="stat">
                <span class="lbl">positions</span><span class="v">${t.stakers.count}</span>
              </div>
              <div class="stat">
                <span class="lbl">staked</span><span class="v am">${num(t.stakers.staked)}</span>
              </div>
            </div>
            ${table(
              ['wallet', { label: 'amount', num: true }, { label: 'lock', num: true }],
              t.stakers.top.map(
                (s) =>
                  html`<tr>
                    <td class="mono">${s.wallet}</td>
                    <td class="n">${num(s.amount)}</td>
                    <td class="n">${s.lockDays}d</td>
                  </tr>`,
              ),
              'NO STAKERS',
            )}`,
        )}
      </div>`,
  );
  const refresh = (): Promise<void> => renderDetail(root, net, mint);
  root.querySelector('[data-moderate]')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      if (await moderationDialog(t)) await refresh();
    }),
  );
  root.querySelector('[data-meta]')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      if (await metadataDialog(t)) await refresh();
    }),
  );
  root.querySelector('[data-reindex]')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      const r = await post<{ receivers: number; id: string }>(
        `/admin/tokens/${net}/${encodeURIComponent(mint)}/reindex`,
      );
      toast(
        r.receivers > 0
          ? `reindex ${r.id} sent to ${r.receivers} indexer(s)`
          : `reindex ${r.id} queued (no indexer listening yet)`,
        r.receivers > 0 ? 'green' : 'amber',
      );
    }),
  );
}

async function renderDeadLetters(box: HTMLElement, net: Net | 'ALL'): Promise<void> {
  const { deadLetters } = await get<{ deadLetters: DeadLetter[] }>(
    `/admin/indexer/dead-letters${net !== 'ALL' ? `?net=${net}` : ''}`,
  );
  render(
    box,
    table(
      [
        'id',
        'net',
        'scope',
        'kind',
        'position',
        'sig',
        { label: 'attempts', num: true },
        'last seen',
        'error',
        '',
      ],
      deadLetters.map(
        (d) =>
          html`<tr>
            <td>${d.id}</td>
            <td>${netTag(d.net)}</td>
            <td>${d.scope}</td>
            <td>${d.kind}</td>
            <td class="n">
              ${d.scope === 'batch' ? `${d.fromPosition}–${d.toPosition}` : d.chainPosition}
            </td>
            <td class="mono dm">${short(d.txSig, 8)}</td>
            <td class="n">${d.attempts}</td>
            <td>${ago(d.lastSeenAt)}</td>
            <td class="dm">${d.error.slice(0, 120)}</td>
            <td class="act">
              ${canAdmin() ? html`<button type="button" class="btn sm" data-dl-retry="${d.id}">Retry</button> <button type="button" class="btn sm danger" data-dl-discard="${d.id}">Discard</button>` : ''}
            </td>
          </tr>`,
      ),
      'DEAD-LETTER QUEUE EMPTY',
    ),
  );
  box.querySelectorAll<HTMLElement>('[data-dl-retry]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const r = await post<{ receivers: number; from: number; to: number }>(
          `/admin/indexer/dead-letters/${b.dataset['dlRetry']}/retry`,
        );
        toast(
          `retry (${r.from}, ${r.to}] ${r.receivers > 0 ? 'sent' : 'queued — no indexer listening'}`,
          'green',
        );
      }),
    ),
  );
  box.querySelectorAll<HTMLElement>('[data-dl-discard]').forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const id = b.dataset['dlDiscard'] ?? '';
        if (
          !(await confirmTyped(
            'Discard dead letter',
            `DISCARD ${id}`,
            'Marks it resolved without replaying. Whatever it contained stays lost.',
            { danger: true },
          ))
        )
          return;
        await post(`/admin/indexer/dead-letters/${id}/discard`, { confirm: `DISCARD ${id}` });
        toast('discarded', 'green');
        await renderDeadLetters(box, net);
      }),
    ),
  );
}

export async function renderTokens(root: HTMLElement, params: URLSearchParams): Promise<void> {
  const mintP = params.get('mint');
  const netP = params.get('net') as Net | null;
  if (mintP && netP) return renderDetail(root, netP, mintP);
  const q = params.get('q') ?? '';
  const net = (netP as Net | 'ALL' | null) ?? 'ALL';
  const { tokens } = await get<{ tokens: TokenRow[] }>(
    `/admin/tokens?q=${encodeURIComponent(q)}${net !== 'ALL' ? `&net=${net}` : ''}`,
  );
  render(
    root,
    html`<div class="sec-hd">
        <h1>Tokens</h1>
        <span class="sub">${tokens.length} shown · newest first</span>
      </div>
      <form class="frow" id="tokSearch" style="margin-bottom:10px">
        <label class="lg"
          ><span class="lbl">Ticker, name or exact mint</span
          ><input id="tq" class="fld" value="${q}" placeholder="PEPE / 0x… / base58" autofocus
        /></label>
        <label class="sm"><span class="lbl">Net</span>${netSelect('tnet', net)}</label>
        <button class="btn go" type="submit">Search</button>
        ${canAdmin() ? html`<button type="button" class="btn ghost" id="rangeReindex">Reindex range…</button>` : ''}
      </form>
      ${table(
        [
          'net',
          'sym',
          'name',
          'mint',
          { label: 'mc', num: true },
          'lane',
          { label: 'holders', num: true },
          'flags',
          'launched',
          '',
        ],
        tokens.map(
          (t) =>
            html`<tr>
              <td>${netTag(t.net)}</td>
              <td><b>$${t.sym}</b></td>
              <td>${t.name}</td>
              <td class="mono dm">${short(t.mint, 8)}</td>
              <td class="n">${usd(t.mc)}</td>
              <td>${t.lane}</td>
              <td class="n">${t.holders}</td>
              <td>
                ${t.featured ? html`<span class="tag on">featured</span>` : ''}${t.kothOverride ? html`<span class="tag warn">koth</span>` : ''}${t.hidden ? html`<span class="tag off">hidden</span>` : ''}${t.scamWarning ? html`<span class="tag crit">scam</span>` : ''}
              </td>
              <td class="dm">${ago(t.launchedAt)}</td>
              <td class="act">
                <a class="btn sm" href="#/tokens?net=${t.net}&mint=${encodeURIComponent(t.mint)}"
                  >Open</a
                >
              </td>
            </tr>`,
        ),
        'NO TOKENS MATCH',
      )}
      <div style="margin-top:14px">
        ${panel('Indexer dead letters', html`<div id="dlBox"><div class="empty">LOADING…</div></div>`, 'open items · retry re-enqueues the range to the indexer')}
      </div>`,
  );
  root.querySelector('#tokSearch')?.addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/tokens?q=${encodeURIComponent(val('#tq'))}&net=${val('#tnet')}`;
  });
  root.querySelector('#rangeReindex')?.addEventListener('click', (e) =>
    busy(e.currentTarget as HTMLElement, async () => {
      const netPick = (
        await promptText('Reindex range', 'Net (SOL | RH | BASE | ARC)', { placeholder: 'RH' })
      )?.toUpperCase();
      if (!netPick) return;
      const from = Number(
        await promptText('Reindex range', `From position (exclusive) on ${netPick}`, {
          placeholder: '0',
        }),
      );
      const to = Number(
        await promptText('Reindex range', 'To position (inclusive)', { placeholder: '1000' }),
      );
      if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from)
        return toast('bad range', 'red');
      const phrase = `REINDEX ${netPick}`;
      if (
        !(await confirmTyped(
          'Reindex range',
          phrase,
          `Ask the ${netPick} indexer to replay (${from}, ${to}]. Ingest is idempotent; this only costs RPC time.`,
        ))
      )
        return;
      const r = await post<{ receivers: number; id: string }>('/admin/indexer/reindex', {
        net: netPick,
        from,
        to,
        confirm: phrase,
      });
      toast(r.receivers > 0 ? `sent ${r.id}` : `queued ${r.id} (no indexer listening)`, 'green');
      return undefined;
    }),
  );
  const dl = root.querySelector<HTMLElement>('#dlBox');
  if (dl)
    void renderDeadLetters(dl, net).catch((err) =>
      render(dl, html`<div class="errbox">${String(err)}</div>`),
    );
}

export { onOff };
