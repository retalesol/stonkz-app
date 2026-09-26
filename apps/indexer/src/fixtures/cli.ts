import { EVENT_KINDS } from '../events.js';
import { canonicalScenario } from './producer.js';

/**
 * `pnpm --filter @stonkz/indexer fixtures [--json] [--seed 0x...]`
 *
 * Prints the canonical replay. Useful for eyeballing the event schema and for
 * piping into a seeded local database.
 */
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const seedArg = args[args.indexOf('--seed') + 1];
const seed = args.includes('--seed') && seedArg ? Number(seedArg) : undefined;

const { events, heads, actors } = canonicalScenario(seed);

if (asJson) {
  console.log(JSON.stringify({ events, heads, actors }, null, 2));
} else {
  const byKind = new Map<string, number>();
  for (const event of events) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);

  console.log(`${events.length} events; heads SOL=${heads.SOL} RH=${heads.RH}`);
  for (const kind of EVENT_KINDS) {
    console.log(`  ${kind.padEnd(20)} ${byKind.get(kind) ?? 0}`);
  }
  console.log('\nactors:');
  for (const [role, address] of Object.entries(actors))
    console.log(`  ${role.padEnd(12)} ${address}`);
}
