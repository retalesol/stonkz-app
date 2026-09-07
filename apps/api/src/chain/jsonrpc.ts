import type { FetchLike } from './types.js';

let nextId = 1;

export interface JsonRpcOptions {
  timeoutMs?: number;
}

/**
 * Both chains speak JSON-RPC over HTTP — Solana natively, EVM via eth_*. One
 * caller keeps the timeout and error shape identical across them.
 */
export async function jsonRpc<T>(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  params: unknown[],
  { timeoutMs = 5000 }: JsonRpcOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${body.error.code} ${body.error.message}`);
    if (body.result === undefined) throw new Error('missing result');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}
