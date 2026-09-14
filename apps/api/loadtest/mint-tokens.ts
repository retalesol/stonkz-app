/**
 * Mints real, verifiable JWT access tokens for every wallet `seed.ts` wrote
 * to `loadtest/fixtures/wallets.json`, so the k6 write-path scripts
 * (`trade-launch-prepare.js`) can call `POST /trade/prepare` and
 * `POST /launch/prepare` — both behind `requireAuth()` — without driving a
 * SIWS/SIWE signature flow per virtual user.
 *
 * This does not weaken what is being tested: `requireAuth()` (`app/
 * middleware.ts`) only ever checks a token's signature, issuer, expiry and
 * the Redis deny-list — never that a session row exists for it — so a token
 * signed with the same `JWT_SECRET`/`JWT_ISSUER` the running API was booted
 * with is indistinguishable, on this path, from one `AuthService.issue()`
 * produced after a real signature check. The signature flow itself is a
 * one-time, cheap operation that is not on the "hottest paths" list this
 * suite targets.
 *
 * Usage — must match the API's env exactly, or `requireAuth()` rejects every
 * token with 401:
 *   JWT_SECRET=... JWT_ISSUER=... ACCESS_TOKEN_TTL_SECONDS=... \
 *     tsx loadtest/mint-tokens.ts
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import type { Net } from '@stonkz/shared';
import { DEV_JWT_SECRET } from '../src/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const JWT_SECRET = process.env['JWT_SECRET'] ?? DEV_JWT_SECRET;
const JWT_ISSUER = process.env['JWT_ISSUER'] ?? 'https://api.ston.kz';
const ACCESS_TTL_SECONDS = Number(process.env['ACCESS_TOKEN_TTL_SECONDS'] ?? 900);

async function main(): Promise<void> {
  const wallets = JSON.parse(readFileSync(join(HERE, 'fixtures', 'wallets.json'), 'utf8')) as Record<Net, string[]>;
  const key = new TextEncoder().encode(JWT_SECRET);
  const iat = Math.floor(Date.now() / 1000);

  const out: Record<Net, { wallet: string; token: string }[]> = { SOL: [], RH: [], BASE: [] };
  for (const net of ['SOL', 'RH', 'BASE'] as const) {
    for (const wallet of wallets[net] ?? []) {
      const token = await new SignJWT({ sub: wallet, net, typ: 'access', jti: randomBytes(16).toString('hex') })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(JWT_ISSUER)
        .setIssuedAt(iat)
        .setExpirationTime(iat + ACCESS_TTL_SECONDS)
        .sign(key);
      out[net].push({ wallet, token });
    }
  }

  writeFileSync(join(HERE, 'fixtures', 'auth.json'), JSON.stringify(out, null, 2));
  console.log(`minted ${out.SOL.length} SOL + ${out.RH.length} RH access tokens -> loadtest/fixtures/auth.json`);
  if (JWT_SECRET === DEV_JWT_SECRET) {
    console.log('using the dev default JWT_SECRET — fine for a local stack, never for anything reachable from the internet.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
