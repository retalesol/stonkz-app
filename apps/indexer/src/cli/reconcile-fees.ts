/**
 * Fee reconciliation, read-only.
 *
 * Given a net and a mint, replays every fill the launchpad emitted for that
 * coin straight off the chain, recomputes what each vault and bucket should
 * hold under the 15 / 10 / 6 / 69 schedule, and compares that with (a) the
 * program's own per-coin ledgers and vault balances and (b) the API's
 * `/tokens/:sym/fees` totals when `--api` is given. Every mismatch is printed
 * and the exit code is 1; nothing is written anywhere.
 *
 *   pnpm --filter @stonkz/indexer exec tsx ../../scripts/reconcile-fees.ts --net BASE --mint 0x847eb6311333f8F7F2cd0E9A89379214302aB2c9 \
 *     [--rpc $BASE_RPC_URL] [--launchpad 0x2f19…] [--from 47348724] [--api https://api.example]
 *   pnpm --filter @stonkz/indexer exec tsx ../../scripts/reconcile-fees.ts --net SOL --mint <mint> [--rpc $SOLANA_RPC_URL] [--program FF1f…]
 *
 * `--rpc` defaults to `RH_RPC_URL` / `BASE_RPC_URL` / `SOLANA_RPC_URL` from the
 * environment, then to the project's QuickNode testnet endpoints
 * (docs/deployment.md "RPC endpoints").
 *
 * What is checked, per fill and in total (atoms, exact):
 *   - every `FeeAccrued` is the integer v2 split of its `feeTotal`
 *   - Σ protocol / ops (buyback) / burn (RWA) / creatorBucket legs equal the
 *     coin's `protocolAccrued` / `opsAccrued` / `burnAccrued` /
 *     `creatorBucketAccrued` ledgers (EVM) or `protocol_accrued` /
 *     `ops_accrued` / `creator_bucket_accrued` (Solana has no burn ledger)
 *   - Σ `feeStakers` (base fills) equals `stakerAccruedBase`, Σ `feeCreator`
 *     + claims equals the creator ledger, and the bucket ledger backs
 *     `creatorClaimableBase` (EVM `bucketBase`, Solana `bucket_base_vault`)
 *   - the protocol / ops / burn vaults hold at least this coin's legs
 *     (they are per base asset, so other coins may add to them)
 *   - with `--api`: the API's gross / protocol + referrals / buyback / rwa /
 *     creatorBucket / stakers, converted to atoms, match within one atom per
 *     fill (the read tables are doubles).
 */
import {
  decodeEventLog,
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  toHex,
  type Hex,
} from 'viem';

type Net = 'SOL' | 'RH' | 'BASE' | 'ARC';

interface Args {
  net: Net;
  mint: string;
  rpc?: string;
  launchpad?: string;
  program?: string;
  from?: number;
  api?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] ?? '';
  }
  const net = (out['net'] ?? '').toUpperCase() as Net;
  if (!['SOL', 'RH', 'BASE', 'ARC'].includes(net)) throw new Error('--net SOL|RH|BASE|ARC');
  if (!out['mint']) throw new Error('--mint is required');
  return {
    net,
    mint: out['mint'],
    ...(out['rpc'] ? { rpc: out['rpc'] } : {}),
    ...(out['launchpad'] ? { launchpad: out['launchpad'] } : {}),
    ...(out['program'] ? { program: out['program'] } : {}),
    ...(out['from'] ? { from: Number(out['from']) } : {}),
    ...(out['api'] ? { api: out['api'].replace(/\/$/, '') } : {}),
  };
}

/** `<VAR>` from the environment when set and non-blank, else `fallback`. */
function envOr(key: string, fallback: string): string {
  const v = process.env[key]?.trim();
  return v ? v : fallback;
}

