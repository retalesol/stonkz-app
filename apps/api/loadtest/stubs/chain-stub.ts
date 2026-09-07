/**
 * A local stand-in for the Solana RPC, the Robinhood Chain RPC, and the
 * Coinbase-shaped price oracle `apps/api` talks to.
 *
 * `apps/api/src/server.ts` always builds real `SolanaRpc`/`EvmRpc`/
 * `HttpPriceOracle` clients — there is no env toggle to swap in
 * `chain/fake.ts` outside the test suite (that harness injects it via
 * `DepsOverrides`, which only unit/integration tests construct). Load-testing
 * `/trade/prepare` (every buy calls `getLatestBlockhash`; every buy also
 * reads `getBalance`) and `/tokens/:sym/quote` (an oracle read on a cold
 * cache) against the *real* public Solana RPC or the *real* Robinhood public
 * RPC would measure Solana Labs' and Robinhood's rate limits, not this API —
 * and would very likely get this machine's IP throttled or banned mid-run.
 *
 * This is the same call the indexer already makes explicit for its own event
 * source (`INDEXER_SOURCE=fixtures`, logged loudly on boot): stand in for a
 * dependency that either does not exist yet in this environment (a funded
 * devnet fleet of test wallets) or is actively hostile to load-testing
 * traffic (a public RPC), and say so instead of quietly pretending the
 * numbers below are end-to-end against production infrastructure.
 *
 * `LATENCY_MS` defaults to 60ms — a realistic RTT for a paid Helius/Alchemy-
 * style provider endpoint, not the 0ms a naive stub would give the API for
 * free. Point `SOLANA_RPC_URL` / `RH_RPC_URL` / `PRICE_ORACLE_URL` at this
 * server's three routes and every other code path in `apps/api` is
 * untouched — the stub only answers the handful of methods those two RPC
 * clients and `HttpPriceOracle` actually call (see `src/chain/solana.ts`,
 * `src/chain/evm.ts`, `src/chain/oracle.ts`).
 *
 *   tsx loadtest/stubs/chain-stub.ts
 *   # -> Solana RPC   http://127.0.0.1:9081/solana
 *   #    Robinhood RPC http://127.0.0.1:9081/evm
 *   #    Price oracle  http://127.0.0.1:9081  (GET /:PRODUCT/spot)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env['STUB_PORT'] ?? 9081);
const LATENCY_MS = Number(process.env['STUB_LATENCY_MS'] ?? 60);
const SOL_USD = Number(process.env['STUB_SOL_USD'] ?? 214.08);
const ETH_USD = Number(process.env['STUB_ETH_USD'] ?? 4200);

// Defaults match `apps/indexer`'s fixture scenario heads exactly (see its
// boot log: `heads {"SOL":250000168,"RH":21000010}`), so a freshly-caught-up
// fixture indexer reads as perfectly healthy (`behind: 0`) instead of
// "degraded" against an arbitrary stub number that happens to be close.
let solSlot = Number(process.env['STUB_SOL_SLOT'] ?? 250_000_168);
let evmBlock = Number(process.env['STUB_RH_BLOCK'] ?? 21_000_010);
// Off by default: `apps/indexer`'s fixture scenario is a small, fixed batch
// of events (`fixtures/producer.ts` — "a couple of tokens per net"), so a
// head that keeps advancing after the indexer drains it would make
// `/health`'s chain-lag alert fire forever, which is an artifact of this
// stub outrunning a bounded fixture, not a real stall. Set STUB_TICK=1 to
// simulate an actually-live, ever-advancing chain (e.g. to exercise the lag
// alert itself).
if (process.env['STUB_TICK'] === '1') {
  setInterval(() => {
    solSlot += 12;
    evmBlock += 1;
  }, 1000).unref();
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const FAKE_BLOCKHASH = '11111111111111111111111111111111';
// Any fixed 32-byte-looking hex value; `nativeBalance()`/`eth_getBalance` only
// need to parse, never verify, this address.
const FAKE_BALANCE_LAMPORTS = 5_000_000_000; // 5 SOL
const FAKE_BALANCE_WEI = '0x' + (5n * 10n ** 18n).toString(16); // 5 ETH

async function handleSolanaRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  await delay();
  const method = body['method'];
  const id = body['id'] ?? null;
  switch (method) {
    case 'getSlot':
      sendJson(res, { jsonrpc: '2.0', id, result: solSlot });
      return;
    case 'getBalance':
      sendJson(res, { jsonrpc: '2.0', id, result: { context: { slot: solSlot }, value: FAKE_BALANCE_LAMPORTS } });
      return;
    case 'getLatestBlockhash':
      sendJson(res, {
        jsonrpc: '2.0',
        id,
        result: { context: { slot: solSlot }, value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: solSlot + 150 } },
      });
      return;
    default:
      sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `stub: unhandled method ${String(method)}` } });
  }
}

async function handleEvmRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  await delay();
  const method = body['method'];
  const id = body['id'] ?? null;
  switch (method) {
    case 'eth_chainId':
      sendJson(res, { jsonrpc: '2.0', id, result: `0x${Number(process.env['STUB_RH_CHAIN_ID'] ?? 4663).toString(16)}` });
      return;
    case 'eth_blockNumber':
      sendJson(res, { jsonrpc: '2.0', id, result: `0x${evmBlock.toString(16)}` });
      return;
    case 'eth_getBalance':
      sendJson(res, { jsonrpc: '2.0', id, result: FAKE_BALANCE_WEI });
      return;
    case 'eth_call':
      // No contract code at any address the stub knows about — a codeless
      // read, which every real client already treats as "not a 4337/1271
      // account" rather than an error (`src/chain/evm.ts:ethCall`).
      sendJson(res, { jsonrpc: '2.0', id, result: '0x' });
      return;
    default:
      sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `stub: unhandled method ${String(method)}` } });
  }
}

async function handleOracle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  await delay();
  const amount = pathname.startsWith('/SOL-USD/') ? SOL_USD : pathname.startsWith('/ETH-USD/') ? ETH_USD : null;
  if (amount === null) {
    sendJson(res, { error: `stub: unknown product ${pathname}` }, 404);
    return;
  }
  sendJson(res, { data: { amount: String(amount) } });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  void (async () => {
    try {
      if (url.pathname === '/solana') return await handleSolanaRpc(req, res);
      if (url.pathname === '/evm') return await handleEvmRpc(req, res);
      return await handleOracle(req, res, url.pathname);
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })();
});

server.listen(PORT, () => {
  console.log(`chain-stub listening on :${PORT} (latency ${LATENCY_MS}ms)`);
  console.log(`  SOLANA_RPC_URL=http://127.0.0.1:${PORT}/solana`);
  console.log(`  RH_RPC_URL=http://127.0.0.1:${PORT}/evm`);
  console.log(`  PRICE_ORACLE_URL=http://127.0.0.1:${PORT}`);
});
