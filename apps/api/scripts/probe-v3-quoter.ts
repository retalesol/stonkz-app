// Operator probe: ask a V3 quoter (QuoterV2 or the flat testnet one) for an
// exact-input quote the way the API does. No state, nothing broadcast.
//   RPC=<url> QUOTER=<addr> TOKEN_IN=<addr> TOKEN_OUT=<addr> FEE=500 AMOUNT=1000000000000000000 \
//   apps/api/node_modules/.bin/tsx apps/api/scripts/probe-v3-quoter.ts
import { v3QuoteExactInputSingle, v3QuoterKind } from '../src/router/v3-pool-reads.js';

const rpc = process.env.RPC!;
const eth = {
  async ethCall(to: string, data: string): Promise<string> {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
    const j = (await res.json()) as { result?: string; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result ?? '0x';
  },
};
const out = await v3QuoteExactInputSingle(
  eth,
  process.env.QUOTER!,
  process.env.TOKEN_IN!,
  process.env.TOKEN_OUT!,
  Number(process.env.FEE ?? 500),
  BigInt(process.env.AMOUNT ?? '1000000000000000000'),
);
console.log(`kind=${v3QuoterKind(process.env.QUOTER!)} amountOut=${out}`);
