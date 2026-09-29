import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import { isEvmNet } from '@stonkz/shared';
import { verifySiweFull, type EthCaller } from '../auth/siwe.js';
import { verifySiws } from '../auth/siws.js';
import type { Db } from '../db/client.js';
import { adminChallenges, adminRoles, adminTotp } from '../db/schema.js';
import type { RedisLike } from '../redis/types.js';
import { isAdminRole, maxRole, normaliseAdminAddress, type AdminRole } from './roles.js';
import type { AdminTokenService } from './token.js';
import { generateTotpSecret, openSecret, otpauthUri, sealSecret, verifyTotp } from './totp.js';

export class AdminAuthError extends Error {
  constructor(
    readonly code:
      | 'not_admin'
      | 'bad_challenge'
      | 'challenge_expired'
      | 'challenge_used'
      | 'bad_signature'
      | 'totp_required'
      | 'bad_totp'
      | 'totp_not_enrolled'
      | 'last_owner',
    message: string,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export interface AdminAuthOptions {
  db: Db;
  redis: RedisLike;
  tokens: AdminTokenService;
  /** Normalised env owners (`parseAdminWallets`). */
  envOwners: ReadonlySet<string>;
  /** Signs the step-up message: `SIWS_DOMAIN`. */
  domain: string;
  adminSecret: string;
  challengeTtlSeconds: number;
  ethCaller?: EthCaller;
  now?: () => number;
}

export interface StepUpChallenge {
  nonce: string;
  message: string;
  expiresAt: number;
  totpRequired: boolean;
}

export interface StepUpResult {
  token: string;
  expiresAt: number;
  role: AdminRole;
  mfa: boolean;
}

export const ADMIN_STEP_UP_STATEMENT =
  'Stonkz admin step-up. Signing grants a 15-minute admin session for this wallet. No transaction, no gas.';

/** The message the admin's wallet signs; rebuilt server-side, so any client edit fails the equality check. */
export function buildStepUpMessage(p: {
  domain: string;
  net: Net;
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    `${p.domain} admin step-up`,
    '',
    ADMIN_STEP_UP_STATEMENT,
    '',
    `Wallet: ${p.address}`,
    `Network: ${p.net}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expires At: ${p.expiresAt}`,
  ].join('\n');
}

/**
 * Admin identity, roles and the step-up ceremony.
 *
 * A caller reaches `stepUp()` already holding a normal SIWS/SIWE session; this
 * adds a *second* signature over a fresh nonce (5-minute TTL, single-use) and
 * — once enrolled — a TOTP code, and only then mints the short-lived admin
 * token. Roles are resolved live on every admin request from the env list
 * plus `admin_roles`, so a revoke in the panel is immediate.
 */
export class AdminAuthService {
  private readonly now: () => number;
  private readonly roleCache = new Map<string, { at: number; role: AdminRole | null }>();

  constructor(private readonly opts: AdminAuthOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db(): Db {
    return this.opts.db;
  }

  /** True when anyone at all can be an admin — an empty env list and no DB rows means the panel is dark. */
  hasAnyOwner(): boolean {
    return this.opts.envOwners.size > 0;
  }

  /** Env owners win; otherwise the DB row. Cached for 2 s per process to keep `/admin/*` cheap. */
  async roleFor(rawAddress: string): Promise<AdminRole | null> {
    const address = normaliseAdminAddress(rawAddress);
    const envRole: AdminRole | null = this.opts.envOwners.has(address) ? 'owner' : null;
    const cached = this.roleCache.get(address);
    if (cached && this.now() - cached.at < 2_000) return maxRole(envRole, cached.role);
    const [row] = await this.db
      .select({ role: adminRoles.role })
      .from(adminRoles)
      .where(eq(adminRoles.wallet, address))
      .limit(1);
    const dbRole = row && isAdminRole(row.role) ? row.role : null;
    this.roleCache.set(address, { at: this.now(), role: dbRole });
    return maxRole(envRole, dbRole);
  }

  async listRoles(): Promise<
    {
      wallet: string;
      role: AdminRole;
      source: 'env' | 'db';
      grantedBy: string | null;
      note: string | null;
      totp: boolean;
    }[]
  > {
    const rows = await this.db.select().from(adminRoles);
    const totps = await this.db
      .select({ wallet: adminTotp.wallet, enabledAt: adminTotp.enabledAt })
      .from(adminTotp);
    const totpOn = new Set(totps.filter((t) => t.enabledAt !== null).map((t) => t.wallet));
    const out = new Map<
      string,
      {
        wallet: string;
        role: AdminRole;
        source: 'env' | 'db';
        grantedBy: string | null;
        note: string | null;
        totp: boolean;
      }
    >();
    for (const w of this.opts.envOwners) {
      out.set(w, {
        wallet: w,
        role: 'owner',
        source: 'env',
        grantedBy: null,
        note: 'ADMIN_WALLETS',
        totp: totpOn.has(w),
      });
    }
    for (const r of rows) {
      if (!isAdminRole(r.role)) continue;
      const existing = out.get(r.wallet);
      if (existing && existing.source === 'env') continue;
      out.set(r.wallet, {
        wallet: r.wallet,
        role: r.role,
        source: 'db',
        grantedBy: r.grantedBy,
        note: r.note,
        totp: totpOn.has(r.wallet),
      });
    }
    return [...out.values()];
  }

  async grantRole(
    rawAddress: string,
    role: AdminRole,
    by: string,
    note: string | null,
  ): Promise<{ before: AdminRole | null; after: AdminRole }> {
    const address = normaliseAdminAddress(rawAddress);
    const before = await this.roleFor(address);
    const at = new Date(this.now());
    await this.db
      .insert(adminRoles)
      .values({ wallet: address, role, grantedBy: by, note, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: adminRoles.wallet,
        set: { role, grantedBy: by, note, updatedAt: at },
      });
    this.roleCache.delete(address);
    return { before, after: role };
  }

  async revokeRole(
    rawAddress: string,
  ): Promise<{ before: AdminRole | null; after: AdminRole | null }> {
    const address = normaliseAdminAddress(rawAddress);
    const before = await this.roleFor(address);
    if (this.opts.envOwners.has(address)) {
      throw new AdminAuthError(
        'last_owner',
        'env-listed owners can only be removed from ADMIN_WALLETS',
      );
    }
    await this.db.delete(adminRoles).where(eq(adminRoles.wallet, address));
    this.roleCache.delete(address);
    return { before, after: await this.roleFor(address) };
  }

  /* ------------------------------------------------------------------ TOTP */

  async totpEnabled(rawAddress: string): Promise<boolean> {
    const [row] = await this.db
      .select({ enabledAt: adminTotp.enabledAt })
      .from(adminTotp)
      .where(eq(adminTotp.wallet, normaliseAdminAddress(rawAddress)))
      .limit(1);
    return !!row?.enabledAt;
  }

  /** Starts (or restarts an unconfirmed) enrolment. Confirmed enrolments must be disabled first. */
  async beginTotpEnrolment(rawAddress: string): Promise<{ secret: string; otpauth: string }> {
    const address = normaliseAdminAddress(rawAddress);
    if (await this.totpEnabled(address))
      throw new AdminAuthError('bad_totp', 'TOTP is already enabled; disable it first');
    const secret = generateTotpSecret();
    const at = new Date(this.now());
    await this.db
      .insert(adminTotp)
      .values({
        wallet: address,
        secretEnc: sealSecret(secret, this.opts.adminSecret),
        enabledAt: null,
        createdAt: at,
      })
      .onConflictDoUpdate({
        target: adminTotp.wallet,
        set: {
          secretEnc: sealSecret(secret, this.opts.adminSecret),
          enabledAt: null,
          createdAt: at,
        },
      });
    return { secret, otpauth: otpauthUri(secret, address) };
  }

  /** A correct code against the pending secret turns enforcement on. */
  async confirmTotpEnrolment(rawAddress: string, code: string): Promise<void> {
    const address = normaliseAdminAddress(rawAddress);
    const [row] = await this.db
      .select()
      .from(adminTotp)
      .where(eq(adminTotp.wallet, address))
      .limit(1);
    if (!row) throw new AdminAuthError('totp_not_enrolled', 'no enrolment in progress');
    if (row.enabledAt) throw new AdminAuthError('bad_totp', 'TOTP is already enabled');
    const secret = openSecret(row.secretEnc, this.opts.adminSecret);
    if (!verifyTotp(secret, code, this.now()).ok)
      throw new AdminAuthError('bad_totp', 'code did not verify');
    await this.db
      .update(adminTotp)
      .set({ enabledAt: new Date(this.now()) })
      .where(eq(adminTotp.wallet, address));
  }

  /** Requires a current code, so a stolen admin token alone cannot switch MFA off. */
  async disableTotp(rawAddress: string, code: string): Promise<void> {
    const address = normaliseAdminAddress(rawAddress);
    const [row] = await this.db
      .select()
      .from(adminTotp)
      .where(eq(adminTotp.wallet, address))
      .limit(1);
    if (!row) throw new AdminAuthError('totp_not_enrolled', 'TOTP is not enrolled');
    const secret = openSecret(row.secretEnc, this.opts.adminSecret);
    if (!verifyTotp(secret, code, this.now()).ok)
      throw new AdminAuthError('bad_totp', 'code did not verify');
    await this.db.delete(adminTotp).where(eq(adminTotp.wallet, address));
  }

  private async checkTotp(address: string, code: string | undefined): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(adminTotp)
      .where(eq(adminTotp.wallet, address))
      .limit(1);
    if (!row?.enabledAt) return false;
    if (!code) throw new AdminAuthError('totp_required', 'a TOTP code is required for this admin');
    const secret = openSecret(row.secretEnc, this.opts.adminSecret);
    const lastKey = `admin:totp:last:${address}`;
    const lastRaw = await this.opts.redis.get(lastKey);
    const last = lastRaw === null ? null : Number.parseInt(lastRaw, 10);
    const verdict = verifyTotp(
      secret,
      code,
      this.now(),
      Number.isFinite(last as number) ? last : null,
    );
    if (!verdict.ok) throw new AdminAuthError('bad_totp', 'TOTP code did not verify');
    await this.opts.redis.set(lastKey, String(verdict.counter), { ttlSeconds: 120 });
    return true;
  }

  /* --------------------------------------------------------------- step-up */

  /** Only for wallets that hold a role — anything else is a 404 upstream, so the challenge table never learns strangers. */
  async issueChallenge(net: Net, rawWallet: string): Promise<StepUpChallenge> {
    const address = normaliseAdminAddress(rawWallet);
    const role = await this.roleFor(address);
    if (!role) throw new AdminAuthError('not_admin', 'not an admin');

    const nonce = randomBytes(16).toString('hex');
    const issuedMs = this.now();
    const expiresMs = issuedMs + this.opts.challengeTtlSeconds * 1000;
    const message = buildStepUpMessage({
      domain: this.opts.domain,
      net,
      address: rawWallet,
      nonce,
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
    });
    await this.db.insert(adminChallenges).values({
      nonce,
      net,
      wallet: rawWallet,
      message,
      issuedAt: new Date(issuedMs),
      expiresAt: new Date(expiresMs),
    });
    await this.db
      .delete(adminChallenges)
      .where(lt(adminChallenges.expiresAt, new Date(issuedMs - 3_600_000)));
    return { nonce, message, expiresAt: expiresMs, totpRequired: await this.totpEnabled(address) };
  }

  async stepUp(input: {
    net: Net;
    wallet: string;
    message: string;
    signature: string;
    totp?: string | undefined;
  }): Promise<StepUpResult> {
    const address = normaliseAdminAddress(input.wallet);
    const role = await this.roleFor(address);
    if (!role) throw new AdminAuthError('not_admin', 'not an admin');

    const nonceLine = input.message.split('\n').find((l) => l.startsWith('Nonce: '));
    const nonce = nonceLine?.slice('Nonce: '.length) ?? '';
    const [row] = await this.db
      .select()
      .from(adminChallenges)
      .where(eq(adminChallenges.nonce, nonce))
      .limit(1);
    if (
      !row ||
      row.net !== input.net ||
      row.wallet !== input.wallet ||
      row.message !== input.message
    ) {
      throw new AdminAuthError('bad_challenge', 'challenge does not match');
    }
    if (row.consumedAt) throw new AdminAuthError('challenge_used', 'challenge already used');
    if (row.expiresAt.getTime() <= this.now())
      throw new AdminAuthError('challenge_expired', 'challenge expired');

    const ok = isEvmNet(input.net)
      ? await verifySiweFull(
          { message: input.message, signature: input.signature, address: input.wallet },
          this.opts.ethCaller,
        )
      : verifySiws({ message: input.message, signature: input.signature, address: input.wallet });
    if (!ok) throw new AdminAuthError('bad_signature', 'signature does not verify');

    const consumed = await this.db
      .update(adminChallenges)
      .set({ consumedAt: new Date(this.now()) })
      .where(and(eq(adminChallenges.nonce, nonce), isNull(adminChallenges.consumedAt)))
      .returning({ nonce: adminChallenges.nonce });
    if (consumed.length === 0) throw new AdminAuthError('challenge_used', 'challenge already used');

    const mfa = await this.checkTotp(address, input.totp);
    const issued = await this.opts.tokens.issue({ address, net: input.net, role, mfa });
    return { token: issued.token, expiresAt: issued.expiresAt, role, mfa };
  }
}
