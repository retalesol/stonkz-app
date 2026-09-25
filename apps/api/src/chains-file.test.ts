import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { overlayChains, withChainsFile } from './chains-file.js';

const doc = {
  dev: {
    SOL: { programId: 'FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg' },
    RH: {
      launchpad: '0x2588E500B1e5fCF18253F44b6f2607BF2B14161C',
      router: '0x16487D4ABf800F6Fd8b8A074D86a35e46fD23883',
    },
    BASE: { launchpad: '0x02032371b6B2173211b8aa0Fa90c216d6a3a4E3A', router: null },
  },
  main: {
    ARC: { launchpad: '0x000000000000000000000000000000000000a4c0', router: null },
  },
};

describe('chains.json as an env fallback', () => {
  it('fills blank launchpad / router / program keys from the selected env block', () => {
    const out = overlayChains({}, doc, 'dev');
    expect(out['RH_LAUNCHPAD_ADDRESS']).toBe(doc.dev.RH.launchpad);
    expect(out['RH_ROUTER_ADDRESS']).toBe(doc.dev.RH.router);
    expect(out['BASE_LAUNCHPAD_ADDRESS']).toBe(doc.dev.BASE.launchpad);
    expect(out['BASE_ROUTER_ADDRESS']).toBeUndefined();
    expect(out['SOLANA_LAUNCHPAD_PROGRAM_ID']).toBe(doc.dev.SOL.programId);
    // Nothing on Arc in dev: the API keeps refusing Arc trades.
    expect(out['ARC_LAUNCHPAD_ADDRESS']).toBeUndefined();
  });

  it('never overrides an explicit env value', () => {
    const out = overlayChains(
      { RH_LAUNCHPAD_ADDRESS: '0xexplicit', RH_ROUTER_ADDRESS: '  ' },
      doc,
      'dev',
    );
    expect(out['RH_LAUNCHPAD_ADDRESS']).toBe('0xexplicit');
    // Whitespace counts as blank, the same way env.ts's `str()` reads it.
    expect(out['RH_ROUTER_ADDRESS']).toBe(doc.dev.RH.router);
  });

  it('selects the main block on STONKZ_ENV=main', () => {
    const out = overlayChains({}, doc, 'main');
    expect(out['ARC_LAUNCHPAD_ADDRESS']).toBe(doc.main.ARC.launchpad);
    expect(out['RH_LAUNCHPAD_ADDRESS']).toBeUndefined();
  });

  it('reads the file named by STONKZ_CHAINS_FILE and ignores a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stonkz-chains-'));
    const path = join(dir, 'chains.json');
    writeFileSync(path, JSON.stringify(doc));
    const out = withChainsFile({ STONKZ_CHAINS_FILE: path });
    expect(out['BASE_LAUNCHPAD_ADDRESS']).toBe(doc.dev.BASE.launchpad);

    const untouched = { STONKZ_CHAINS_FILE: join(dir, 'nope.json'), FOO: 'bar' };
    expect(withChainsFile(untouched)).toEqual(untouched);
    expect(withChainsFile({})).toEqual({});
  });
});
