import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicKey, Transaction } from '@solana/web3.js';
import { decodeFunctionData, getAddress } from 'viem';
import { tokens } from '../db/schema.js';
import { deriveCurveColumns } from '../router/curve-state.js';
import { LAUNCHPAD_ABI } from '../router/evm-abi.js';
import { anchorDiscriminator } from '../router/solana-idl.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_TOKEN_MINT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const EVM_TOKEN_MINT = getAddress(`0x${'6ad'.padStart(40, '0')}`);

/**
 * A token with real curve columns, so `serialiseToken` can judge readiness.
 * `realToken` decides `curveComplete`; `mc` decides the oracle trigger.
 */
async function seedToken(
  net: 'SOL' | 'BASE',
  sym: string,
  mint: string,
  creator: string,
  over: { realToken?: string; mc?: number; graduatedAt?: Date | null } = {},
): Promise<void> {
  const baseDecimals = net === 'SOL' ? 9 : 18;
  const tokenDecimals = net === 'SOL' ? 6 : 18;
  const basePrice1e6 = net === 'SOL' ? 214_080_000n : 4_200_000_000n;
  const derived = deriveCurveColumns(
    1_000_000_000n * 10n ** BigInt(tokenDecimals),
    basePrice1e6,
    baseDecimals,
    tokenDecimals,
  );
  if (!derived) throw new Error('seedToken: curve derivation failed');
  await h.deps.db.insert(tokens).values({
    net,
    sym,
    name: sym,
    creator,
    mint,
    baseSymbol: net === 'SOL' ? 'SOL' : 'ETH',
    baseMint: net === 'SOL' ? SOL_MINT : '0x0000000000000000000000000000000000000000',
    supply: 1e9,
    feeBps: 250,
    mc: over.mc ?? 1000,
    lane: 'new',
    seed: 1,
    launchedAt: new Date(h.now() - 600_000),
    ...derived.columns,
    ...(over.realToken !== undefined ? { curveRealToken: over.realToken } : {}),
    ...(over.graduatedAt !== undefined ? { graduatedAt: over.graduatedAt } : {}),
  });
}

interface PrepareResponse {
  net?: string;
  sym?: string;
  trigger?: 'exhausted' | 'oracle';
  transaction?: string;
  pythSync?: boolean;
  to?: string;
  data?: string;
  value?: string;
  error?: string;
  curveComplete?: boolean;
}

async function prepare(
  token: string,
  sym: string,
  mint?: string,
): Promise<{ status: number; body: PrepareResponse }> {
  const res = await h.app.request(`/tokens/${sym}/graduate/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authed(token) },
    body: JSON.stringify(mint ? { mint } : {}),
  });
  return { status: res.status, body: (await res.json()) as PrepareResponse };
}

/** The "GRADUATE NOW" button's endpoint. */
describe('POST /tokens/:sym/graduate/prepare', () => {
  it('refuses a curve that has met no trigger', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'YOUNG', SOL_TOKEN_MINT, address);
    const { status, body } = await prepare(token, 'YOUNG');
    expect(status).toBe(422);
    expect(body.error).toBe('not_graduable');
    expect(body.curveComplete).toBe(false);
  });

  it('refuses a token that already graduated', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'DONE', SOL_TOKEN_MINT, address, {
      realToken: '0',
      graduatedAt: new Date(h.now() - 1000),
    });
    const { status, body } = await prepare(token, 'DONE');
    expect(status).toBe(409);
    expect(body.error).toBe('already_graduated');
  });

  it('builds a plain Solana graduate (no oracle) for an exhausted curve', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'FULL', SOL_TOKEN_MINT, address, { realToken: '0' });
    const { status, body } = await prepare(token, 'FULL');
    expect(status).toBe(200);
    expect(body.trigger).toBe('exhausted');
    expect(body.pythSync).toBe(false);

    const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programId.toBase58()).toBe(h.deps.env.solanaLaunchpadProgramId);
    expect(Buffer.from(ix.data).equals(anchorDiscriminator('graduate'))).toBe(true);
    // Account 4 is the optional `BaseOracle`: absent (= program id) when the
    // exhaustion trigger is used, so a stale oracle can never block it.
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(h.deps.env.solanaLaunchpadProgramId);
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(address);
    expect(ix.keys[6]!.isSigner).toBe(true);
    // Account 8 (appended last) is the runtime `["params"]` PDA, read-only.
    expect(ix.keys).toHaveLength(9);
    expect(ix.keys[8]!.pubkey.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from('params')],
        new PublicKey(h.deps.env.solanaLaunchpadProgramId),
      )[0].toBase58(),
    );
    expect(ix.keys[8]!.isWritable).toBe(false);
  });

  it('arms the Solana oracle trigger when the cap is over $69K with tokens left', async () => {
    const { token, address } = await h.login('SOL');
    await seedToken('SOL', 'RICH', SOL_TOKEN_MINT, address, { mc: 70_500 });
    const { status, body } = await prepare(token, 'RICH');
    expect(status).toBe(200);
    expect(body.trigger).toBe('oracle');
    const tx = Transaction.from(Buffer.from(body.transaction!, 'base64'));
    const graduate = tx.instructions[tx.instructions.length - 1]!;
    expect(graduate.keys[4]!.pubkey.toBase58()).not.toBe(h.deps.env.solanaLaunchpadProgramId);
  });

  it('builds the launchpad graduate call for an exhausted EVM curve', async () => {
    const { token, address } = await h.login('BASE');
    await seedToken('BASE', 'EVMFULL', EVM_TOKEN_MINT, address, { realToken: '0' });
    const { status, body } = await prepare(token, 'EVMFULL');
    expect(status).toBe(200);
    expect(body.trigger).toBe('exhausted');
    expect(body.value).toBe('0');
    const decoded = decodeFunctionData({ abi: LAUNCHPAD_ABI, data: body.data as `0x${string}` });
    expect(decoded.functionName).toBe('graduate');
    expect(decoded.args).toEqual([EVM_TOKEN_MINT]);
  });

  it('404s an unknown token and 401s without a session', async () => {
    const { token } = await h.login('SOL');
    expect((await prepare(token, 'NOPE')).status).toBe(404);
    const res = await h.app.request('/tokens/NOPE/graduate/prepare', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