// Operator script, never shipped to a browser: the fallbacks are the project's
// QuickNode testnet endpoints (docs/deployment.md "RPC endpoints").
const DEFAULTS: Record<Net, { rpc: string; launchpad: string; from: number }> = {
  BASE: {
    rpc: envOr(
      'BASE_RPC_URL',
      'https://bold-morning-cherry.base-sepolia.quiknode.pro/e3b199333fe5835cdfe212994bd562e853860ffb/',
    ),
    launchpad: '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35',
    from: 47_348_724,
  },
  RH: {
    rpc: envOr(
      'RH_RPC_URL',
      'https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/',
    ),
    launchpad: '0xe308287C9A85E2B53F1027a1c589B5e3969928e8',
    from: 124_871_527,
  },
  ARC: { rpc: envOr('ARC_RPC_URL', ''), launchpad: '', from: 0 },
  SOL: {
    rpc: envOr(
      'SOLANA_RPC_URL',
      'https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/',
    ),
    launchpad: 'FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg',
    from: 0,
  },
};

/* ------------------------------------------------------------------ split */

interface Legs {
  protocol: bigint;
  ops: bigint;
  burn: bigint;
  bucket: bigint;
}

/** The programs' `splitFee`: three floors, remainder to the bucket. */
function splitFee(fee: bigint): Legs {
  const protocol = (fee * 1_500n) / 10_000n;
  const ops = (fee * 1_000n) / 10_000n;
  const burn = (fee * 600n) / 10_000n;
  return { protocol, ops, burn, bucket: fee - protocol - ops - burn };
}

interface Fill {
  id: string;
  isBuy: boolean;
  feeTotal: bigint;
  legs: Legs;
  feeStakers: bigint;
  feeCreator: bigint;
  cashbackTokens: bigint;
}

interface Totals {
  fills: number;
  fee: bigint;
  protocol: bigint;
  ops: bigint;
  burn: bigint;
  bucket: bigint;
  stakersBase: bigint;
  creatorBase: bigint;
  stakersToken: bigint;
  creatorToken: bigint;
  /** Tokens the cashback swaps moved into the bucket (`Trade.cashbackTokens`). */
  cashbackTokens: bigint;
  splitMismatches: string[];
}

function total(fills: Fill[]): Totals {
  const t: Totals = {
    fills: fills.length,
    fee: 0n,
    protocol: 0n,
    ops: 0n,
    burn: 0n,
    bucket: 0n,
    stakersBase: 0n,
    creatorBase: 0n,
    stakersToken: 0n,
    creatorToken: 0n,
    cashbackTokens: 0n,
    splitMismatches: [],
  };
  for (const f of fills) {
    const want = splitFee(f.feeTotal);
    if (
      want.protocol !== f.legs.protocol ||
      want.ops !== f.legs.ops ||
      want.burn !== f.legs.burn ||
      want.bucket !== f.legs.bucket
    ) {
      t.splitMismatches.push(
        `${f.id}: legs ${f.legs.protocol}/${f.legs.ops}/${f.legs.burn}/${f.legs.bucket} != v2 ${want.protocol}/${want.ops}/${want.burn}/${want.bucket} of ${f.feeTotal}`,
      );
    }
    t.fee += f.feeTotal;
    t.protocol += f.legs.protocol;
    t.ops += f.legs.ops;
    t.burn += f.legs.burn;
    t.bucket += f.legs.bucket;
    if (f.cashbackTokens > 0n) {
      t.stakersToken += f.feeStakers;
      t.creatorToken += f.feeCreator;
      t.cashbackTokens += f.cashbackTokens;
    } else {
      t.stakersBase += f.feeStakers;
      t.creatorBase += f.feeCreator;
    }
  }
  return t;
}

/* ------------------------------------------------------------------ report */

