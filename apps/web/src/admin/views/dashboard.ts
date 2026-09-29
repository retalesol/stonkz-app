import { ALL_NETS, type Net } from '@stonkz/shared';
import { get } from '../api.js';
import { ago, html, netTag, num, panel, render, stat, table, usd, type Html } from '../ui.js';

interface Chain {
  deployed: boolean;
  head: number | null;
  cursor: number;
  behind: number | null;
  lagSeconds: number | null;
  failedAttempts: number;
  reorgs: number;
  lastError: string | null;
  lastEventAt: number | null;
  error: string | null;
}
interface Window_ {
  launches: number;
  trades: number;
  volumeUsd: number;
  feesNative: number;
}
interface Dashboard {
  now: number;
  uptimeSeconds: number;
  requests: {
    total: number;
    byStatusClass: Record<string, number>;
    inFlight: number;
    p50Ms: number;
    p95Ms: number;
  };
  ws: { connections: number; peakConnections: number; subscriptions: number; messagesSent: number };
  rpc: Record<Net, { calls: number; errors: number; errorRate: number }>;
  chains: Record<Net, Chain>;
  stats: {
    today: Record<Net, Window_>;
    week: Record<Net, Window_>;
    topTokens: { net: Net; sym: string; mint: string | null; volumeUsd: number; trades: number }[];
  };
  deadLetters: Record<string, number>;
  pendingIndexerCommands: number;
  alerts: { severity: 'warn' | 'critical'; key: string; message: string }[];
}

let timer: number | null = null;

export function unmountDashboard(): void {
  if (timer) window.clearInterval(timer);
  timer = null;
}

