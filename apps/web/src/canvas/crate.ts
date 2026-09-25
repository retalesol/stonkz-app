/** The 8x8 crate sprite. `index.html:2221` */
const CSPR = [
  '........',
  '.======.',
  '.======.',
  '.######.',
  '.##oo##.',
  '.##oo##.',
  '.######.',
  '........',
];

/** Lighten (`amt > 0`) or darken a hex colour. `index.html:2222` */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt > 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    r *= 1 + amt;
    g *= 1 + amt;
    b *= 1 + amt;
  }
  return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
}

/** Paint a crate in its tier colour. `index.html:2229` */
export function drawCrate(cv: HTMLCanvasElement | null, col: string): void {
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const n = 8;
  const sz = cv.width / n;
  g.clearRect(0, 0, cv.width, cv.height);
  const lid = shade(col, 0.34);
  const dk = shade(col, -0.42);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const ch = (CSPR[y] as string)[x] as string;
      if (ch === '.') continue;
      g.fillStyle = ch === '=' ? lid : ch === 'o' ? '#120b02' : x === 6 || y === 6 ? dk : col;
      g.fillRect(x * sz, y * sz, sz, sz);
    }
  }
}
