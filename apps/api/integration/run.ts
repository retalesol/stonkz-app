/**
 * Entry point for the funded-testnet integration harness.
 *
 *   pnpm --filter @stonkz/api integration
 *   pnpm --filter @stonkz/api integration -- --only robinhood
 *
 * See integration/README.md for the environment it needs. With nothing set,
 * every scenario SKIPs and the run exits 0 while saying loudly that it proved
 * nothing — so this can be wired into a pipeline before the testnet exists
 * without producing a false green.
 */
import { runScenarios, type Scenario } from './harness.js';
import { baseAtomicRoundTrip, rhAtomicRoundTrip, solanaRoundTrip } from './scenarios/trade.js';
import {
  baseStakeRoundTrip,
  creatorFeesAndReferrals,
  rhStakeRoundTrip,
  solanaStakeRoundTrip,
} from './scenarios/stake.js';
import {
  rhGraduationBurn,
  rhOracleStalenessGuard,
  smartAccountLogin,
  solanaGraduationBurn,
  tipVerification,
} from './scenarios/verify.js';

const ALL: Scenario[] = [
  solanaRoundTrip,
  rhAtomicRoundTrip,
  baseAtomicRoundTrip,
  solanaStakeRoundTrip,
  rhStakeRoundTrip,
  baseStakeRoundTrip,
  creatorFeesAndReferrals,
  solanaGraduationBurn,
  rhGraduationBurn,
  rhOracleStalenessGuard,
  smartAccountLogin,
  tipVerification,
];

function selected(): Scenario[] {
  const idx = process.argv.indexOf('--only');
  if (idx === -1) return ALL;
  const needle = process.argv[idx + 1]?.toLowerCase();
  if (!needle) {
    console.error('--only needs a substring to match against scenario names');
    process.exit(2);
  }
  const matched = ALL.filter((s) => s.name.toLowerCase().includes(needle));
  if (matched.length === 0) {
    console.error(`no scenario matches "${needle}". Available:`);
    for (const s of ALL) console.error(`  ${s.name}`);
    process.exit(2);
  }
  return matched;
}

runScenarios(selected())
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('harness crashed:', err);
    process.exit(1);
  });