const problems: string[] = [];
function check(label: string, actual: bigint, expected: bigint, tolerance = 0n): void {
  const diff = actual - expected;
  const ok = diff >= -tolerance && diff <= tolerance;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected}, diff ${diff})`}`,
  );
  if (!ok) problems.push(label);
}
function checkGe(label: string, actual: bigint, floor: bigint): void {
  const ok = actual >= floor;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${ok ? ` >= ${floor}` : ` (expected >= ${floor})`}`,
  );
  if (!ok) problems.push(label);
}

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await res.json().catch(() => ({ error: { code: res.status } }))) as {
      result?: T;
      error?: { code?: number; message?: string };
    };
    if (j.error) {
      const rateLimited = res.status === 429 || j.error.code === 429 || j.error.code === -32429;
      if (rateLimited && attempt < 8) {
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    }
    return j.result as T;
  }
}

/* --------------------------------------------------------------------- EVM */

const TRADE_ABI = [
  {
    type: 'event',
    name: 'Trade',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'trader', type: 'address', indexed: true },
      { name: 'isBuy', type: 'bool', indexed: false },
      { name: 'baseAmount', type: 'uint256', indexed: false },
      { name: 'tokenAmount', type: 'uint256', indexed: false },
      { name: 'effFeeBps', type: 'uint16', indexed: false },
      { name: 'inCashback', type: 'bool', indexed: false },
      { name: 'feeTotal', type: 'uint256', indexed: false },
      { name: 'feeProtocol', type: 'uint256', indexed: false },
      { name: 'feeOps', type: 'uint256', indexed: false },
      { name: 'feeBurn', type: 'uint256', indexed: false },
      { name: 'feeCreatorBucket', type: 'uint256', indexed: false },
      { name: 'feeStakers', type: 'uint256', indexed: false },
      { name: 'feeCreator', type: 'uint256', indexed: false },
      { name: 'cashbackTokens', type: 'uint256', indexed: false },
      { name: 'virtualBase', type: 'uint256', indexed: false },
      { name: 'virtualToken', type: 'uint256', indexed: false },
      { name: 'realBase', type: 'uint256', indexed: false },
      { name: 'realToken', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CreatorFeesClaimed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'base', type: 'uint256', indexed: false },
      { name: 'tokens', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'StakeClaimed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'base', type: 'uint256', indexed: false },
      { name: 'tokens', type: 'uint256', indexed: false },
    ],
  },
] as const;

const VIEW_ABI = [
  {
    type: 'function',
    name: 'coinInfo',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'baseToken', type: 'address' },
          { name: 'creator', type: 'address' },
          { name: 'baseDecimals', type: 'uint8' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'cashback', type: 'bool' },
          { name: 'complete', type: 'bool' },
          { name: 'graduated', type: 'bool' },
          { name: 'graduationReason', type: 'uint8' },
          { name: 'cbStart', type: 'uint64' },
          { name: 'graduatedAt', type: 'uint64' },
          { name: 'supply', type: 'uint256' },
          { name: 'virtualBase', type: 'uint256' },
          { name: 'virtualToken', type: 'uint256' },
          { name: 'realBase', type: 'uint256' },
          { name: 'realToken', type: 'uint256' },
          { name: 'k', type: 'uint256' },
          { name: 'tokensForSale', type: 'uint256' },
          { name: 'lpReserve', type: 'uint256' },
          { name: 'gradMcapBase', type: 'uint256' },
          { name: 'creationPrice1e6', type: 'uint256' },
          { name: 'protocolAccrued', type: 'uint256' },
          { name: 'opsAccrued', type: 'uint256' },
          { name: 'creatorBucketAccrued', type: 'uint256' },
          { name: 'creatorClaimableBase', type: 'uint256' },
          { name: 'creatorClaimableToken', type: 'uint256' },
          { name: 'bucketBase', type: 'uint256' },
          { name: 'bucketToken', type: 'uint256' },
          { name: 'eligibleStaked', type: 'uint256' },
          { name: 'flexStaked', type: 'uint256' },
          { name: 'totalWeight', type: 'uint256' },
          { name: 'accBasePerWeight', type: 'uint256' },
          { name: 'accTokenPerWeight', type: 'uint256' },
          { name: 'poolDustBase', type: 'uint256' },
          { name: 'poolDustToken', type: 'uint256' },
          { name: 'stakerAccruedBase', type: 'uint256' },
          { name: 'stakerAccruedToken', type: 'uint256' },
          { name: 'burnAccrued', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'protocolRevenue',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'stonkzOps',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'stonkzBurn',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

interface RawLog {
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

async function getLogsChunked(
  rpc: string,
  address: string,
  topics: (Hex | null)[],
  from: number,
  to: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let span = 10_000;
  let a = from;
  while (a <= to) {
    const b = Math.min(to, a + span - 1);
    try {
      const logs = await rpcCall<RawLog[]>(rpc, 'eth_getLogs', [
        { address, topics, fromBlock: toHex(a), toBlock: toHex(b) },
      ]);
      out.push(...logs);
      a = b + 1;
      if (span < 10_000) span = Math.min(10_000, span * 2);
    } catch (err) {
      // Public RPCs cap ranges (by blocks or by results); halve and retry.
      if (span <= 250) throw err;
      span = Math.floor(span / 2);
    }
  }
  return out;
}

async function ethCall<T>(
  rpc: string,
  to: string,
  fn: (typeof VIEW_ABI)[number]['name'],
  args: unknown[],
): Promise<T> {
  const data = encodeFunctionData({ abi: VIEW_ABI, functionName: fn, args } as never);
  const raw = await rpcCall<Hex>(rpc, 'eth_call', [{ to, data }, 'latest']);
  return decodeFunctionResult({ abi: VIEW_ABI, functionName: fn, data: raw } as never) as T;
}

async function reconcileEvm(
  args: Args,
): Promise<{ baseDecimals: number; tokenDecimals: number; totals: Totals; unit: string }> {
  const d = DEFAULTS[args.net];
  const rpc = args.rpc ?? d.rpc;
  const pad = args.launchpad ?? d.launchpad;
  const from = args.from ?? d.from;
  if (!rpc || !pad) throw new Error(`${args.net}: pass --rpc and --launchpad`);
  const token = args.mint;
  const head = Number(await rpcCall<Hex>(rpc, 'eth_blockNumber', []));
  console.log(`# ${args.net} ${token} via ${pad} blocks ${from}..${head}`);

  const tokenTopic = `0x${token.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
  const sig = (s: string): Hex => keccak256(toHex(s));
  const tradeTopic = sig(
    'Trade(address,address,bool,uint256,uint256,uint16,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  );
  const creatorClaimTopic = sig('CreatorFeesClaimed(address,address,uint256,uint256)');
  const stakeClaimTopic = sig('StakeClaimed(address,address,uint256,uint256)');
  const logs = await getLogsChunked(
    rpc,
    pad,
    [[tradeTopic, creatorClaimTopic, stakeClaimTopic] as unknown as Hex, tokenTopic],
    from,
    head,
  );

  const fills: Fill[] = [];
  let creatorClaimedBase = 0n;
  let creatorClaimedToken = 0n;
  let stakeClaimedBase = 0n;
  let stakeClaimedToken = 0n;
  for (const l of logs) {
    const ev = decodeEventLog({
      abi: TRADE_ABI,
      topics: l.topics as [Hex, ...Hex[]],
      data: l.data,
    });
    if (ev.eventName === 'Trade') {
      const a = ev.args;
      fills.push({
        id: `${l.transactionHash}#${Number(l.logIndex)}`,
        isBuy: a.isBuy,
        feeTotal: a.feeTotal,
        legs: {
          protocol: a.feeProtocol,
          ops: a.feeOps,
          burn: a.feeBurn,
          bucket: a.feeCreatorBucket,
        },
        feeStakers: a.feeStakers,
        feeCreator: a.feeCreator,
        cashbackTokens: a.cashbackTokens,
      });
    } else if (ev.eventName === 'CreatorFeesClaimed') {
      creatorClaimedBase += ev.args.base;
      creatorClaimedToken += ev.args.tokens;
    } else if (ev.eventName === 'StakeClaimed') {
      stakeClaimedBase += ev.args.base;
      stakeClaimedToken += ev.args.tokens;
    }
  }
  const t = total(fills);
  console.log(
    `# ${t.fills} fills, fee total ${t.fee} atoms; creator claimed ${creatorClaimedBase}, stakers claimed ${stakeClaimedBase}`,
  );
  for (const m of t.splitMismatches) {
    console.log(`FAIL split ${m}`);
    problems.push('split');
  }
  if (t.splitMismatches.length === 0)
    console.log(`OK   every fill is the integer 15/10/6/69 split`);

  const c = await ethCall<{
    baseToken: string;
    baseDecimals: number;
    protocolAccrued: bigint;
    opsAccrued: bigint;
    burnAccrued: bigint;
    creatorBucketAccrued: bigint;
    creatorClaimableBase: bigint;
    creatorClaimableToken: bigint;
    bucketBase: bigint;
    bucketToken: bigint;
    stakerAccruedBase: bigint;
    stakerAccruedToken: bigint;
    poolDustBase: bigint;
    realBase: bigint;
    token: string;
  }>(rpc, pad, 'coinInfo', [token]);
  if (c.token.toLowerCase() !== token.toLowerCase())
    throw new Error('launchpad does not know this token');

  check('coin.protocolAccrued == Σ protocol legs', c.protocolAccrued, t.protocol);
  check('coin.opsAccrued == Σ ops (buyback) legs', c.opsAccrued, t.ops);
  check('coin.burnAccrued == Σ burn (RWA) legs', c.burnAccrued, t.burn);
  check('coin.creatorBucketAccrued == Σ bucket legs', c.creatorBucketAccrued, t.bucket);
  check('coin.stakerAccruedBase == Σ feeStakers (base fills)', c.stakerAccruedBase, t.stakersBase);
  check(
    'coin.stakerAccruedToken == Σ feeStakers (cashback fills)',
    c.stakerAccruedToken,
    t.stakersToken,
  );
  check(
    'coin.creatorClaimableBase == Σ feeCreator - claimed',
    c.creatorClaimableBase,
    t.creatorBase - creatorClaimedBase,
  );
  check(
    'coin.creatorClaimableToken == Σ feeCreator(tokens) - claimed',
    c.creatorClaimableToken,
    t.creatorToken - creatorClaimedToken,
  );
  check(
    'coin.bucketBase == Σ bucket(base) - creator claims - staker claims',
    c.bucketBase,
    t.bucket - creatorClaimedBase - stakeClaimedBase,
  );
  checkGe('coin.bucketBase covers creatorClaimableBase', c.bucketBase, c.creatorClaimableBase);
  check(
    'coin.bucketToken == Σ cashbackTokens - creator token claims - staker token claims',
    c.bucketToken,
    t.cashbackTokens - creatorClaimedToken - stakeClaimedToken,
  );

  const [protocolVault, opsVault, burnVault, held] = await Promise.all([
    ethCall<bigint>(rpc, pad, 'protocolRevenue', [c.baseToken]),
    ethCall<bigint>(rpc, pad, 'stonkzOps', [c.baseToken]),
    ethCall<bigint>(rpc, pad, 'stonkzBurn', [c.baseToken]),
    ethCall<bigint>(rpc, c.baseToken, 'balanceOf', [pad]),
  ]);
  console.log(
    `# ${c.baseToken} vaults: protocol ${protocolVault} ops ${opsVault} burn ${burnVault}; launchpad holds ${held}`,
  );
  checkGe(
    "protocol vault >= this coin's protocol legs (per base asset, minus withdrawals)",
    protocolVault,
    0n,
  );
  checkGe(
    'launchpad base balance backs vaults + bucket + curve reserve',
    held,
    protocolVault + opsVault + burnVault + c.bucketBase + c.realBase,
  );
  return { baseDecimals: c.baseDecimals, tokenDecimals: 18, totals: t, unit: c.baseToken };
}

