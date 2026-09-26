import { readFileSync } from 'node:fs';
import type { EnvSource } from './env.js';

/**
 * `chains.json` as an env fallback.
 *
 * `scripts/emit-chains.mjs` merges every `programs/<chain>/deployments/<id>.json` into
 * one record (`apps/web/public/chains.json`). Pointing `STONKZ_CHAINS_FILE`
 * at that file lets the API pick up launchpad / router addresses and the
 * Solana program id from the same artifact the web app serves, so a deploy is
 * recorded once. Explicit env vars always win; the file only fills blanks.
 *
 * `STONKZ_ENV` selects the block: `dev` (test chains + Arc's capped mainnet,
 * the default) or `main`.
 */

interface ChainsDoc {
  dev?: Record<string, ChainRow>;
  main?: Record<string, ChainRow>;
}
interface ChainRow {
  launchpad?: string | null;
  router?: string | null;
  programId?: string | null;
}

const EVM_KEYS: ReadonlyArray<[net: string, launchpad: string, router: string]> = [
  ['RH', 'RH_LAUNCHPAD_ADDRESS', 'RH_ROUTER_ADDRESS'],
  ['BASE', 'BASE_LAUNCHPAD_ADDRESS', 'BASE_ROUTER_ADDRESS'],
  ['ARC', 'ARC_LAUNCHPAD_ADDRESS', 'ARC_ROUTER_ADDRESS'],
];

function blank(v: string | undefined): boolean {
  return v === undefined || v.trim() === '';
}

/** Pure overlay, for tests: `doc` stands in for the parsed file. */
export function overlayChains(src: EnvSource, doc: ChainsDoc, env: 'dev' | 'main'): EnvSource {
  const block = doc[env] ?? {};
  const out: EnvSource = { ...src };
  for (const [net, lpKey, rtKey] of EVM_KEYS) {
    const row = block[net];
    if (!row) continue;
    if (blank(out[lpKey]) && row.launchpad) out[lpKey] = row.launchpad;
    if (blank(out[rtKey]) && row.router) out[rtKey] = row.router;
  }
  const sol = block['SOL'];
  if (sol?.programId && blank(out['SOLANA_LAUNCHPAD_PROGRAM_ID'])) {
    out['SOLANA_LAUNCHPAD_PROGRAM_ID'] = sol.programId;
  }
  return out;
}

/** Apply `STONKZ_CHAINS_FILE` to an env source; a missing or unreadable file changes nothing. */
export function withChainsFile(src: EnvSource): EnvSource {
  const path = src['STONKZ_CHAINS_FILE'];
  if (blank(path)) return src;
  let doc: ChainsDoc;
  try {
    doc = JSON.parse(readFileSync(path as string, 'utf8')) as ChainsDoc;
  } catch (err) {
    console.warn(`[env] STONKZ_CHAINS_FILE=${path} could not be read: ${String(err)}`);
    return src;
  }
  const env = src['STONKZ_ENV'] === 'main' ? 'main' : 'dev';
  return overlayChains(src, doc, env);
}
