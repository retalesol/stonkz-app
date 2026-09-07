import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRedis } from '../redis/memory.js';
import { createTestDb, type TestDb } from '../test/harness.js';
import { evmWallet } from '../test/wallets.js';
import { JwtService } from './jwt.js';
import { AuthError, AuthService } from './service.js';

let db: TestDb;
const NOW = Date.parse('2026-09-06T12:00:00.000Z');

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
});

function service(opts: { rhChainId: number; allowedRhChainIds?: readonly number[] }): AuthService {
  const now = () => NOW;
  return new AuthService({
    db: db.db,
    redis: new MemoryRedis(now),
    jwt: new JwtService(
      {
        secret: 'test-secret-that-is-at-least-32-chars-long',
        issuer: 'https://api.ston.kz',
        accessTtlSeconds: 900,
        refreshTtlSeconds: 2_592_000,
      },
      now,
    ),
    domain: 'ston.kz',
    uri: 'https://ston.kz',
    rhChainId: opts.rhChainId,
    ...(opts.allowedRhChainIds ? { allowedRhChainIds: opts.allowedRhChainIds } : {}),
    nonceTtlSeconds: 300,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
    now,
  });
}

/**
 * The chain-id guard is defence in depth: a login also has to match a message
 * the server rebuilt from its own configuration, which normally makes the two
 * checks agree by construction. It becomes load-bearing exactly when they
 * disagree — a deploy configured to sign one chain id while accepting a
 * different set — so that is what these drive directly.
 */
describe('chain id enforcement', () => {
  const wallet = evmWallet('svc-chain');

  async function login(auth: AuthService) {
    const challenge = await auth.issueNonce('RH', wallet.address);
    return auth.login({
      net: 'RH',
      address: wallet.address,
      message: challenge.message,
      signature: wallet.sign(challenge.message),
    });
  }

  it('admits a login on the configured id', async () => {
    const result = await login(service({ rhChainId: 4663 }));
    expect(result.wallet).toBe(wallet.address);
    expect(result.net).toBe('RH');
  });

  it('refuses a chain id missing from the allow-list, even though it signed the message', async () => {
    // A misconfigured deploy: it hands out 4663 challenges but only trusts
    // the testnet id. Failing closed with a diagnosable error beats issuing
    // sessions nobody intended to allow.
    const auth = service({ rhChainId: 4663, allowedRhChainIds: [46630] });
    await expect(login(auth)).rejects.toThrow(AuthError);
    await expect(login(auth)).rejects.toMatchObject({ code: 'chain_mismatch' });
  });

  it('admits the id when the allow-list carries several', async () => {
    const result = await login(service({ rhChainId: 46630, allowedRhChainIds: [4663, 46630] }));
    expect(result.net).toBe('RH');
  });

  it('does not treat a Solana sign-in as an EVM chain id', async () => {
    const auth = service({ rhChainId: 4663, allowedRhChainIds: [46630] });
    const challenge = await auth.issueNonce('SOL', 'ignored');
    // `solana:mainnet` is not an integer, so a naive parse would reject every
    // Solana login the moment the EVM allow-list narrowed.
    expect(challenge.chainId).toBe('solana:mainnet');
  });
});

describe('nonce lifecycle', () => {
  const wallet = evmWallet('svc-nonce');

  it('refuses an unknown nonce', async () => {
    const auth = service({ rhChainId: 4663 });
    const challenge = await auth.issueNonce('RH', wallet.address);
    const forged = challenge.message.replace(challenge.nonce, 'f'.repeat(32));
    await expect(
      auth.login({
        net: 'RH',
        address: wallet.address,
        message: forged,
        signature: wallet.sign(forged),
      }),
    ).rejects.toMatchObject({ code: 'bad_nonce' });
  });

  it('burns a nonce on use', async () => {
    const auth = service({ rhChainId: 4663 });
    const challenge = await auth.issueNonce('RH', wallet.address);
    const input = {
      net: 'RH' as const,
      address: wallet.address,
      message: challenge.message,
      signature: wallet.sign(challenge.message),
    };
    await auth.login(input);
    await expect(auth.login(input)).rejects.toMatchObject({ code: 'nonce_used' });
  });

  it('marks only the first login as created', async () => {
    const auth = service({ rhChainId: 4663 });
    const first = await login(auth, wallet);
    const second = await login(auth, wallet);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  async function login(auth: AuthService, w: ReturnType<typeof evmWallet>) {
    const challenge = await auth.issueNonce('RH', w.address);
    return auth.login({
      net: 'RH',
      address: w.address,
      message: challenge.message,
      signature: w.sign(challenge.message),
    });
  }
});