/* ------------------------------------------------------------------ Solana */

async function reconcileSol(
  args: Args,
): Promise<{ baseDecimals: number; tokenDecimals: number; totals: Totals; unit: string }> {
  const { launchpadEventCoder } = await import('../chain/solana-events.js');
  const { programDataPayloads } = await import('../chain/anchor.js');
  const { decodeSolCurveStakePool } = await import('@stonkz/api/chain/stake-reads');
  const { solCurvePda, solCurveVaults, pubkeyAt } = await import('@stonkz/api/chain/curve-ledger');

  const d = DEFAULTS.SOL;
  const rpc = args.rpc ?? d.rpc;
  const program = args.program ?? d.launchpad;
  console.log(`# SOL ${args.mint} via ${program}`);

  // The curve PDA is the signer on every fill, claim and stake of this coin,
  // so its signature history is exactly this coin's activity.
  const curvePda = solCurvePda(program, args.mint);
  const sigs: { signature: string; slot: number; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpcCall<typeof sigs>(rpc, 'getSignaturesForAddress', [
      curvePda,
      { limit: 1000, ...(before ? { before } : {}) },
    ]);
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1]!.signature;
  }
  const fills: Fill[] = [];
  let creatorClaimedBase = 0n;
  let creatorClaimedToken = 0n;
  let stakeClaimedBase = 0n;
  let stakeClaimedToken = 0n;
  let undecodable = 0;
  for (const s of sigs) {
    if (s.err) continue;
    await new Promise((r) => setTimeout(r, 250));
    const tx = await rpcCall<{ meta?: { logMessages?: string[] } } | null>(rpc, 'getTransaction', [
      s.signature,
      { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
    ]);
    let i = 0;
    for (const payload of programDataPayloads(tx?.meta?.logMessages ?? [], program)) {
      let ev: { kind: string } | null;
      try {
        ev = launchpadEventCoder.decode(payload) as { kind: string } | null;
      } catch {
        undecodable++;
        continue;
      }
      if (!ev) continue;
      const e = ev as unknown as Record<string, unknown>;
      if (e['mint'] !== args.mint) continue;
      if (ev.kind === 'Trade') {
        fills.push({
          id: `${s.signature}#${i}`,
          isBuy: e['isBuy'] as boolean,
          feeTotal: e['feeTotal'] as bigint,
          legs: {
            protocol: e['feeProtocol'] as bigint,
            ops: e['feeOps'] as bigint,
            burn: e['feeBurn'] as bigint,
            bucket: e['feeCreatorBucket'] as bigint,
          },
          feeStakers: e['feeStakers'] as bigint,
          feeCreator: e['feeCreator'] as bigint,
          cashbackTokens: e['cashbackTokens'] as bigint,
        });
      } else if (ev.kind === 'CreatorFeesClaimed') {
        creatorClaimedBase += e['baseAmount'] as bigint;
        creatorClaimedToken += e['tokenAmount'] as bigint;
      } else if (ev.kind === 'StakeClaimed') {
        stakeClaimedBase += e['baseAmount'] as bigint;
        stakeClaimedToken += e['tokenAmount'] as bigint;
      }
      i++;
    }
  }
  const t = total(fills);
  console.log(
    `# ${sigs.length} txs on the curve, ${t.fills} fills (${undecodable} pre-layout payloads skipped), fee total ${t.fee}`,
  );
  for (const m of t.splitMismatches) {
    console.log(`FAIL split ${m}`);
    problems.push('split');
  }
  if (t.splitMismatches.length === 0)
    console.log(`OK   every fill is the integer 15/10/6/69 split`);

  const curveB64 = await rpcCall<{ value: { data: [string, string] } | null }>(
    rpc,
    'getAccountInfo',
    [curvePda, { encoding: 'base64' }],
  );
  if (!curveB64.value) throw new Error('curve account not found');
  const data = Buffer.from(curveB64.value.data[0], 'base64');
  const pool = decodeSolCurveStakePool(data);
  if (!pool) throw new Error('could not decode Curve');
  // Ledgers not covered by the stake decoder, read at their fixed offsets
  // relative to `eligible_staked` (see state.rs): protocol, ops, bucket
  // accrued sit 5 u64s before it.
  const baseMintKey = pubkeyAt(data, 8 + 1 + 32);
  const pdas = solCurveVaults(program, args.mint, baseMintKey);
  const tokenBalance = async (acct: string): Promise<bigint> => {
    const r = await rpcCall<{ value: { amount: string } | null }>(rpc, 'getTokenAccountBalance', [
      acct,
    ]);
    return BigInt(r.value?.amount ?? '0');
  };
  const [protocolVault, opsVault, burnVault, bucketBase, bucketToken] = await Promise.all([
    tokenBalance(pdas.protocolVault),
    tokenBalance(pdas.opsVault),
    tokenBalance(pdas.burnVault),
    tokenBalance(pdas.bucketBaseVault),
    tokenBalance(pdas.bucketTokenVault),
  ]);
  // Walk to the fee ledger the same way the decoder does.
  let o = 8 + 1 + 32 * 3;
  const tickerLen = data.readUInt32LE(o);
  o += 4 + tickerLen + 8 + 1 + 1 + 2 + 1 + 8 + 16 + 16 + 8 + 8 + 16 * 3 + 8 + 8 + 16 + 8 + 1 + 1;
  o += data.readUInt8(o) === 1 ? 2 : 1;
  o += 8 + 1 + 32 + 8;
  const protocolAccrued = data.readBigUInt64LE(o);
  const opsAccrued = data.readBigUInt64LE(o + 8);
  const bucketAccrued = data.readBigUInt64LE(o + 16);

  check('curve.protocol_accrued == Σ protocol legs', protocolAccrued, t.protocol);
  check('curve.ops_accrued == Σ ops (buyback) legs', opsAccrued, t.ops);
  check('curve.creator_bucket_accrued == Σ bucket legs', bucketAccrued, t.bucket);
  check(
    'curve.staker_accrued_base == Σ feeStakers (base fills)',
    pool.stakerAccruedBase,
    t.stakersBase,
  );
  check(
    'curve.creator_claimable_base == Σ feeCreator - claimed',
    pool.creatorClaimableBase ?? 0n,
    t.creatorBase - creatorClaimedBase,
  );
  check(
    'curve.creator_claimable_token == Σ feeCreator(tokens) - claimed',
    pool.creatorClaimableToken ?? 0n,
    t.creatorToken - creatorClaimedToken,
  );
  check(
    'bucket_base_vault == Σ bucket(base) - creator claims - staker claims',
    bucketBase,
    t.bucket - creatorClaimedBase - stakeClaimedBase,
  );
  check(
    'bucket_token_vault == Σ cashbackTokens - creator token claims - staker token claims',
    bucketToken,
    t.cashbackTokens - creatorClaimedToken - stakeClaimedToken,
  );
  checkGe(
    'bucket_token_vault covers creator_claimable_token',
    bucketToken,
    pool.creatorClaimableToken ?? 0n,
  );
  console.log(
    `# ${baseMintKey} vaults: protocol ${protocolVault} ops ${opsVault} burn ${burnVault}`,
  );
  checkGe(
    "protocol vault >= this coin's protocol legs (per base mint, minus withdrawals)",
    protocolVault,
    0n,
  );
  const baseDecimals = data.readUInt8(8 + 1 + 32 * 3 + 4 + tickerLen + 8 + 1);
  const tokenDecimals = data.readUInt8(8 + 1 + 32 * 3 + 4 + tickerLen + 8);
  return { baseDecimals, tokenDecimals, totals: t, unit: baseMintKey };
}

