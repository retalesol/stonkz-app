/**
 * Admin roles.
 *
 * Four rungs, strictly ordered. `requireAdmin('moderator')` admits moderators,
 * admins and owners; `requireAdmin('owner')` only owners. The env list
 * (`ADMIN_WALLETS`) bootstraps owners and always wins over a DB row, so an
 * operator can never lock themselves out by demoting the last owner in the UI.
 */
export const ADMIN_ROLES = ['viewer', 'moderator', 'admin', 'owner'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const RANK: Record<AdminRole, number> = { viewer: 0, moderator: 1, admin: 2, owner: 3 };

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

export function roleAtLeast(have: AdminRole, need: AdminRole): boolean {
  return RANK[have] >= RANK[need];
}

/** The higher of two roles; used to merge env and DB grants. */
export function maxRole(a: AdminRole | null, b: AdminRole | null): AdminRole | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Canonical form of an admin identity. EVM addresses are lower-cased so the
 * checksum casing a wallet happens to emit never forks an identity; Solana
 * base58 is case-sensitive and kept verbatim.
 */
export function normaliseAdminAddress(address: string): string {
  const trimmed = address.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** `ADMIN_WALLETS` → normalised set. */
export function parseAdminWallets(list: readonly string[]): ReadonlySet<string> {
  return new Set(list.map(normaliseAdminAddress).filter(Boolean));
}
