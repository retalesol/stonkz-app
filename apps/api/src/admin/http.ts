import type { Context } from 'hono';
import { parseNet, type Net } from '@stonkz/shared';

/** Small body/query helpers shared by the `routes/admin-*.ts` files. */

export type Body = Record<string, unknown>;

export async function readBody(c: Context): Promise<Body> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : {};
}

export function str(v: unknown, max = 2000): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 || t.length > max ? undefined : t;
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function int(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

export function netParam(c: Context, name = 'net'): Net | null {
  return parseNet(c.req.param(name));
}

export function netQuery(c: Context, name = 'net'): Net | null {
  return parseNet(c.req.query(name) ?? null);
}

/**
 * Destructive actions require the client to echo a typed phrase. The panel
 * shows the exact phrase; a script cannot stumble into it by sending `true`.
 */
export function confirmed(body: Body, phrase: string): boolean {
  return str(body['confirm']) === phrase;
}

export function bad(c: Context, detail: string, status: 400 | 404 | 409 | 422 = 400): Response {
  return c.json({ error: status === 404 ? 'not_found' : 'bad_request', detail }, status);
}
