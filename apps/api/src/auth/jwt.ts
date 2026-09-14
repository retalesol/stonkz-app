import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Net } from '@stonkz/shared';

export type TokenType = 'access' | 'refresh';

/** `net` is in the claims (plan step 41) so a SOL session can never read RH state. */
export interface StonkzClaims extends JWTPayload {
  sub: string;
  net: Net;
  typ: TokenType;
  jti: string;
  sid?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  /** Session row id; also the refresh token's `sid` claim. */
  sessionId: string;
  accessJti: string;
}

export interface JwtConfig {
  secret: string;
  issuer: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export class JwtService {
  private readonly key: Uint8Array;

  constructor(
    private readonly config: JwtConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(config.secret);
  }

  private async sign(claims: Omit<StonkzClaims, 'iat' | 'exp' | 'iss'>, ttlSeconds: number): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.issuer)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttlSeconds)
      .sign(this.key);
  }

  async issue(net: Net, wallet: string, sessionId: string): Promise<TokenPair> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const accessJti = randomBytes(16).toString('hex');
    const [accessToken, refreshToken] = await Promise.all([
      this.sign({ sub: wallet, net, typ: 'access', jti: accessJti, sid: sessionId }, this.config.accessTtlSeconds),
      this.sign(
        { sub: wallet, net, typ: 'refresh', jti: randomBytes(16).toString('hex'), sid: sessionId },
        this.config.refreshTtlSeconds,
      ),
    ]);
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: (nowSeconds + this.config.accessTtlSeconds) * 1000,
      refreshExpiresAt: (nowSeconds + this.config.refreshTtlSeconds) * 1000,
      sessionId,
      accessJti,
    };
  }

  async verify(token: string, expected: TokenType): Promise<StonkzClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: this.config.issuer,
      clockTolerance: 5,
      currentDate: new Date(this.now()),
    });
    const claims = payload as StonkzClaims;
    if (claims.typ !== expected) throw new Error(`expected a ${expected} token, got ${String(claims.typ)}`);
    if (claims.net !== 'SOL' && claims.net !== 'RH' && claims.net !== 'BASE') {
      throw new Error('token is missing a valid net claim');
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('token is missing sub');
    return claims;
  }
}

/** Only the hash is stored, so a database leak does not hand over live sessions. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