export async function renderDashboard(root: HTMLElement): Promise<void> {
  unmountDashboard();
  const paint = async (): Promise<void> => {
    let d: Dashboard;
    try {
      d = await get<Dashboard>('/admin/dashboard');
    } catch (err) {
      render(root, html`<div class="errbox">${String(err)}</div>`);
      return;
    }
    const sum = (w: Record<Net, Window_>, k: keyof Window_): number =>
      ALL_NETS.reduce((a, n) => a + (w[n]?.[k] ?? 0), 0);
    const chainRows: Html[] = ALL_NETS.map((n) => {
      const c = d.chains[n];
      const status = !c.deployed
        ? html`<span class="tag">not deployed</span>`
        : c.error
          ? html`<span class="tag crit">rpc down</span>`
          : c.lagSeconds !== null && c.lagSeconds > 30
            ? html`<span class="tag warn">lagging</span>`
            : html`<span class="tag on">ok</span>`;
      const rpc = d.rpc[n];
      return html`<tr>
        <td>${netTag(n)}</td>
        <td>${status}</td>
        <td class="n">${c.head ?? '—'}</td>
        <td class="n">${c.cursor}</td>
        <td class="n">${c.behind ?? '—'}</td>
        <td class="n">${c.lagSeconds === null ? '—' : c.lagSeconds + 's'}</td>
        <td class="n">${rpc.calls}</td>
        <td class="n ${rpc.errorRate > 0.25 ? 'dn' : ''}">${(rpc.errorRate * 100).toFixed(1)}%</td>
        <td class="n">${c.failedAttempts}</td>
        <td class="n">${c.reorgs}</td>
        <td>${ago(c.lastEventAt, d.now)}</td>
        <td class="dm">${c.lastError ?? c.error ?? ''}</td>
      </tr>`;
    });
    render(
      root,
      html`<div class="sec-hd">
          <h1>Dashboard</h1>
          <span class="sub"
            >uptime ${Math.floor(d.uptimeSeconds / 60)}m · refreshed
            ${new Date(d.now).toISOString().slice(11, 19)}Z · auto 15s</span
          >
        </div>
        ${
          d.alerts.length
            ? html`<div class="alerts" style="margin-bottom:10px">
                ${d.alerts.map((a) => html`<div class="alert ${a.severity}"><span class="tag ${a.severity === 'critical' ? 'crit' : 'warn'}">${a.severity}</span>${a.message}</div>`)}
              </div>`
            : html`<div class="okbox" style="margin-bottom:10px">NO ACTIVE ALERTS</div>`
        }
        <div class="grid c4" style="margin-bottom:10px">
          ${stat('Launches today', String(sum(d.stats.today, 'launches')), `7d ${sum(d.stats.week, 'launches')}`)}
          ${stat('Trades today', num(sum(d.stats.today, 'trades')), `7d ${num(sum(d.stats.week, 'trades'))}`)}
          ${stat('Volume today', usd(sum(d.stats.today, 'volumeUsd')), `7d ${usd(sum(d.stats.week, 'volumeUsd'))}`, 'am')}
          ${stat('Protocol fees today (native)', num(sum(d.stats.today, 'feesNative'), 4), `7d ${num(sum(d.stats.week, 'feesNative'), 4)}`)}
          ${stat('WS connections', String(d.ws.connections), `peak ${d.ws.peakConnections} · subs ${d.ws.subscriptions}`)}
          ${stat('Requests', num(d.requests.total), `p50 ${d.requests.p50Ms}ms · p95 ${d.requests.p95Ms}ms · in-flight ${d.requests.inFlight}`)}
          ${stat('5xx', String(d.requests.byStatusClass['5xx'] ?? 0), `4xx ${d.requests.byStatusClass['4xx'] ?? 0}`, (d.requests.byStatusClass['5xx'] ?? 0) > 0 ? 'dn' : '')}
          ${stat('Dead letters', String(Object.values(d.deadLetters).reduce((a, b) => a + b, 0)), `pending indexer cmds ${d.pendingIndexerCommands}`)}
        </div>
        <div class="grid c2">
          ${panel(
            'Chains',
            table(
              [
                'net',
                'status',
                { label: 'head', num: true },
                { label: 'cursor', num: true },
                { label: 'behind', num: true },
                { label: 'lag', num: true },
                { label: 'rpc calls', num: true },
                { label: 'rpc err', num: true },
                { label: 'fails', num: true },
                { label: 'reorgs', num: true },
                'last event',
                'last error',
              ],
              chainRows,
            ),
            'indexer lag vs RPC head',
          )}
          ${panel(
            'Per net · today / 7d',
            table(
              [
                'net',
                { label: 'launches', num: true },
                { label: 'trades', num: true },
                { label: 'volume', num: true },
                { label: 'fees (native)', num: true },
              ],
              ALL_NETS.map((n) => {
                const t = d.stats.today[n];
                const w = d.stats.week[n];
                return html`<tr>
                  <td>${netTag(n)}</td>
                  <td class="n">${t.launches} / ${w.launches}</td>
                  <td class="n">${t.trades} / ${w.trades}</td>
                  <td class="n">${usd(t.volumeUsd)} / ${usd(w.volumeUsd)}</td>
                  <td class="n">${num(t.feesNative, 4)} / ${num(w.feesNative, 4)}</td>
                </tr>`;
              }),
            ),
          )}
          ${panel(
            'Top tokens · 24h volume',
            table(
              [
                'net',
                'sym',
                'mint',
                { label: 'volume', num: true },
                { label: 'trades', num: true },
              ],
              d.stats.topTokens.map(
                (t) =>
                  html`<tr>
                    <td>${netTag(t.net)}</td>
                    <td>
                      <a href="#/tokens?q=${encodeURIComponent(t.mint ?? t.sym)}&net=${t.net}"
                        >$${t.sym}</a
                      >
                    </td>
                    <td class="dm mono">${t.mint ?? '—'}</td>
                    <td class="n">${usd(t.volumeUsd)}</td>
                    <td class="n">${t.trades}</td>
                  </tr>`,
              ),
              'NO TRADES IN THE LAST 24H',
            ),
          )}
        </div>`,
    );
  };
  await paint();
  timer = window.setInterval(() => void paint(), 15_000);
}
