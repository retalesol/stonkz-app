import { describe, expect, it, vi } from 'vitest';
import {
  fetchEvmHoldersFromExplorer,
  fetchEvmHoldersFromRpc,
  fetchSolHoldersFromRpc,
  holdersApiBase,
} from './token-holders.js';

/* MEMEMAN on Base Sepolia, read back from Blockscout on 2026-09-29. */
const MINT = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const LP_ATOMS = '999999694421351741896502';
const CREATOR_ATOMS = '305578648258103498';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('holdersApiBase', () => {
  it('swaps an Etherscan-family explorer for the public Blockscout of that chain', () => {
    expect(holdersApiBase('https://sepolia.basescan.org', 84532)).toBe(
      'https://base-sepolia.blockscout.com',
    );
    expect(holdersApiBase('https://basescan.org/', 8453)).toBe('https://base.blockscout.com');
  });

  it('keeps a Blockscout or unknown explorer, and honours an override', () => {
    expect(holdersApiBase('https://explorer.testnet.robinhood.com/', 46630)).toBe(
      'https://explorer.testnet.robinhood.com',
    );
    expect(holdersApiBase('https://sepolia.basescan.org', 84532, 'https://my.blockscout/')).toBe(
      'https://my.blockscout',
    );
  });
});

describe('fetchEvmHoldersFromExplorer', () => {
  it('reads the legacy getTokenHolders shape and tags the launchpad', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      expect(u).toContain('base-sepolia.blockscout.com/api?module=token&action=getTokenHolders');
      return jsonResponse({
        status: '1',
        result: [
          { address: LAUNCHPAD.toLowerCase(), value: LP_ATOMS },
          { address: CREATOR.toLowerCase(), value: CREATOR_ATOMS },
        ],
      });
    });
    const res = await fetchEvmHoldersFromExplorer({
      mint: MINT,
      launchpad: LAUNCHPAD,
      decimals: 18,
      explorerUrl: 'https://sepolia.basescan.org',
      chainId: 84532,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.source).toBe('explorer');
    expect(res.holders).toHaveLength(2);
    expect(res.holders[0]).toMatchObject({ kind: 'curve', curve: true });
    expect(res.holders[0]?.amount).toBeCloseTo(999_999.6944, 3);
    expect(res.holders[1]).toMatchObject({ kind: 'wallet', curve: false });
    expect(res.holders[1]?.amount).toBeCloseTo(0.3055786482581035, 12);
  });

  it('falls through to the v2 endpoint and follows next_page_params', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('action=getTokenHolders')) return jsonResponse({ status: '0', result: [] });
      if (u.includes('items_count=50')) {
        return jsonResponse({
          items: [{ address: { hash: CREATOR }, value: CREATOR_ATOMS }],
          next_page_params: null,
        });
      }
      return jsonResponse({
        items: [{ address: { hash: LAUNCHPAD }, value: LP_ATOMS }],
        next_page_params: { items_count: 50, value: '1' },
      });
    });
    const res = await fetchEvmHoldersFromExplorer({
      mint: MINT,
      launchpad: LAUNCHPAD,
      limit: 100,
      explorerUrl: 'https://base-sepolia.blockscout.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(calls.filter((c) => c.includes('/api/v2/tokens/'))).toHaveLength(2);
    expect(res.holders.map((h) => h.kind)).toEqual(['curve', 'wallet']);
  });

  it('throws when neither shape answers, so the route can fall back', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 404));
    await expect(
      fetchEvmHoldersFromExplorer({
        mint: MINT,
        explorerUrl: 'https://base-sepolia.blockscout.com',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('fetchEvmHoldersFromRpc', () => {
  const hex = (atoms: string): string => '0x' + BigInt(atoms).toString(16).padStart(64, '0');

  it('verifies candidate wallets by balanceOf and drops zero balances', async () => {
    const seen: string[] = [];
    const rpc = {
      async ethCall(to: string, data: string): Promise<string> {
        expect(to).toBe(MINT);
        expect(data.startsWith('0x70a08231')).toBe(true);
        const owner = '0x' + data.slice(-40);
        seen.push(owner);
        if (owner === LAUNCHPAD.toLowerCase()) return hex(LP_ATOMS);
        if (owner === CREATOR.toLowerCase()) return hex(CREATOR_ATOMS);
        return hex('0');
      },
    };
    const res = await fetchEvmHoldersFromRpc({
      mint: MINT,
      launchpad: LAUNCHPAD,
      wallets: [
        CREATOR,
        CREATOR.toLowerCase(),
        '0x00000000000000000000000000000000000000aa',
        'junk',
      ],
      rpc,
    });
    // Deduped case-insensitively, junk skipped.
    expect(seen).toHaveLength(3);
    expect(res.source).toBe('rpc');
    expect(res.holders.map((h) => h.kind)).toEqual(['curve', 'wallet']);
    expect(res.holders[1]?.wallet).toBe(CREATOR);
  });

  it('refuses a token with no code (every call answers 0x) rather than reporting nobody holds it', async () => {
    const rpc = { ethCall: async () => '0x' };
    await expect(
      fetchEvmHoldersFromRpc({ mint: MINT, launchpad: LAUNCHPAD, wallets: [CREATOR], rpc }),
    ).rejects.toThrow(/no code|no data/i);
  });
});

describe('fetchSolHoldersFromRpc', () => {
  const VAULT = 'Cu5ve11111111111111111111111111111111111111';
  const ATA_A = 'AtaA111111111111111111111111111111111111111';
  const ATA_B = 'AtaB111111111111111111111111111111111111111';
  const OWNER = 'Own1111111111111111111111111111111111111111';

  it('resolves token accounts to owners, folds one owner, and tags the vault', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === 'getTokenLargestAccounts') {
        return jsonResponse({
          result: {
            value: [
              { address: VAULT, amount: '800000000000', decimals: 6, uiAmount: 800_000 },
              { address: ATA_A, amount: '1500000000', decimals: 6, uiAmount: 1_500 },
              { address: ATA_B, amount: '500000000', decimals: 6, uiAmount: 500 },
            ],
          },
        });
      }
      expect(body.method).toBe('getMultipleAccounts');
      expect(body.params[0]).toEqual([ATA_A, ATA_B]);
      return jsonResponse({
        result: {
          value: [
            { data: { parsed: { info: { owner: OWNER } } } },
            { data: { parsed: { info: { owner: OWNER } } } },
          ],
        },
      });
    });
    const res = await fetchSolHoldersFromRpc({
      mint: 'Mint111111111111111111111111111111111111111',
      tagged: { [VAULT]: 'curve' },
      rpcUrl: 'http://rpc.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.source).toBe('rpc');
    expect(res.holders).toEqual([
      { wallet: VAULT, amount: 800_000, curve: true, kind: 'curve' },
      { wallet: OWNER, amount: 2_000, curve: false, kind: 'wallet' },
    ]);
  });

  it('surfaces an RPC error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Invalid param' } }));
    await expect(
      fetchSolHoldersFromRpc({
        mint: 'x',
        rpcUrl: 'http://rpc.test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('Invalid param');
  });
});
