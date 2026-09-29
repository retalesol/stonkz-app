import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { parseNet, type Net } from '@stonkz/shared';
import type { RedisLike } from '../redis/types.js';
import { isAdminRole, type AdminRole } from './roles.js';

/**
 * The admin step-up token.
 *
 * A separate JWT family from `auth/jwt.ts`: its own secret, `typ: "admin"`,
 * a dedicated audience, and a 15-minute life. `requireAdmin` only ever
 * accepts this token — a normal access token presented to `/admin/*` is a 404
 * like any other stranger's request — and the normal middleware only ever
 * accepts `typ: "access"`, so neither token can stand in for the other.
 */
export const ADMIN_AUDIENCE = 'stonkz-admin';

export interface AdminClaims extends JWTPayload {
  sub: string;
  /** Net of the session that stepped up. Informational; admin identity is the address. */
  net: Net;
  typ: 'admin';
  role: AdminRole;
  jti: string;
  /** True when TOTP was verified during this step-up. */
  mfa: boolean;
}

export interface AdminTokenConfig {
  secret: string;
  issuer: string;
  ttlSeconds: number;
}

export class AdminTokenService {
  private readonly key: Uint8Array;

  constructor(
    private readonly config: AdminTokenConfig,
    private readonly redis: RedisLike,
    private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(config.secret);
  }

  get ttlSeconds(): number {
    return this.config.ttlSeconds;
  }

  async issue(input: {
    address: string;
    net: Net;
    role: AdminRole;
    mfa: boolean;
  }): Promise<{ token: string; expiresAt: number; jti: string }> {
    const iat = Math.floor(this.now() / 1000);
    const jti = randomBytes(16).toString('hex');
    const token = await new SignJWT({
      net: input.net,
      typ: 'admin',
      role: input.role,
      mfa: input.mfa,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.address)
      .setJti(jti)
      .setAudience(ADMIN_AUDIENCE)
      .setIssuer(this.config.issuer)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.config.ttlSeconds)
      .sign(this.key);
    return { token, expiresAt: (iat + this.config.ttlSeconds) * 1000, jti };
  }

  /** Throws on anything but a live, un-revoked admin token. */
  async verify(token: string): Promise<AdminClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: this.config.issuer,
      audience: ADMIN_AUDIENCE,
      clockTolerance: 5,
      currentDate: new Date(this.now()),
    });
    const claims = payload as AdminClaims;
    if (claims.typ !== 'admin') throw new Error('not an admin token');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('missing sub');
    if (typeof claims.jti !== 'string' || !claims.jti) throw new Error('missing jti');
    if (!isAdminRole(claims.role)) throw new Error('missing role');
    if (parseNet(typeof claims.net === 'string' ? claims.net : null) === null)
      throw new Error('missing net');
    if (await this.redis.exists(`bl:admin:${claims.jti}`)) throw new Error('revoked');
    return claims;
  }

  async revoke(jti: string): Promise<void> {
    await this.redis.set(`bl:admin:${jti}`, '1', { ttlSeconds: this.config.ttlSeconds + 60 });
  }
}
