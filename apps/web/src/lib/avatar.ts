/**
 * Default mememan avatars and display helpers.
 *
 * New users get `mememan.png` on a deterministic background colour derived
 * from their wallet so the same address always paints the same square.
 * A set `avatarUrl` (Pinata gateway) overrides that.
 */

export const MEMEMAN_SRC = '/images/mememan.png';
export const MEMEMAN_FULL_SRC = '/images/mememan_full.png';
export const STONKZ_HEAD_SRC = '/images/stonkz_head.png';

/** Saturated terminal colours that still read against the dark UI. */
export const AVATAR_BG: readonly string[] = [
  '#1a4a8a',
  '#8a2e1a',
  '#1a6a3a',
  '#6a1a7a',
  '#8a6a12',
  '#124a6a',
  '#6a2a4a',
  '#2a5a5a',
  '#4a3a8a',
  '#8a4a1a',
  '#1a6a6a',
  '#5a1a3a',
];

/** Stable background for a wallet / seed. */
export function avatarBgFor(seed: string | number): string {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const i = Math.abs(h) % AVATAR_BG.length;
  return AVATAR_BG[i] as string;
}

/**
 * Paints mememan (or a custom URL) into a square canvas. Custom images are
 * drawn cover-style; the default mememan is centred over the wallet colour.
 */
export function paintAvatar(
  cv: HTMLCanvasElement | null | undefined,
  opts: { seed: string | number; avatarUrl?: string | null; size?: number } = { seed: 0 },
): void {
  if (!cv) return;
  const size = opts.size ?? 64;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = size + 'px';
  cv.style.height = size + 'px';
  const g = cv.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  const bg = avatarBgFor(opts.seed);
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);

  const src = opts.avatarUrl?.trim() || MEMEMAN_SRC;
  const img = new Image();
  img.decoding = 'async';
  // Same-origin assets need no CORS; Pinata gateway does.
  if (src.startsWith('http')) img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (opts.avatarUrl) {
      // Cover crop into the square.
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const scale = Math.max(size / iw, size / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      g.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    } else {
      // Mememan: leave a little margin so the head breathes on the colour.
      const pad = size * 0.06;
      g.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
    }
  };
  img.onerror = () => {
    // Keep the solid colour square if the asset fails to load.
  };
  img.src = src;
}

/** HTML for an inline square avatar (chat / tape rows). Prefer canvas for paintAvatar. */
export function avatarStyle(seed: string | number, avatarUrl?: string | null): string {
  const bg = avatarBgFor(seed);
  if (avatarUrl) {
    return `background:${bg} url(${JSON.stringify(avatarUrl)}) center/cover no-repeat`;
  }
  return `background:${bg} url(${JSON.stringify(MEMEMAN_SRC)}) center/contain no-repeat`;
}
