import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createTestApp, TEST_ORIGIN, type TestApp } from '../test/app.js';
import { contractWallet, evmWallet, solanaWallet } from '../test/wallets.js';
import { recoverSiweAddress } from '../auth/siwe.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
});

interface Challenge {
  nonce: string;
  message: string;
  chainId: string;
  domain: string;
}

async function nonce(net: 'SOL' | 'RH', address: string): Promise<Challenge> {
  const res = await h.app.request(`/auth/nonce?net=${net}&address=${encodeURIComponent(address)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Challenge;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return h.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** Review gate 1.B. */
describe('SIWS — Solana', () => {
  it('completes nonce -> sign -> JWT and binds address + net', async () => {
    const w = solanaWallet('gate-1b-sol');
    const challenge = await nonce('SOL', w.address);
    expect(challenge.chainId).toBe('solana:devnet');
    expect(challenge.message).toContain('wants you to sign in with your Solana account');
    expect(challenge.message).toContain(w.address);

    const res = await post('/auth/siws', {
      address: w.address,
      message: challenge.message,
      signature: w.sign(challenge.message),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      net: string;
      wallet: string;
      accessToken: string;
      created: boolean;
    };
    expect(body.net).toBe('SOL');
    expect(body.wallet).toBe(w.address);
    expect(body.created).toBe(true);

    // The `net` claim is what keeps a SOL session out of RH state.
    const claims = await h.deps.jwt.verify(body.accessToken, 'access');
    expect(claims.net).toBe('SOL');
    expect(claims.sub).toBe(w.address);
  });

  it('rejects a signature from a different key', async () => {
    const w = solanaWallet('victim');
    const attacker = solanaWallet('attacker');
    const challenge = await nonce('SOL', w.address);
    const res = await post('/auth/siws', {
      address: w.address,
      message: challenge.message,
      signature: attacker.sign(challenge.message),
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'bad_signature' });
  });

  it('refuses to reuse a nonce', async () => {
    const w = solanaWallet('replay');
    const challenge = await nonce('SOL', w.address);
    const payload = {
      address: w.address,
      message: challenge.message,
      signature: w.sign(challenge.message),
    };
    expect((await post('/auth/siws', payload)).status).toBe(200);

    const replay = await post('/auth/siws', payload);
    expect(replay.status).toBe(409);
    expect((await replay.json()) as { error: string }).toMatchObject({ error: 'nonce_used' });
  });

  it('refuses an expired nonce', async () => {
    const w = solanaWallet('slow');
    const challenge = await nonce('SOL', w.address);
    h.advance(h.deps.env.nonceTtlSeconds * 1000 + 1);
    const res = await post('/auth/siws', {
      address: w.address,
      message: challenge.message,
      signature: w.sign(challenge.message),
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'nonce_expired' });
  });

  it('refuses a tampered message even when the signature is valid for it', async () => {
    const w = solanaWallet('tamper');
    const challenge = await nonce('SOL', w.address);
    // Signing a *different* domain is exactly the phishing case.
    const tampered = challenge.message.replace('ston.kz', 'evil.example');
    const res = await post('/auth/siws', {
      address: w.address,
      message: tampered,
      signature: w.sign(tampered),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'message_mismatch' });
  });

  it('refuses a non-Solana address', async () => {
    const res = await post('/auth/siws', { address: '0xdeadbeef', message: 'x', signature: 'y' });
    expect(res.status).toBe(400);
  });
});

describe('SIWE — Robinhood', () => {
  it('completes the flow and binds net=RH', async () => {
    const w = evmWallet('gate-1b-rh');
    const challenge = await nonce('RH', w.address);
    expect(challenge.chainId).toBe(String(h.deps.env.rhChainId));
    expect(challenge.message).toContain('wants you to sign in with your Ethereum account');

    const res = await post('/auth/siwe', {
      address: w.address,
      message: challenge.message,
      signature: w.sign(challenge.message),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { net: string; wallet: string; accessToken: string };
    expect(body.net).toBe('RH');
    expect(body.wallet).toBe(w.address);
    expect((await h.deps.jwt.verify(body.accessToken, 'access')).net).toBe('RH');
  });

  it('will not accept a SOL nonce on the SIWE route', async () => {
    const w = evmWallet('crosswire');
    const challenge = await nonce('SOL', w.address);
    const res = await post('/auth/siwe', {
      address: w.address,
      message: challenge.message,
      signature: w.sign(challenge.message),
    });
    expect(res.status).toBe(400);
    // Since 284ae9a /auth/siwe reads the net off the nonce row (RH or BASE), so
    // a Solana nonce is refused as `bad_nonce` before any net comparison runs.
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'bad_nonce' });
  });

  it('rejects a signature recovered to another address', async () => {
    const w = evmWallet('rh-victim');
    const attacker = evmWallet('rh-attacker');
    const challenge = await nonce('RH', w.address);
    const res = await post('/auth/siwe', {
      address: w.address,
      message: challenge.message,
      signature: attacker.sign(challenge.message),
    });
    expect(res.status).toBe(401);
  });

  it('names the Robinhood testnet chain id in the challenge by default', async () => {
    // RH_CHAIN_ID defaults to the testnet (46630) since 284ae9a; mainnet 4663 is opt-in.
    const challenge = await nonce('RH', evmWallet('rh-chainid').address);
    expect(challenge.chainId).toBe('46630');
    expect(challenge.message).toContain('Chain ID: 46630');
  });

  it('logs in an ERC-4337 smart account through the EIP-1271 fallback', async () => {
    // Robinhood Chain treats account abstraction as first-class, so a
    // contract account is an ordinary user. Its signature does not recover to
    // its own address, so ecrecover alone would reject it as "invalid".
    const account = contractWallet('route-1271');
    h.rpcs.RH.setContract(account.address, (data) => account.ethCall(account.address, data));

    const challenge = await nonce('RH', account.address);
    const signature = account.sign(challenge.message);
    expect(recoverSiweAddress(challenge.message, signature)).toBe(account.ownerAddress);

    const res = await post('/auth/siwe', {
      address: account.address,
      message: challenge.message,
      signature,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { net: string; wallet: string };
    // The session binds to the account, never to the owner key behind it.
    expect(body.wallet).toBe(account.address);
    expect(body.wallet).not.toBe(account.ownerAddress);
    expect(body.net).toBe('RH');
  });

  it('still refuses a contract account when the owner did not sign', async () => {
    const account = contractWallet('route-1271-bad');
    const impostor = evmWallet('route-1271-impostor');
    h.rpcs.RH.setContract(account.address, (data) => account.ethCall(account.address, data));

    const challenge = await nonce('RH', account.address);
    const res = await post('/auth/siwe', {
      address: account.address,
      message: challenge.message,
      signature: impostor.sign(challenge.message),
    });
    expect(res.status).toBe(401);
  });

  it('refuses an address with no code behind it', async () => {
    // No `setContract`, so the fake returns empty data the way a node does.
    const account = contractWallet('route-1271-nocode');
    const challenge = await nonce('RH', account.address);
    const res = await post('/auth/siwe', {
      address: account.address,
      message: challenge.message,
      signature: account.sign(challenge.message),
    });
    expect(res.status).toBe(401);
  });

  it('does not let an RPC outage admit a contract account', async () => {
    const account = contractWallet('route-1271-outage');
    h.rpcs.RH.setContract(account.address, (data) => account.ethCall(account.address, data));
    const challenge = await nonce('RH', account.address);
    h.rpcs.RH.setFailing(true);

    const res = await post('/auth/siwe', {
      address: account.address,
      message: challenge.message,
      signature: account.sign(challenge.message),
    });
    // Fail closed: an unreachable chain is not evidence of a valid signature.
    expect(res.status).toBe(401);
    h.rpcs.RH.setFailing(false);
  });
});

describe('cross-environment replay', () => {
  it('refuses a staging challenge presented to production', async () => {
    // A signature minted against the staging chain id must not buy a
    // production session. Two guards stand in the way and this exercises the
    // outer one: nonces live in each environment's own database, so the
    // challenge is unknown here before its chain id is ever considered.
    const staging = await createTestApp({ env: { RH_CHAIN_ID: '46630' } });
    try {
      const w = evmWallet('replayer');
      const stagingRes = await staging.app.request(
        `/auth/nonce?net=RH&address=${encodeURIComponent(w.address)}`,
      );
      const challenge = (await stagingRes.json()) as { message: string; chainId: string };
      expect(challenge.chainId).toBe('46630');
      expect(challenge.message).toContain('Chain ID: 46630');

      const res = await h.app.request('/auth/siwe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
        body: JSON.stringify({
          address: w.address,
          message: challenge.message,
          signature: w.sign(challenge.message),
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'bad_nonce' });
    } finally {
      await staging.close();
    }
  });

  it('accepts a login when the environment allows several chain ids', async () => {
    const multi = await createTestApp({
      env: { RH_CHAIN_ID: '4663', RH_ALLOWED_CHAIN_IDS: '4663,46630' },
    });
    try {
      expect(multi.deps.env.allowedRhChainIds).toEqual([4663, 46630]);
      const { address } = await multi.login('RH', evmWallet('multi-chain'));
      expect(address).toBe(evmWallet('multi-chain').address);
    } finally {
      await multi.close();
    }
  });

  it('defaults the allow-list to the configured RH and Base ids', () => {
    // 284ae9a: with no EVM_ALLOWED_CHAIN_IDS the list is [rhChainId, baseChainId],
    // i.e. RH testnet 46630 plus Base Sepolia 84532.
    expect(h.deps.env.allowedRhChainIds).toEqual([h.deps.env.rhChainId, h.deps.env.baseChainId]);
    expect(h.deps.env.allowedRhChainIds).toEqual([46630, 84532]);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and kills the session on replay', async () => {
    const { refreshToken } = await h.login('SOL', solanaWallet('rotate'));

    const first = await post('/auth/refresh', { refreshToken });
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { refreshToken: string; accessToken: string };
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // Replaying the consumed token is a theft signal: the whole session dies.
    const replay = await post('/auth/refresh', { refreshToken });
    expect(replay.status).toBe(401);

    const afterRevoke = await post('/auth/refresh', { refreshToken: rotated.refreshToken });
    expect(afterRevoke.status).toBe(401);
  });

  it('logout revokes the access token immediately', async () => {
    const { token } = await h.login('SOL', solanaWallet('logout'));
    expect((await h.app.request('/me', { headers: authed(token) })).status).toBe(200);

    const out = await h.app.request('/auth/logout', { method: 'POST', headers: authed(token) });
    expect(out.status).toBe(200);

    // Still cryptographically valid, but deny-listed — no waiting for expiry.
    const after = await h.app.request('/me', { headers: authed(token) });
    expect(after.status).toBe(401);
    expect((await after.json()) as { error: string }).toMatchObject({ error: 'token_revoked' });
  });

  it('refuses a refresh token where an access token is required', async () => {
    const { refreshToken } = await h.login('SOL', solanaWallet('typeconf'));
    const res = await h.app.request('/me', { headers: authed(refreshToken) });
    expect(res.status).toBe(401);
  });

  it('rejects an expired access token', async () => {
    const { token } = await h.login('SOL', solanaWallet('expiry'));
    h.advance((h.deps.env.accessTokenTtlSeconds + 30) * 1000);
    expect((await h.app.request('/me', { headers: authed(token) })).status).toBe(401);
  });
});

describe('GET /me', () => {
  it('reads the native balance from the right chain and prices it from the oracle', async () => {
    const sol = solanaWallet('balances-sol');
    const rh = evmWallet('balances-rh');
    h.rpcs.SOL.setBalance(sol.address, 12.5);
    h.rpcs.RH.setBalance(rh.address, 3);

    const solSession = await h.login('SOL', sol);
    const solMe = (await (
      await h.app.request('/me', { headers: authed(solSession.token) })
    ).json()) as {
      net: string;
      native: { unit: string; balance: number; usdPrice: number; usdValue: number };
    };
    expect(solMe.net).toBe('SOL');
    expect(solMe.native).toMatchObject({ unit: 'SOL', balance: 12.5, usdPrice: 214.08 });
    expect(solMe.native.usdValue).toBeCloseTo(12.5 * 214.08, 6);

    const rhSession = await h.login('RH', rh);
    const rhMe = (await (
      await h.app.request('/me', { headers: authed(rhSession.token) })
    ).json()) as {
      net: string;
      native: { unit: string; balance: number; usdPrice: number };
    };
    expect(rhMe.net).toBe('RH');
    // Switching nets must not mix balances — different chain, different unit.
    expect(rhMe.native).toMatchObject({ unit: 'ETH', balance: 3, usdPrice: 4200 });
  });

  it('degrades to a null balance instead of failing when an RPC is down', async () => {
    const w = solanaWallet('rpc-down');
    const { token } = await h.login('SOL', w);
    h.rpcs.SOL.setFailing(true);
    const res = await h.app.request('/me', { headers: authed(token) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { native: { balance: null } }).toMatchObject({
      native: { balance: null },
    });
    h.rpcs.SOL.setFailing(false);
  });

  it('serves the footer price without a session, from the oracle not a constant', async () => {
    const res = await h.app.request('/native-price');
    expect(res.status).toBe(200);
    // The sim hardcoded $214.08; here it is whatever the oracle says.
    h.oracle.set('SOL', 191.42);
    const updated = (await (await h.app.request('/native-price')).json()) as {
      SOL: number;
      ETH: number;
    };
    expect(updated.SOL).toBe(191.42);
    expect(updated.ETH).toBe(4200);
    h.oracle.set('SOL', 214.08);
  });

  it('requires a token', async () => {
    expect((await h.app.request('/me')).status).toBe(401);
  });
});
