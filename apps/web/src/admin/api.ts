import type { Net } from '@stonkz/shared';

/**
 * The admin panel's HTTP client.
 *
 * Bearer tokens only (no cookies, so no CSRF surface). The short-lived admin
 * token lives in `sessionStorage` for the tab and is dropped on any 404 from
 * `/admin/*`, which is how the API says "not (or no longer) an admin".
 */
export const API_BASE: string = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';

const KEY = 'stonkz.admin.v1';

export interface AdminSession {
  adminToken: string;
  expiresAt: number;
  role: 'owner' | 'admin' | 'moderator' | 'viewer';
  mfa: boolean;
  wallet: string;
  net: Net;
}

let session: AdminSession | null = null;
const listeners = new Set<() => void>();

export function onSessionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function announce(): void {
  for (const cb of listeners) cb();
}

export function adminSession(): AdminSession | null {
  if (!session) {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) session = JSON.parse(raw) as AdminSession;
    } catch {
      session = null;
    }
  }
  if (session && session.expiresAt <= Date.now()) clearAdminSession();
  return session;
}

export function setAdminSession(next: AdminSession): void {
  session = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: in-memory only */
  }
  announce();
}

export function clearAdminSession(): void {
  session = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  announce();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly body: Record<string, unknown>,
  ) {
    super(detail || code || `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the normal access token instead of the admin token (the step-up routes). */
  accessToken?: string;
  raw?: boolean;
}

/** Calls the API. Admin routes get the admin bearer; a 404 there clears the session. */
export async function call<T = Record<string, unknown>>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.accessToken) headers['Authorization'] = `Bearer ${opts.accessToken}`;
  else {
    const s = adminSession();
    if (s) headers['Authorization'] = `Bearer ${s.adminToken}`;
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(API_BASE + path, init);
  if (opts.raw) return res as unknown as T;
  const body = await parse(res);
  if (!res.ok) {
    if (res.status === 404 && path.startsWith('/admin/') && !opts.accessToken && adminSession()) {
      // Token expired, revoked, or the role went away: back to the login screen.
      clearAdminSession();
    }
    throw new ApiError(
      res.status,
      String(body['error'] ?? 'error'),
      String(body['detail'] ?? body['error'] ?? `HTTP ${res.status}`),
      body,
    );
  }
  return body as T;
}

export const get = <T = Record<string, unknown>>(path: string): Promise<T> => call<T>(path);
export const post = <T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'PUT', body: body ?? {} });
export const patch = <T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'PATCH', body: body ?? {} });
export const del = <T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'DELETE', ...(body === undefined ? {} : { body }) });
