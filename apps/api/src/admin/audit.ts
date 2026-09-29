import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { adminAuditLog } from '../db/schema.js';

/**
 * The admin audit log. Append-only at the database (migration 0024's trigger
 * refuses UPDATE/DELETE), written by `audited()` from every mutating admin
 * route, and read back by the panel's Audit view and its CSV export.
 */
export interface AuditEntry {
  actor: string;
  actorNet: string;
  role: string;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
  ok?: boolean;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  actorNet: string;
  role: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  ok: boolean;
}

export interface AuditFilters {
  actor?: string | undefined;
  action?: string | undefined;
  target?: string | undefined;
  sinceMs?: number | undefined;
  untilMs?: number | undefined;
  beforeId?: number | undefined;
  limit?: number | undefined;
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async record(entry: AuditEntry): Promise<number> {
    const [row] = await this.db
      .insert(adminAuditLog)
      .values({
        at: new Date(this.now()),
        actor: entry.actor,
        actorNet: entry.actorNet,
        role: entry.role,
        action: entry.action,
        target: entry.target ?? null,
        before: entry.before === undefined ? null : entry.before,
        after: entry.after === undefined ? null : entry.after,
        ip: entry.ip ?? null,
        requestId: entry.requestId ?? null,
        ok: entry.ok ?? true,
      })
      .returning({ id: adminAuditLog.id });
    return row?.id ?? 0;
  }

  async list(filters: AuditFilters = {}): Promise<AuditRow[]> {
    const where: SQL[] = [];
    if (filters.actor) where.push(eq(adminAuditLog.actor, filters.actor));
    if (filters.action) where.push(eq(adminAuditLog.action, filters.action));
    if (filters.target) where.push(eq(adminAuditLog.target, filters.target));
    if (filters.sinceMs !== undefined) where.push(gte(adminAuditLog.at, new Date(filters.sinceMs)));
    if (filters.untilMs !== undefined) where.push(lte(adminAuditLog.at, new Date(filters.untilMs)));
    if (filters.beforeId !== undefined) where.push(lt(adminAuditLog.id, filters.beforeId));
    const rows = await this.db
      .select()
      .from(adminAuditLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(adminAuditLog.id))
      .limit(Math.min(Math.max(filters.limit ?? 100, 1), 1000));
    return rows.map((r) => ({
      id: r.id,
      at: r.at.getTime(),
      actor: r.actor,
      actorNet: r.actorNet,
      role: r.role,
      action: r.action,
      target: r.target,
      before: r.before,
      after: r.after,
      ip: r.ip,
      requestId: r.requestId,
      ok: r.ok,
    }));
  }
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function auditToCsv(rows: readonly AuditRow[]): string {
  const header = [
    'id',
    'at',
    'actor',
    'actor_net',
    'role',
    'action',
    'target',
    'before',
    'after',
    'ip',
    'request_id',
    'ok',
  ];
  const lines = rows.map((r) =>
    [
      r.id,
      new Date(r.at).toISOString(),
      r.actor,
      r.actorNet,
      r.role,
      r.action,
      r.target,
      r.before,
      r.after,
      r.ip,
      r.requestId,
      r.ok,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
