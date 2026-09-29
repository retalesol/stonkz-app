/**
 * The public face of the admin panel's comms: a maintenance banner and
 * per-net notices, read from `GET /platform/status` and painted above the
 * terminal's ticker tape. Loaded lazily by `app/shell.ts` in live mode, so
 * the main bundle only carries the dynamic import.
 */
interface Status {
  banner: { text: string; severity: string } | null;
  notices: { id: number; kind: string; text: string; severity: string; net: string | null }[];
  maintenance: { active: boolean; upcoming: { text: string; startsAt: number | null }[] };
}

const POLL_MS = 60_000;

export function mountBanner(base: string, net: () => string | null): void {
  let el: HTMLElement | null = null;
  const ensure = (): HTMLElement => {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'platformBanner';
    el.setAttribute('role', 'status');
    el.style.cssText =
      'display:none;padding:5px 12px;font:600 11px/1.4 "IBM Plex Mono",monospace;letter-spacing:.08em;' +
      'text-transform:uppercase;border-bottom:1px solid #c87c14;background:#150d02;color:#ffa22b';
    const tape = document.querySelector('.tape');
    (tape?.parentNode ?? document.body).insertBefore(el, tape ?? null);
    return el;
  };
  const paint = (s: Status): void => {
    const lines: string[] = [];
    if (s.banner?.text) lines.push(s.banner.text);
    for (const n of s.notices)
      if (n.kind !== 'banner') lines.push((n.net ? n.net + ' · ' : '') + n.text);
    const next = s.maintenance.upcoming[0];
    if (next?.startsAt)
      lines.push(
        'MAINTENANCE ' + new Date(next.startsAt).toUTCString().slice(0, 22) + ' UTC · ' + next.text,
      );
    const box = ensure();
    const severe =
      s.banner?.severity === 'critical' || s.notices.some((n) => n.severity === 'critical');
    box.style.color = severe ? '#ff4c3b' : '#ffa22b';
    box.style.borderBottomColor = severe ? '#ff4c3b' : '#c87c14';
    box.textContent = lines.join('   ·   ');
    box.style.display = lines.length ? 'block' : 'none';
  };
  const tick = async (): Promise<void> => {
    try {
      const n = net();
      const res = await fetch(
        base + '/platform/status' + (n ? '?net=' + encodeURIComponent(n) : ''),
      );
      if (!res.ok) return;
      paint((await res.json()) as Status);
    } catch {
      /* offline: keep whatever is painted */
    }
  };
  void tick();
  window.setInterval(() => void tick(), POLL_MS);
}
