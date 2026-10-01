#!/usr/bin/env node
/**
 * Merge every deployment record under programs/ into one `chains.json` that
 * the web app serves (`apps/web/public/chains.json`) and the API can read
 * (`STONKZ_CHAINS_FILE`). Addresses then get injected in one place instead
 * of being typed into Vercel and Railway separately; env vars still win.
 *
 *   node scripts/emit-chains.mjs            # writes apps/web/public/chains.json
 *   node scripts/emit-chains.mjs --check    # exits 1 if the file is stale
 *
 * Environments: `dev` holds test chains (Solana devnet, Base Sepolia, RH
 * testnet) and any capped mainnet used for testing (Arc); `main` holds the
 * production chains. A net missing from an environment is "not deployed
 * there yet" and the apps must refuse to trade it.
 *
 * Mainnet: `programs/evm/deployments/4663.json` (RH) and `8453.json` (Base)
 * do not exist until `script/DeployMainnet.s.sol` has been broadcast — it
 * prints the record to write, with the same `contracts` keys as the testnet
 * records (`StonkzLaunchpad`, `StonkzRouter`, `PythPriceSource`,
 * `UniswapV3Migrator`, `FeeLocker`, `StockPriceSourceV2`, `ReferralVault`,
 * `TimelockController`). Nothing here fabricates an address: until those
 * files exist `main` stays empty and the live build offers no EVM net.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evmDir = join(root, 'programs/evm/deployments');
const solDir = join(root, 'programs/solana/deployments');
const out = join(root, 'apps/web/public/chains.json');

/** EVM chain id -> [net, env]. Add a row when a new chain is deployed. */
const EVM_CHAINS = {
  46630: ['RH', 'dev'],
  4663: ['RH', 'main'],
  84532: ['BASE', 'dev'],
  8453: ['BASE', 'main'],
  // Arc has no testnet; its capped mainnet deployment serves the dev env too.
  5042: ['ARC', 'dev'],
  5042002: ['ARC', 'dev'],
};
const SOL_CLUSTERS = { devnet: 'dev', 'mainnet-beta': 'main', testnet: 'dev' };

const chains = { generatedAt: new Date().toISOString().slice(0, 10), dev: {}, main: {} };

for (const f of existsSync(evmDir) ? readdirSync(evmDir) : []) {
  if (!f.endsWith('.json')) continue;
  const rec = JSON.parse(readFileSync(join(evmDir, f), 'utf8'));
  const row = EVM_CHAINS[rec.chainId];
  if (!row) {
    console.warn(`emit-chains: ${f}: unknown chainId ${rec.chainId}, skipped`);
    continue;
  }
  const [net, env] = row;
  const c = rec.contracts ?? {};
  chains[env][net] = {
    kind: 'EVM',
    chainId: rec.chainId,
    network: rec.network,
    rpc: rec.rpc ?? null,
    explorer: rec.explorer ?? null,
    deployedAt: rec.deployedAt ?? null,
    launchpad: c.StonkzLaunchpad ?? null,
    router: c.StonkzRouter ?? null,
    // The installed graduation migrator: V3 + FeeLocker where rolled out, else V2.
    migrator: c.UniswapV3Migrator ?? c.UniswapV2Migrator ?? null,
    feeLocker: c.FeeLocker ?? null,
    // The launchpad's live price source: Pyth where rolled out, else the push oracle.
    priceSource: c.PythPriceSource ?? c.PushPriceSource ?? null,
    stockPriceSource: c.StockPriceSourceV2 ?? c.StockPriceSource ?? null,
    referralVault: c.ReferralVault ?? null,
    // Mainnet only: the TimelockController that is admin of everything.
    timelock: c.TimelockController ?? null,
    v2Factory: c.StonkzV2Factory ?? null,
    tokens: rec.tokens ?? {},
    // Arc: the router itself refuses buys above this (native wei).
    ...(net === 'ARC' ? { maxBuyNative: '25000000000000000000' } : {}),
  };
  if (env === 'dev' && chains.main[net] === undefined && net === 'ARC') {
    // The same capped deployment is Arc's mainnet entry.
    chains.main[net] = chains.dev[net];
  }
}

for (const f of existsSync(solDir) ? readdirSync(solDir) : []) {
  if (!f.endsWith('.json')) continue;
  const rec = JSON.parse(readFileSync(join(solDir, f), 'utf8'));
  const env = SOL_CLUSTERS[rec.cluster];
  if (!env) {
    console.warn(`emit-chains: ${f}: unknown cluster ${rec.cluster}, skipped`);
    continue;
  }
  chains[env].SOL = {
    kind: 'SVM',
    cluster: rec.cluster,
    programId: rec.programId,
    upgradeAuthority: rec.upgradeAuthority ?? null,
    deployedAt: rec.upgradedAt ?? rec.deployedAt ?? null,
  };
}

const next = JSON.stringify(chains, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const strip = (s) => s.replace(/"generatedAt": "[^"]*"/, '');
  if (strip(cur) !== strip(next)) {
    console.error(
      'emit-chains: apps/web/public/chains.json is stale; run `node scripts/emit-chains.mjs`',
    );
    process.exit(1);
  }
  console.log('emit-chains: up to date');
} else {
  writeFileSync(out, next);
  const nets = (env) => Object.keys(chains[env]).sort().join(', ') || '(none)';
  console.log(`emit-chains: wrote ${out}\n  dev:  ${nets('dev')}\n  main: ${nets('main')}`);
}
