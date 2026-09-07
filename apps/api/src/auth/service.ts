import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { authNonces, sessions, users } from '../db/schema.js';
import { blacklistToken } from '../redis/blacklist.js';
import type { RedisLike } from '../redis/types.js';
import { hashRefreshToken, type JwtService, type TokenPair } from './jwt.js';
import {
  SIWS_STATEMENT,
  buildSignInMessage,
  chainLabel,
  parseSignInMessage,
} from './message.js';
import { isEvmAddress, toChecksumAddress, verifySiwe } from './siwe.js';
import { isSolanaAddress, verifySiws } from './siws.js';

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'bad_address'
      | 'bad_nonce'
      | 'nonce_expired'
      | 'nonce_used'
      | 'net_mismatch'
      | 'message_mismatch'
      | 'bad_signature'
      | 'session_revoked'
      | 'bad_token',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceOptions {
  db: Db;
  redis: RedisLike;
  jwt: JwtService;
  domain: string;
  /** The `URI` line of the signed message. */
  uri: string;
  rhChainId: number;
  nonceTtlSeconds: number;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  now?: () => number;
}

export interface NonceChallenge {
  nonce: string;
  net: Net;
  domain: string;
  uri: string;
  chainId: string;
  statement: string;
  issuedAt: string;
  expiresAt: string;
  /** Exactly what the wallet must sign. Sent so the client never composes it. */
  message: string;
}

export interface LoginInput {
  net: Net;
  address: string;
  message: string;
  signature: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface LoginResult extends TokenPair {
  net: Net;
  wallet: string;
  /** True the first time this address authenticates. */
  created: boolean;
}

/**
 * SIWS and SIWE in one flow.
 *
 * The two chains differ only in how a signature maps to an address, so the
 * nonce lifecycle, the message equality check and the session write are shared.
 * Both bind `address` *and* `net`: the nonce is issued for a net, the signed
 * message names that net's chain id, and the JWT carries it in the claims.
 */
export class AuthService {
  private readonly now: () => number;

