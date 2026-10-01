#!/usr/bin/env node
/**
 * Keep the Anchor IDL under version control.
 *
 * `anchor build` writes `programs/solana/target/idl/launchpad.json` and
 * `target/types/launchpad.ts`, and `target/` is git-ignored. Auditors, the
 * API (`apps/api/src/router/solana-idl.ts` hand-mirrors a slice of it) and
 * anyone verifying a deploy need the interface without a toolchain, so the
 * two files are committed under `programs/solana/idl/`.
 *
 *   node scripts/sync-idl.mjs            # anchor idl build → programs/solana/idl/
 *   node scripts/sync-idl.mjs --check    # exit 1 if the committed IDL differs
 *   node scripts/sync-idl.mjs --hash     # print sha256(target/deploy/launchpad.so), no IDL build
 *
 * `--check` regenerates the IDL into a temp dir with `anchor idl build` (no
 * program compile, no validator) and diffs byte for byte, so CI fails when
 * an instruction, account or event changed and the commit did not carry the
 * IDL. `--hash` prints the program binary's sha256 for
 * `programs/solana/deployments/<cluster>.json#programSha256`; run it on the
 * exact `anchor build` output you are about to `anchor deploy`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const solanaDir = join(root, 'programs/solana');
const outDir = join(solanaDir, 'idl');
const program = 'launchpad';
const files = [`${program}.json`, `${program}.ts`];

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const hash = args.has('--hash');

function build(dir) {
  const r = spawnSync(
    'anchor',
    ['idl', 'build', '-p', program, '-o', join(dir, files[0]), '-t', join(dir, files[1])],
    { cwd: solanaDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  if (r.error || r.status !== 0) {
    console.error(r.stderr || r.error?.message || 'anchor idl build failed');
    process.exit(2);
  }
  for (const f of files) {
    if (!existsSync(join(dir, f))) {
      console.error(`sync-idl: anchor idl build did not write ${f}`);
      process.exit(2);
    }
  }
}

if (check) {
  const tmp = mkdtempSync(join(tmpdir(), 'stonkz-idl-'));
  try {
    build(tmp);
    let stale = false;
    for (const f of files) {
      const committed = join(outDir, f);
      if (!existsSync(committed)) {
        console.error(`sync-idl: ${committed} is missing; run node scripts/sync-idl.mjs`);
        stale = true;
        continue;
      }
      if (readFileSync(committed, 'utf8') !== readFileSync(join(tmp, f), 'utf8')) {
        console.error(`sync-idl: programs/solana/idl/${f} differs from anchor idl build output`);
        stale = true;
      }
    }
    if (stale) {
      console.error('sync-idl: run `node scripts/sync-idl.mjs` and commit programs/solana/idl/.');
      process.exit(1);
    }
    console.log('sync-idl: programs/solana/idl/ matches anchor idl build');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else if (!hash) {
  build(outDir);
  for (const f of files) {
    // Normalise to a trailing newline so the committed files diff cleanly.
    const p = join(outDir, f);
    const s = readFileSync(p, 'utf8');
    if (!s.endsWith('\n')) writeFileSync(p, s + '\n');
  }
  console.log(`sync-idl: wrote ${files.map((f) => `programs/solana/idl/${f}`).join(', ')}`);
}

if (hash) {
  const so = join(solanaDir, 'target/deploy', `${program}.so`);
  if (!existsSync(so)) {
    console.error(`sync-idl: ${so} not found; run anchor build first`);
    process.exit(2);
  }
  const digest = createHash('sha256').update(readFileSync(so)).digest('hex');
  console.log(`programSha256 ${digest}  (programs/solana/target/deploy/${program}.so)`);
}
