/** Concatenate src/styles in import order and diff against the oracle's CSS. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const styles = join(here, '..', 'src', 'styles');
const html = readFileSync(join(here, '..', '..', '..', 'legacy', 'index.html'), 'utf8');

const head = html.match(/<style>(body\{margin:0\}[^<]*)<\/style>/)[1];
const main = html.match(/<style>\n(:root\{[\s\S]*?)\n<\/style>/)[1];
const oracle = head + '\n' + main + '\n';

const order = [...readFileSync(join(styles, 'index.css'), 'utf8').matchAll(/@import '\.\/(.+?)';/g)].map(
  (m) => m[1],
);
const got = order.map((f) => readFileSync(join(styles, f), 'utf8')).join('');

if (got === oracle) {
  console.log(`CSS concatenation is byte-identical to legacy/index.html (${oracle.length} bytes, ${order.length} files)`);
  process.exit(0);
}

const a = oracle.split('\n');
const b = got.split('\n');
console.error(`MISMATCH: oracle ${oracle.length}B/${a.length} lines, concat ${got.length}B/${b.length} lines`);
for (let i = 0, shown = 0; i < Math.max(a.length, b.length) && shown < 10; i++) {
  if (a[i] !== b[i]) {
    console.error(`  line ${i + 1}\n    oracle: ${JSON.stringify(a[i])}\n    concat: ${JSON.stringify(b[i])}`);
    shown++;
  }
}
process.exit(1);
