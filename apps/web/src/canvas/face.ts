/**
 * The brand face — meme man, 32x32, one sprite cell per CSS pixel at 32px.
 * `index.html:1160`
 */
const MEMEMAN = [
  '..............KKKKKK............',
  '...........KKKLLLLLLKK..........',
  '.........KKLLLLLLLLLLLKK........',
  '........KLLLLLLLLLLLLLLLK.......',
  '.......KLLLLLLLLLLLLLLLLLK......',
  '......KLLLLLLLLLLLLLLLLLLK......',
  '.....KLLLLLLLLLLLLLLLLLLLLK.....',
  '....KLLLLLLLLLLLLLLLLLLLLLK.....',
  '....KLLLLLLLLLLLLLLLLLLLLLK.....',
  '...KLLLLMMMLLLLLLLLLLLLLLLK.....',
  '...KLLLMMMMMLLLLLLRRRLLRRRK.....',
  '...KLLLMMMMMLLLLLWWBBLWWBBK.....',
  '...KLLLMMMMMMLLLLLLLLLLLLLK.....',
  '...KLLLMMMMMMDLLLLLLLLLLLLK.....',
  '...KLLLMMMMMMDDLLLLLLLLLLLK.....',
  '...KLLLMMMMMMDDDLLLLLLLLLLK.....',
  '...KLLLMMMMMMDDDLLLLLLLLLK......',
  '...KLLLMMMMMMMDDLLLLLLLLLK......',
  '...KLLLMMMMMMMDDLLLLRRRLLK......',
  '....KLLMMMMMMMDDLLLLLRRLLK......',
  '....KLLMMMMMMMDDLLLLLLLLK.......',
  '....KLLMMMMMMMDDDLLLLLLK........',
  '.....KLLMMMMMMMDDLLLLLKK........',
  '.....KLLMMMMMMMDDLLLKK..........',
  '.....KLLMMMMMMMDDLLK............',
  '......KLLMMMMMMMDLK.............',
  '......KLLMMMMMMMDK..............',
  '......KLLLMMMMMMK...............',
  '......KLLLMMMMMMK...............',
  '.....KLLLLMMMMMMK...............',
  '.....KLLLLMMMMMMK...............',
  '.....KKKKKKKKKKK................',
];

const MMC: Record<string, string> = {
  K: '#0b0a08',
  L: '#ecd3ab',
  M: '#cfae86',
  D: '#9c8368',
  S: '#7d6650',
  W: '#dfe9f6',
  B: '#1e50a8',
  R: '#5c4430',
};

/** Stamp the face into an arbitrary context — the wizard art reuses it. */
export function paintFace(g: CanvasRenderingContext2D, ox: number, oy: number, size: number): void {
  const n = MEMEMAN.length;
  const sz = size / n;
  for (let y = 0; y < n; y++) {
    const row = MEMEMAN[y] as string;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      if (ch === '.') continue;
      g.fillStyle = MMC[ch] ?? '#ecd3ab';
      g.fillRect(ox + x * sz, oy + y * sz, Math.ceil(sz), Math.ceil(sz));
    }
  }
}

/** Paint the header brand canvas. `index.html:1207` */
export function drawFace(cv: HTMLCanvasElement | null): void {
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, cv.width, cv.height);
  paintFace(g, 0, 0, cv.width);
}
