import { ALL_NETS } from '@stonkz/shared';
import { readEnv } from '../env.js';
import { createDb } from './client.js';
import { resetNets } from './reset-net.js';

/**
 * `pnpm --filter @stonkz/api reset-net RH BASE` — wipe the chain-derived rows
 * for those nets after a fresh launchpad deploy. Refuses without `--yes`
 * against anything but a local database.
 */
const args = process.argv.slice(2);
const yes = args.includes('--yes');
const nets = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
const known = new Set<string>(ALL_NETS);
const bad = nets.filter((n) => !known.has(n));
if (nets.length === 0 || bad.length > 0) {
  console.error(`usage: reset-net <NET...> [--yes]   (nets: ${ALL_NETS.join(', ')})`);
  process.exit(2);
}

const env = readEnv();
const local = /localhost|127\.0\.0\.1/.test(env.databaseUrl);
if (!local && !yes) {
  console.error('reset-net: non-local DATABASE_URL; pass --yes to confirm');
  process.exit(2);
}

const handle = createDb({ url: env.databaseUrl, singleConnection: true });
try {
  const r = await resetNets(handle.db, nets);
  for (const [table, n] of Object.entries(r.deleted)) console.log(`- ${table}: ${n}`);
  console.log(`treasuries zeroed: ${r.treasuriesZeroed}, cursors rewound: ${r.cursorsRewound}`);
  console.log(
    `reset ${nets.join(', ')}. Set INDEXER_<NET>_START_* to the new deploy block before rolling the indexer.`,
  );
} finally {
  await handle.close();
}
