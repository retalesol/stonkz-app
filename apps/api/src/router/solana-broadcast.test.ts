import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../chain/types.js';
import { BroadcastFailedError, HttpSolanaBroadcaster } from './solana-broadcast.js';

interface Seen {
  url: string;
  method: string;
  params: unknown[];
}

/** A JSON-RPC fetch that answers per URL prefix and records every call. */
function fakeFetch(
  answers: Record<
    string,
    (params: unknown[]) => { result?: unknown; error?: { code: number; message: string } }
  >,
): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    seen.push({ url, method: body.method, params: body.params });
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const out = answers[key]!(body.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...out }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, seen };
}

const TX = 'AQID'; // any base64; the broadcaster never decodes it

describe('HttpSolanaBroadcaster', () => {
  it('reports which MEV modes have a route on this deployment', () => {
    const none = new HttpSolanaBroadcaster({ rpcUrl: 'http://rpc' });
    expect(none.routeFor('SHIELD')).toBe('none');
    expect(none.routeFor('RELAY')).toBe('none');
    expect(none.routeFor('OFF')).toBe('none');
    const all = new HttpSolanaBroadcaster({
      rpcUrl: 'http://rpc',
      jitoBlockEngineUrl: 'http://jito/',
      privateRpcUrl: 'http://private',
    });
    expect(all.routeFor('SHIELD')).toBe('jito');
    expect(all.routeFor('RELAY')).toBe('private');
    expect(all.routeFor('OFF')).toBe('none');
  });

  it('SHIELD sends to the Jito block engine, bundle-only, base64-encoded', async () => {
    const { fetchImpl, seen } = fakeFetch({ 'http://jito': () => ({ result: 'sigJito' }) });
    const b = new HttpSolanaBroadcaster({
      rpcUrl: 'http://rpc',
      jitoBlockEngineUrl: 'http://jito/',
      fetchImpl,
    });
    await expect(b.send(TX, 'SHIELD')).resolves.toEqual({ signature: 'sigJito', via: 'jito' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'http://jito/api/v1/transactions?bundleOnly=true',
      method: 'sendTransaction',
      params: [TX, { encoding: 'base64' }],
    });
  });

  it('falls back to the ordinary RPC when Jito refuses, and says so', async () => {
    const { fetchImpl, seen } = fakeFetch({
      'http://jito': () => ({ error: { code: -32602, message: 'no tip found' } }),
      'http://rpc': () => ({ result: 'sigRpc' }),
    });
    const b = new HttpSolanaBroadcaster({
      rpcUrl: 'http://rpc',
      jitoBlockEngineUrl: 'http://jito',
      fetchImpl,
    });
    const out = await b.send(TX, 'SHIELD');
    expect(out.signature).toBe('sigRpc');
    expect(out.via).toBe('rpc');
    expect(out.fallback).toMatch(/^jito: .*no tip found/);
    expect(seen.map((s) => s.url)).toEqual([
      'http://jito/api/v1/transactions?bundleOnly=true',
      'http://rpc',
    ]);
    // Preflight stays on for the public send.
    expect(seen[1]!.params[1]).toMatchObject({
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    });
  });

  it('RELAY sends through the private RPC, with no Jito involved', async () => {
    const { fetchImpl, seen } = fakeFetch({ 'http://private': () => ({ result: 'sigPriv' }) });
    const b = new HttpSolanaBroadcaster({
      rpcUrl: 'http://rpc',
      jitoBlockEngineUrl: 'http://jito',
      privateRpcUrl: 'http://private',
      fetchImpl,
    });
    await expect(b.send(TX, 'RELAY')).resolves.toEqual({ signature: 'sigPriv', via: 'private' });
    expect(seen.map((s) => s.url)).toEqual(['http://private']);
  });

  it('names the missing configuration when a protected mode has no route', async () => {
    const { fetchImpl } = fakeFetch({ 'http://rpc': () => ({ result: 'sigRpc' }) });
    const b = new HttpSolanaBroadcaster({ rpcUrl: 'http://rpc', fetchImpl });
    await expect(b.send(TX, 'SHIELD')).resolves.toEqual({
      signature: 'sigRpc',
      via: 'rpc',
      fallback: 'jito_not_configured',
    });
    await expect(b.send(TX, 'RELAY')).resolves.toMatchObject({
      fallback: 'private_rpc_not_configured',
    });
    await expect(b.send(TX, 'OFF')).resolves.toEqual({ signature: 'sigRpc', via: 'rpc' });
  });

  it('throws a structured 502 when every route refuses', async () => {
    const { fetchImpl } = fakeFetch({
      'http://jito': () => ({ error: { code: 1, message: 'jito down' } }),
      'http://rpc': () => ({ error: { code: 2, message: 'blockhash not found' } }),
    });
    const b = new HttpSolanaBroadcaster({
      rpcUrl: 'http://rpc',
      jitoBlockEngineUrl: 'http://jito',
      fetchImpl,
    });
    const err = await b.send(TX, 'SHIELD').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastFailedError);
    expect((err as BroadcastFailedError).httpStatus).toBe(502);
    expect((err as BroadcastFailedError).toResponse()).toMatchObject({ error: 'broadcast_failed' });
    expect((err as Error).message).toMatch(/jito: .*jito down; rpc: .*blockhash not found/);
  });
});