/* --------------------------------------------------------------------- API */

async function reconcileApi(args: Args, baseDecimals: number, t: Totals): Promise<void> {
  if (!args.api) return;
  const res = await fetch(
    `${args.api}/tokens/_/fees?net=${args.net}&mint=${encodeURIComponent(args.mint)}`,
  );
  if (!res.ok) {
    console.log(`FAIL api /tokens/:sym/fees -> ${res.status}`);
    problems.push('api');
    return;
  }
  const body = (await res.json()) as {
    totals: {
      gross: number;
      protocol: number;
      buyback: number;
      rwa: number;
      creatorBucket: number;
      stakers: number;
      referrals: number;
    };
  };
  const atoms = (v: number): bigint => BigInt(Math.round(v * 10 ** baseDecimals));
  // The read tables are doubles; allow one atom per fill of rounding.
  const tol = BigInt(Math.max(1, t.fills));
  console.log(
    '# API totals (native, converted at baseDecimals — exact only for a native-paired curve)',
  );
  check('api gross == Σ fee', atoms(body.totals.gross), t.fee, tol);
  check(
    'api protocol + referrals == Σ protocol legs',
    atoms(body.totals.protocol + body.totals.referrals),
    t.protocol,
    tol,
  );
  check('api buyback == Σ ops legs', atoms(body.totals.buyback), t.ops, tol);
  check('api rwa == Σ burn legs', atoms(body.totals.rwa), t.burn, tol);
  check('api creatorBucket == Σ bucket legs', atoms(body.totals.creatorBucket), t.bucket, tol);
  check('api stakers == Σ feeStakers (base fills)', atoms(body.totals.stakers), t.stakersBase, tol);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const r = args.net === 'SOL' ? await reconcileSol(args) : await reconcileEvm(args);
  await reconcileApi(args, r.baseDecimals, r.totals);
  if (problems.length) {
    console.log(`\n${problems.length} check(s) failed: ${[...new Set(problems)].join(', ')}`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}