  constructor(private readonly opts: AuthServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** `GET /auth/nonce` — one single-use challenge, bound to a net. */
  async issueNonce(net: Net, address?: string): Promise<NonceChallenge> {
    const nonce = randomBytes(16).toString('hex');
    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.opts.nonceTtlSeconds * 1000;
    const issuedAt = new Date(issuedAtMs).toISOString();
    const chainId = chainLabel(net, this.opts.rhChainId);

    await this.db.insert(authNonces).values({
      nonce,
      net,
      domain: this.opts.domain,
      statement: SIWS_STATEMENT,
      issuedAt: new Date(issuedAtMs),
      expiresAt: new Date(expiresAtMs),
    });

    // Opportunistic sweep; the partial index makes this cheap.
    await this.db.delete(authNonces).where(lt(authNonces.expiresAt, new Date(issuedAtMs - 3_600_000)));

    return {
      nonce,
      net,
      domain: this.opts.domain,
      uri: this.opts.uri,
      chainId,
      statement: SIWS_STATEMENT,
      issuedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      message: buildSignInMessage({
        net,
        domain: this.opts.domain,
        address: address ?? '<ADDRESS>',
        statement: SIWS_STATEMENT,
        uri: this.opts.uri,
        nonce,
        issuedAt,
        chainId,
      }),
    };
  }

  private get db(): Db {
    return this.opts.db;
  }

  private normaliseAddress(net: Net, address: string): string {
    if (net === 'SOL') {
      if (!isSolanaAddress(address)) throw new AuthError('bad_address', 'not a Solana address');
      return address;
    }
    if (!isEvmAddress(address)) throw new AuthError('bad_address', 'not an EVM address');
    // Store one canonical casing so `(net, wallet)` cannot fork per capitalisation.
    return toChecksumAddress(address);
  }

  /** `POST /auth/siws` and `POST /auth/siwe`. */
  async login(input: LoginInput): Promise<LoginResult> {
    const wallet = this.normaliseAddress(input.net, input.address);

    const parsed = parseSignInMessage(input.message);
    if (!parsed) throw new AuthError('message_mismatch', 'unparseable sign-in message');

    const [row] = await this.db.select().from(authNonces).where(eq(authNonces.nonce, parsed.nonce)).limit(1);
    if (!row) throw new AuthError('bad_nonce', 'unknown nonce');
    if (row.net !== input.net) throw new AuthError('net_mismatch', 'nonce was issued for a different network');
    if (row.consumedAt !== null) throw new AuthError('nonce_used', 'nonce already used');
    if (row.expiresAt.getTime() <= this.now()) throw new AuthError('nonce_expired', 'nonce expired');

    // Rebuild the message from server-held facts. Anything the client changed —
    // domain, uri, chain id, statement, or the address itself — fails here.
    const expected = buildSignInMessage({
      net: input.net,
      domain: row.domain,
      address: input.address,
      statement: row.statement,
      uri: this.opts.uri,
      nonce: row.nonce,
      issuedAt: parsed.issuedAt,
      chainId: chainLabel(input.net, this.opts.rhChainId),
    });
    if (expected !== input.message) throw new AuthError('message_mismatch', 'signed message does not match the challenge');
    if (parsed.issuedAt !== row.issuedAt.toISOString()) {
      throw new AuthError('message_mismatch', 'issuedAt does not match the challenge');
    }

    const ok =
      input.net === 'SOL'
        ? verifySiws({ message: input.message, signature: input.signature, address: input.address })
        : verifySiwe({ message: input.message, signature: input.signature, address: input.address });
    if (!ok) throw new AuthError('bad_signature', 'signature does not verify');

    // Single-use: the UPDATE only lands if nobody else consumed it first.
    const consumed = await this.db
      .update(authNonces)
      .set({ consumedAt: new Date(this.now()), consumedBy: wallet })
      .where(and(eq(authNonces.nonce, row.nonce), isNull(authNonces.consumedAt)))
      .returning({ nonce: authNonces.nonce });
    if (consumed.length === 0) throw new AuthError('nonce_used', 'nonce already used');

    const inserted = await this.db
      .insert(users)
      .values({ net: input.net, wallet })
      .onConflictDoNothing()
      .returning({ wallet: users.wallet });

    return { ...(await this.createSession(input.net, wallet, input.userAgent, input.ip)), net: input.net, wallet, created: inserted.length > 0 };
  }

  private async createSession(
    net: Net,
    wallet: string,
    userAgent?: string | undefined,
    ip?: string | undefined,
  ): Promise<TokenPair> {
    const expiresAt = new Date(this.now() + this.opts.refreshTtlSeconds * 1000);
    const [session] = await this.db
      .insert(sessions)
      .values({
        net,
        wallet,
        // Replaced immediately below; the row id is needed for the `sid` claim.
        refreshHash: `pending:${randomBytes(16).toString('hex')}`,
        expiresAt,
        userAgent: userAgent ?? null,
        ip: ip ?? null,
      })
      .returning({ id: sessions.id });
    if (!session) throw new AuthError('bad_token', 'could not create a session');

    const pair = await this.opts.jwt.issue(net, wallet, session.id);
    await this.db
      .update(sessions)
      .set({ refreshHash: hashRefreshToken(pair.refreshToken) })
      .where(eq(sessions.id, session.id));
    return pair;
  }

  /** Rotates the refresh token — a replayed old one is a theft signal, so the session dies. */
  async refresh(refreshToken: string): Promise<LoginResult> {
    const claims = await this.opts.jwt.verify(refreshToken, 'refresh').catch(() => {
      throw new AuthError('bad_token', 'invalid refresh token');
    });
    const hash = hashRefreshToken(refreshToken);
    const [row] = await this.db.select().from(sessions).where(eq(sessions.refreshHash, hash)).limit(1);
    if (!row) {
      if (claims.sid) {
        await this.db
          .update(sessions)
          .set({ revokedAt: new Date(this.now()) })
          .where(and(eq(sessions.id, claims.sid), isNull(sessions.revokedAt)));
      }
      throw new AuthError('session_revoked', 'refresh token has already been rotated');
    }
    if (row.revokedAt !== null) throw new AuthError('session_revoked', 'session revoked');
    if (row.expiresAt.getTime() <= this.now()) throw new AuthError('session_revoked', 'session expired');
    if (row.net !== claims.net || row.wallet !== claims.sub) {
      throw new AuthError('bad_token', 'refresh token does not match its session');
    }

    const pair = await this.opts.jwt.issue(row.net as Net, row.wallet, row.id);
    await this.db
      .update(sessions)
      .set({ refreshHash: hashRefreshToken(pair.refreshToken), issuedAt: new Date(this.now()) })
      .where(eq(sessions.id, row.id));
    return { ...pair, net: row.net as Net, wallet: row.wallet, created: false };
  }

  /** Kills the refresh session in Postgres and the access token in Redis. */
  async logout(accessJti: string | null, sessionId: string | null): Promise<void> {
    if (accessJti) await blacklistToken(this.opts.redis, accessJti, this.opts.accessTtlSeconds + 60);
    if (sessionId) {
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date(this.now()) })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    }
  }

  async countLiveSessions(net: Net, wallet: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.net, net), eq(sessions.wallet, wallet), isNull(sessions.revokedAt)));
    return rows[0]?.n ?? 0;
  }
}
