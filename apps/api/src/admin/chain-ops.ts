import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  packParamsWord,
  unpackParamsWord,
  validateCurveParams,
  type EvmNet,
  type ParamsWordFields,
} from '@stonkz/shared';
import type { EthCaller } from '../auth/siwe.js';
import type { SolanaAccountDataSource, SolanaBlockhashSource } from '../chain/types.js';
import { anchorDiscriminator, derivePdas, encodeBool, encodeU64 } from '../router/solana-idl.js';

/**
 * On-chain admin operations, prepared server-side and **signed in the admin's
 * browser wallet**. Nothing in this module holds or sees a private key: every
 * function either reads state through an RPC or returns unsigned calldata /
 * an unsigned Solana transaction for the wallet to sign.
 *
 * The EVM ABI fragments mirror `programs/evm/src/StonkzLaunchpad.sol` and
 * `oracle/PushPriceSource.sol`; the Solana encoders mirror
 * `programs/solana/programs/launchpad/src/instructions/{admin,pauser}.rs`.
 * `chain-ops.test.ts` pins selectors and discriminators against the source.
 */

/* ------------------------------------------------------------------- EVM */

export const LAUNCHPAD_ADMIN_ABI = parseAbi([
  'function admin() view returns (address)',
  'function pendingAdmin() view returns (address)',
  'function pauser() view returns (address)',
  'function priceSource() view returns (address)',
  'function migrator() view returns (address)',
  'function migrationAuthority() view returns (address)',
  'function protocolWithdrawAuthority() view returns (address)',
  'function opsWithdrawAuthority() view returns (address)',
  'function maxOracleStaleness() view returns (uint64)',
  'function tradingPaused() view returns (bool)',
  'function launchPaused() view returns (bool)',
  'function protocolWithdrawalsPaused() view returns (bool)',
  'function opsWithdrawalsPaused() view returns (bool)',
  'function oracleGraduationPaused() view returns (bool)',
  'function tokenCount() view returns (uint256)',
  'function protocolRevenue(address baseToken) view returns (uint256)',
  'function stonkzOps(address baseToken) view returns (uint256)',
  'function stonkzBurn(address baseToken) view returns (uint256)',
  'function setPause(bool trading, bool launch, bool protocolWithdrawals, bool opsWithdrawals, bool oracleGraduation)',
  'function pause(bool trading, bool launch, bool protocolWithdrawals, bool opsWithdrawals, bool oracleGraduation)',
  'function setPauser(address p)',
  'function setMigrator(address m, address authority)',
  'function setWithdrawAuthorities(address protocol, address ops)',
  'function proposeAdmin(address a)',
  'function acceptAdmin()',
  'function setPriceSource(address s)',
  'function setMaxOracleStaleness(uint64 s)',
  'function withdrawTreasury(uint8 which, address baseToken, uint256 amount, address to)',
  // Runtime parameters: one packed uint256 (`packParamsWord` in @stonkz/shared); 0 = defaults.
  'function paramsWord() view returns (uint256)',
  'function setParams(uint256 w)',
  'function trustedRouter() view returns (address)',
  'function setTrustedRouter(address r)',
]);

/** `StonkzRouter`'s admin surface — `setConfig` is gated on `launchpad.admin()`. */
export const ROUTER_ADMIN_ABI = parseAbi([
  'function maxBuyNative() view returns (uint256)',
  'function pyth() view returns (address)',
  'function attestationSink() view returns (address)',
  'function setConfig(uint256 maxBuyNative, address pyth, address attestationSink)',
]);

export const PUSH_PRICE_SOURCE_ABI = parseAbi([
  'function oracleAuthority() view returns (address)',
  'function pushPrice(address baseToken, uint256 price1e6, uint256 conf1e6)',
  'function priceUsd1e6(address baseToken) view returns (uint256 price1e6, uint256 publishedAt, uint256 maxAge)',
]);

export interface EvmLaunchpadState {
  admin: string;
  pendingAdmin: string;
  pauser: string;
  priceSource: string;
  migrator: string;
  migrationAuthority: string;
  protocolWithdrawAuthority: string;
  opsWithdrawAuthority: string;
  maxOracleStaleness: number;
  paused: {
    trading: boolean;
    launch: boolean;
    protocolWithdrawals: boolean;
    opsWithdrawals: boolean;
    oracleGraduation: boolean;
  };
  tokenCount: number;
  /** `null` until the parameterised implementation is live (the views revert before it). */
  trustedRouter: string | null;
  /** The packed params word as a decimal string; `'0'` = contract defaults; `null` when the view reverts. */
  paramsWord: string | null;
}

type ViewName =
  | 'admin'
  | 'pendingAdmin'
  | 'pauser'
  | 'priceSource'
  | 'migrator'
  | 'migrationAuthority'
  | 'protocolWithdrawAuthority'
  | 'opsWithdrawAuthority'
  | 'maxOracleStaleness'
  | 'tradingPaused'
  | 'launchPaused'
  | 'protocolWithdrawalsPaused'
  | 'opsWithdrawalsPaused'
  | 'oracleGraduationPaused'
  | 'tokenCount'
  | 'trustedRouter'
  | 'paramsWord';

async function view<T>(eth: EthCaller, to: string, functionName: ViewName): Promise<T> {
  const data = encodeFunctionData({ abi: LAUNCHPAD_ADMIN_ABI, functionName });
  const raw = (await eth.ethCall(to, data)) as Hex;
  return decodeFunctionResult({ abi: LAUNCHPAD_ADMIN_ABI, functionName, data: raw }) as T;
}

export async function readEvmLaunchpadState(
  eth: EthCaller,
  launchpad: string,
): Promise<EvmLaunchpadState> {
  const [
    admin,
    pendingAdmin,
    pauser,
    priceSource,
    migrator,
    migrationAuthority,
    protocolWithdrawAuthority,
    opsWithdrawAuthority,
    maxOracleStaleness,
    trading,
    launch,
    protocolWithdrawals,
    opsWithdrawals,
    oracleGraduation,
    tokenCount,
  ] = await Promise.all([
    view<Address>(eth, launchpad, 'admin'),
    view<Address>(eth, launchpad, 'pendingAdmin'),
    view<Address>(eth, launchpad, 'pauser'),
    view<Address>(eth, launchpad, 'priceSource'),
    view<Address>(eth, launchpad, 'migrator'),
    view<Address>(eth, launchpad, 'migrationAuthority'),
    view<Address>(eth, launchpad, 'protocolWithdrawAuthority'),
    view<Address>(eth, launchpad, 'opsWithdrawAuthority'),
    view<bigint>(eth, launchpad, 'maxOracleStaleness'),
    view<boolean>(eth, launchpad, 'tradingPaused'),
    view<boolean>(eth, launchpad, 'launchPaused'),
    view<boolean>(eth, launchpad, 'protocolWithdrawalsPaused'),
    view<boolean>(eth, launchpad, 'opsWithdrawalsPaused'),
    view<boolean>(eth, launchpad, 'oracleGraduationPaused'),
    view<bigint>(eth, launchpad, 'tokenCount'),
  ]);
  // The params views only exist on the parameterised implementation; an
  // older proxy target reverts on them and must not take the whole page down.
  const [trustedRouter, paramsWord] = await Promise.all([
    view<Address>(eth, launchpad, 'trustedRouter').catch(() => null),
    view<bigint>(eth, launchpad, 'paramsWord')
      .then((w) => String(w))
      .catch(() => null),
  ]);
  return {
    admin,
    pendingAdmin,
    pauser,
    priceSource,
    migrator,
    migrationAuthority,
    protocolWithdrawAuthority,
    opsWithdrawAuthority,
    maxOracleStaleness: Number(maxOracleStaleness),
    paused: { trading, launch, protocolWithdrawals, opsWithdrawals, oracleGraduation },
    tokenCount: Number(tokenCount),
    trustedRouter,
    paramsWord,
  };
}

/**
 * The params-related launchpad views on their own, each tolerant: the
 * Parameters page must render for a launchpad whose other views are not what
 * `readEvmLaunchpadState` expects (a test double) or that predates params.
 */
export async function readEvmParamsViews(
  eth: EthCaller,
  launchpad: string,
): Promise<{ admin: string | null; paramsWord: string | null; trustedRouter: string | null }> {
  const [admin, paramsWord, trustedRouter] = await Promise.all([
    view<Address>(eth, launchpad, 'admin').catch(() => null),
    view<bigint>(eth, launchpad, 'paramsWord')
      .then((w) => String(w))
      .catch(() => null),
    view<Address>(eth, launchpad, 'trustedRouter').catch(() => null),
  ]);
  return { admin, paramsWord, trustedRouter };
}

/** `StonkzRouter.maxBuyNative()` / `pyth()` / `attestationSink()`, each `null` when the router predates it. */
export async function readEvmRouterConfig(
  eth: EthCaller,
  router: string,
): Promise<{ maxBuyNative: string | null; pyth: string | null; attestationSink: string | null }> {
  const read = async <T>(
    functionName: 'maxBuyNative' | 'pyth' | 'attestationSink',
  ): Promise<T | null> => {
    try {
      const data = encodeFunctionData({ abi: ROUTER_ADMIN_ABI, functionName });
      const raw = (await eth.ethCall(router, data)) as Hex;
      return decodeFunctionResult({ abi: ROUTER_ADMIN_ABI, functionName, data: raw }) as T;
    } catch {
      return null;
    }
  };
  const [maxBuyNative, pyth, attestationSink] = await Promise.all([
    read<bigint>('maxBuyNative'),
    read<Address>('pyth'),
    read<Address>('attestationSink'),
  ]);
  return {
    maxBuyNative: maxBuyNative === null ? null : String(maxBuyNative),
    pyth,
    attestationSink,
  };
}

/** The three launchpad vault balances for one base token, in atoms (as decimal strings). */
export async function readEvmVaults(
  eth: EthCaller,
  launchpad: string,
  baseToken: string,
): Promise<{ protocol: string; ops: string; rwa: string }> {
  const read = async (
    functionName: 'protocolRevenue' | 'stonkzOps' | 'stonkzBurn',
  ): Promise<string> => {
    const data = encodeFunctionData({
      abi: LAUNCHPAD_ADMIN_ABI,
      functionName,
      args: [getAddress(baseToken)],
    });
    const raw = (await eth.ethCall(launchpad, data)) as Hex;
    return String(
      decodeFunctionResult({ abi: LAUNCHPAD_ADMIN_ABI, functionName, data: raw }) as bigint,
    );
  };
  const [protocol, ops, rwa] = await Promise.all([
    read('protocolRevenue'),
    read('stonkzOps'),
    read('stonkzBurn'),
  ]);
  return { protocol, ops, rwa };
}

/** `PushPriceSource.priceUsd1e6` / `oracleAuthority` — legs of the oracle status view. */
export async function readPushPriceSource(
  eth: EthCaller,
  source: string,
  baseToken: string,
): Promise<{
  price1e6: string;
  publishedAt: number;
  maxAge: number;
  oracleAuthority: string | null;
}> {
  const priceData = encodeFunctionData({
    abi: PUSH_PRICE_SOURCE_ABI,
    functionName: 'priceUsd1e6',
    args: [getAddress(baseToken)],
  });
  const raw = (await eth.ethCall(source, priceData)) as Hex;
  const [price1e6, publishedAt, maxAge] = decodeFunctionResult({
    abi: PUSH_PRICE_SOURCE_ABI,
    functionName: 'priceUsd1e6',
    data: raw,
  }) as readonly [bigint, bigint, bigint];
  let oracleAuthority: string | null = null;
  try {
    const authRaw = (await eth.ethCall(
      source,
      encodeFunctionData({ abi: PUSH_PRICE_SOURCE_ABI, functionName: 'oracleAuthority' }),
    )) as Hex;
    oracleAuthority = decodeFunctionResult({
      abi: PUSH_PRICE_SOURCE_ABI,
      functionName: 'oracleAuthority',
      data: authRaw,
    }) as Address;
  } catch {
    // Pyth / Stock sources have no push authority; the view just omits it.
  }
  return {
    price1e6: String(price1e6),
    publishedAt: Number(publishedAt),
    maxAge: Number(maxAge),
    oracleAuthority,
  };
}

export type EvmAdminAction =
  | {
      kind: 'setPause';
      trading: boolean;
      launch: boolean;
      protocolWithdrawals: boolean;
      opsWithdrawals: boolean;
      oracleGraduation: boolean;
    }
  | {
      kind: 'pause';
      trading: boolean;
      launch: boolean;
      protocolWithdrawals: boolean;
      opsWithdrawals: boolean;
      oracleGraduation: boolean;
    }
  | { kind: 'setPauser'; pauser: string }
  | { kind: 'setMigrator'; migrator: string; authority: string }
  | { kind: 'setWithdrawAuthorities'; protocol: string; ops: string }
  | { kind: 'proposeAdmin'; admin: string }
  | { kind: 'acceptAdmin' }
  | { kind: 'setPriceSource'; source: string }
  | { kind: 'setMaxOracleStaleness'; seconds: number }
  | {
      kind: 'withdrawTreasury';
      which: 0 | 1 | 2;
      baseToken: string;
      amountAtoms: string;
      to: string;
    }
  | { kind: 'pushPrice'; source: string; baseToken: string; price1e6: string; conf1e6: string }
  /** `setParams(uint256)` — `word` is the packed record (decimal or 0x hex string); validated by unpacking. */
  | { kind: 'setParams'; word: string }
  /** `StonkzRouter.setConfig` — targets the net's router, signed by the launchpad admin. */
  | { kind: 'setRouterConfig'; maxBuyNative: string; pyth: string; attestationSink: string }
  | { kind: 'setTrustedRouter'; router: string };

export interface PreparedEvmTx {
  net: EvmNet;
  chainId: number;
  to: string;
  data: string;
  value: string;
  /** Human summary for the confirmation dialog and the audit row. */
  summary: string;
  /** Which on-chain role must sign this, so the UI can warn before the wallet does. */
  signer: 'admin' | 'pauser' | 'pendingAdmin' | 'withdrawAuthority' | 'oracleAuthority';
}

function addr(v: string, what: string): Address {
  if (!isAddress(v)) throw new ChainOpsError('bad_address', `${what} is not an EVM address`);
  return getAddress(v);
}

function uint(v: string | number, what: string): bigint {
  try {
    const n = BigInt(v);
    if (n < 0n) throw new Error('negative');
    return n;
  } catch {
    throw new ChainOpsError('bad_amount', `${what} must be a non-negative integer`);
  }
}

/** Decode and validate a `setParams` word the way the contract will; throws `ChainOpsError` otherwise. */
export function checkParamsWord(raw: string): { word: bigint; fields: ParamsWordFields } {
  let word: bigint;
  try {
    word = BigInt(raw.trim());
  } catch {
    throw new ChainOpsError('bad_amount', 'params word must be an integer');
  }
  if (word <= 0n || word >= 1n << 256n) {
    throw new ChainOpsError('bad_amount', 'params word must be a non-zero uint256');
  }
  const fields = unpackParamsWord(word);
  const errors = validateCurveParams({ ...fields, maxBuyNative: '0' });
  if (errors.length > 0) throw new ChainOpsError('bad_amount', errors.join('; '));
  // Round-trip: a word with stray bits (e.g. a fractional grad) is refused rather than silently normalised.
  if (packParamsWord(fields) !== word) {
    throw new ChainOpsError(
      'bad_amount',
      'params word does not round-trip through the field layout',
    );
  }
  return { word, fields };
}

export function prepareEvmAdminTx(
  net: EvmNet,
  chainId: number,
  launchpad: string,
  action: EvmAdminAction,
  ctx: { router?: string | null | undefined } = {},
): PreparedEvmTx {
  const lp = addr(launchpad, 'launchpad');
  const base = { net, chainId, value: '0' };
  const enc = (
    functionName: Parameters<typeof encodeFunctionData>[0]['functionName'],
    args?: unknown[],
  ): string =>
    encodeFunctionData({ abi: LAUNCHPAD_ADMIN_ABI, functionName, args } as Parameters<
      typeof encodeFunctionData
    >[0]);
  switch (action.kind) {
    case 'setPause':
      return {
        ...base,
        to: lp,
        data: enc('setPause', [
          action.trading,
          action.launch,
          action.protocolWithdrawals,
          action.opsWithdrawals,
          action.oracleGraduation,
        ]),
        summary: `setPause(trading=${action.trading}, launch=${action.launch}, protocolWithdrawals=${action.protocolWithdrawals}, opsWithdrawals=${action.opsWithdrawals}, oracleGraduation=${action.oracleGraduation})`,
        signer: 'admin',
      };
    case 'pause':
      return {
        ...base,
        to: lp,
        data: enc('pause', [
          action.trading,
          action.launch,
          action.protocolWithdrawals,
          action.opsWithdrawals,
          action.oracleGraduation,
        ]),
        summary: `pause(set-only): trading=${action.trading}, launch=${action.launch}, protocolWithdrawals=${action.protocolWithdrawals}, opsWithdrawals=${action.opsWithdrawals}, oracleGraduation=${action.oracleGraduation}`,
        signer: 'pauser',
      };
    case 'setPauser':
      return {
        ...base,
        to: lp,
        data: enc('setPauser', [addr(action.pauser, 'pauser')]),
        summary: `setPauser(${action.pauser})`,
        signer: 'admin',
      };
    case 'setMigrator':
      return {
        ...base,
        to: lp,
        data: enc('setMigrator', [
          addr(action.migrator, 'migrator'),
          addr(action.authority, 'authority'),
        ]),
        summary: `setMigrator(${action.migrator}, ${action.authority})`,
        signer: 'admin',
      };
    case 'setWithdrawAuthorities':
      return {
        ...base,
        to: lp,
        data: enc('setWithdrawAuthorities', [
          addr(action.protocol, 'protocol'),
          addr(action.ops, 'ops'),
        ]),
        summary: `setWithdrawAuthorities(${action.protocol}, ${action.ops})`,
        signer: 'admin',
      };
    case 'proposeAdmin':
      return {
        ...base,
        to: lp,
        data: enc('proposeAdmin', [addr(action.admin, 'admin')]),
        summary: `proposeAdmin(${action.admin})`,
        signer: 'admin',
      };
    case 'acceptAdmin':
      return {
        ...base,
        to: lp,
        data: enc('acceptAdmin'),
        summary: 'acceptAdmin()',
        signer: 'pendingAdmin',
      };
    case 'setPriceSource':
      return {
        ...base,
        to: lp,
        data: enc('setPriceSource', [addr(action.source, 'source')]),
        summary: `setPriceSource(${action.source})`,
        signer: 'admin',
      };
    case 'setMaxOracleStaleness': {
      const s = uint(action.seconds, 'seconds');
      if (s === 0n) throw new ChainOpsError('bad_amount', 'staleness must be > 0');
      return {
        ...base,
        to: lp,
        data: enc('setMaxOracleStaleness', [s]),
        summary: `setMaxOracleStaleness(${s}s)`,
        signer: 'admin',
      };
    }
    case 'withdrawTreasury': {
      if (![0, 1, 2].includes(action.which))
        throw new ChainOpsError('bad_amount', 'which must be 0, 1 or 2');
      const amount = uint(action.amountAtoms, 'amount');
      if (amount === 0n) throw new ChainOpsError('bad_amount', 'amount must be > 0');
      return {
        ...base,
        to: lp,
        data: enc('withdrawTreasury', [
          action.which,
          addr(action.baseToken, 'baseToken'),
          amount,
          addr(action.to, 'to'),
        ]),
        summary: `withdrawTreasury(which=${action.which}, base=${action.baseToken}, amount=${amount}, to=${action.to})`,
        signer: 'withdrawAuthority',
      };
    }
    case 'pushPrice': {
      const price = uint(action.price1e6, 'price1e6');
      if (price === 0n) throw new ChainOpsError('bad_amount', 'price must be > 0');
      return {
        ...base,
        to: addr(action.source, 'source'),
        data: encodeFunctionData({
          abi: PUSH_PRICE_SOURCE_ABI,
          functionName: 'pushPrice',
          args: [addr(action.baseToken, 'baseToken'), price, uint(action.conf1e6, 'conf1e6')],
        }),
        summary: `pushPrice(${action.baseToken}, ${price}, ${action.conf1e6})`,
        signer: 'oracleAuthority',
      };
    }
    case 'setParams': {
      const { word, fields: f } = checkParamsWord(action.word);
      return {
        ...base,
        to: lp,
        data: enc('setParams', [word]),
        summary: `setParams(protocol=${f.feeProtocolBps}, ops=${f.feeOpsBps}, burn=${f.feeBurnBps}, fee=${f.minFeeBps}..${f.maxFeeBps} bps, cbStart=${f.cbStartFeeBps} bps, cbWindow=${f.cbWindowSecs}s, grad=$${f.gradUsd}, maxSupply=${f.maxSupply}) word=${word}`,
        signer: 'admin',
      };
    }
    case 'setRouterConfig': {
      if (!ctx.router) {
        throw new ChainOpsError('not_deployed', 'no StonkzRouter is configured on this net');
      }
      const maxBuy = uint(action.maxBuyNative, 'maxBuyNative');
      return {
        ...base,
        to: addr(ctx.router, 'router'),
        data: encodeFunctionData({
          abi: ROUTER_ADMIN_ABI,
          functionName: 'setConfig',
          args: [
            maxBuy,
            addr(action.pyth, 'pyth'),
            addr(action.attestationSink, 'attestationSink'),
          ],
        }),
        summary: `router.setConfig(maxBuyNative=${maxBuy}${maxBuy === 0n ? ' (uncapped)' : ' wei'}, pyth=${action.pyth}, attestationSink=${action.attestationSink})`,
        signer: 'admin',
      };
    }
    case 'setTrustedRouter':
      return {
        ...base,
        to: lp,
        data: enc('setTrustedRouter', [addr(action.router, 'router')]),
        summary: `setTrustedRouter(${action.router})`,
        signer: 'admin',
      };
  }
}

/** Safe{Wallet} Transaction Builder import format (`https://app.safe.global`, "Transaction Builder" app). */
export function safeTransactionBuilderJson(input: {
  chainId: number;
  name: string;
  description: string;
  createdAtMs: number;
  createdFromSafeAddress?: string | undefined;
  txs: readonly { to: string; data: string; value: string }[];
}): Record<string, unknown> {
  return {
    version: '1.0',
    chainId: String(input.chainId),
    createdAt: input.createdAtMs,
    meta: {
      name: input.name,
      description: input.description,
      txBuilderVersion: '1.16.5',
      createdFromSafeAddress: input.createdFromSafeAddress ?? '',
      createdFromOwnerAddress: '',
      checksum: '',
    },
    transactions: input.txs.map((t) => ({
      to: t.to,
      value: t.value,
      data: t.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
}

/* ---------------------------------------------------------------- Solana */

export interface SolanaGlobalState {
  admin: string;
  pendingAdmin: string;
  protocolWithdrawAuthority: string;
  opsWithdrawAuthority: string;
  oracleAuthority: string;
  migrationAuthority: string;
  dexProgram: string;
  dexConfig: string;
  paused: {
    trading: boolean;
    launch: boolean;
    protocolWithdrawals: boolean;
    opsWithdrawals: boolean;
  };
  maxOracleStaleness: number;
  tokenCount: number;
}

/** `Global` per `state.rs`: 8-byte discriminator, bump, eight pubkeys, four bools, i64, u64. */
export function decodeSolanaGlobal(base64: string): SolanaGlobalState {
  const buf = Buffer.from(base64, 'base64');
  const need = 8 + 1 + 32 * 8 + 4 + 8 + 8;
  if (buf.length < need)
    throw new ChainOpsError('bad_account', `Global account too short (${buf.length} < ${need})`);
  let o = 8 + 1;
  const pk = (): string => {
    const v = new PublicKey(buf.subarray(o, o + 32)).toBase58();
    o += 32;
    return v;
  };
  const admin = pk();
  const pendingAdmin = pk();
  const protocolWithdrawAuthority = pk();
  const opsWithdrawAuthority = pk();
  const oracleAuthority = pk();
  const migrationAuthority = pk();
  const dexProgram = pk();
  const dexConfig = pk();
  const bool = (): boolean => buf[o++] === 1;
  const trading = bool();
  const launch = bool();
  const protocolWithdrawals = bool();
  const opsWithdrawals = bool();
  const maxOracleStaleness = Number(buf.readBigInt64LE(o));
  o += 8;
  const tokenCount = Number(buf.readBigUInt64LE(o));
  return {
    admin,
    pendingAdmin,
    protocolWithdrawAuthority,
    opsWithdrawAuthority,
    oracleAuthority,
    migrationAuthority,
    dexProgram,
    dexConfig,
    paused: { trading, launch, protocolWithdrawals, opsWithdrawals },
    maxOracleStaleness,
    tokenCount,
  };
}

export function decodeSolanaPauserConfig(base64: string): { pauser: string } {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 8 + 1 + 32)
    throw new ChainOpsError('bad_account', 'PauserConfig account too short');
  return { pauser: new PublicKey(buf.subarray(9, 41)).toBase58() };
}

/* ------------------------------------------------------ runtime params */

/** `set_params` payload — `ParamsArgs` in `instructions/params.rs`, same field order. */
export interface SolanaParamsArgs {
  feeProtocolBps: number;
  feeOpsBps: number;
  feeBurnBps: number;
  minFeeBps: number;
  maxFeeBps: number;
  cbStartFeeBps: number;
  cbWindowSecs: number;
  /** USD scaled 1e6, as a decimal string (u64). */
  gradMcapUsd1e6: string;
}

/** The `Params` PDA as the program sees it. `initialised: false` = the account does not exist and the program runs on these defaults. */
export interface SolanaParamsState extends SolanaParamsArgs {
  initialised: boolean;
}

/** `constants.rs` defaults — what `load_params` returns for an empty account. */
export const SOLANA_PARAMS_DEFAULTS: Readonly<SolanaParamsArgs> = Object.freeze({
  feeProtocolBps: 1500,
  feeOpsBps: 1000,
  feeBurnBps: 600,
  minFeeBps: 100,
  maxFeeBps: 500,
  cbStartFeeBps: 5000,
  cbWindowSecs: 300,
  gradMcapUsd1e6: '69000000000',
});

export function solanaParamsPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('params')], programId)[0];
}

/**
 * `Params` per `state.rs`: 8-byte discriminator, bump u8, six u16, u32, u64,
 * 64 reserved bytes. `null` / empty (the account was never created) decodes
 * to the defaults with `initialised: false`, exactly as `load_params` does.
 */
export function decodeSolanaParams(base64: string | null | undefined): SolanaParamsState {
  if (!base64) return { initialised: false, ...SOLANA_PARAMS_DEFAULTS };
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) return { initialised: false, ...SOLANA_PARAMS_DEFAULTS };
  const need = 8 + 1 + 2 * 6 + 4 + 8;
  if (buf.length < need)
    throw new ChainOpsError('bad_account', `Params account too short (${buf.length} < ${need})`);
  let o = 8 + 1;
  const u16 = (): number => {
    const v = buf.readUInt16LE(o);
    o += 2;
    return v;
  };
  const feeProtocolBps = u16();
  const feeOpsBps = u16();
  const feeBurnBps = u16();
  const minFeeBps = u16();
  const maxFeeBps = u16();
  const cbStartFeeBps = u16();
  const cbWindowSecs = buf.readUInt32LE(o);
  o += 4;
  const gradMcapUsd1e6 = buf.readBigUInt64LE(o).toString();
  return {
    initialised: true,
    feeProtocolBps,
    feeOpsBps,
    feeBurnBps,
    minFeeBps,
    maxFeeBps,
    cbStartFeeBps,
    cbWindowSecs,
    gradMcapUsd1e6,
  };
}

/**
 * Borsh-encoded `set_params(args)` instruction data, validated the way
 * `validate_params` in the program does so a bad payload fails here rather
 * than on chain.
 */
export function encodeSetParamsData(a: SolanaParamsArgs): Buffer {
  const bps = (v: number, what: string): number => {
    if (!Number.isInteger(v) || v < 0 || v > 10_000)
      throw new ChainOpsError('bad_amount', `${what} must be an integer in 0..=10000 bps`);
    return v;
  };
  const feeProtocolBps = bps(a.feeProtocolBps, 'feeProtocolBps');
  const feeOpsBps = bps(a.feeOpsBps, 'feeOpsBps');
  const feeBurnBps = bps(a.feeBurnBps, 'feeBurnBps');
  const minFeeBps = bps(a.minFeeBps, 'minFeeBps');
  const maxFeeBps = bps(a.maxFeeBps, 'maxFeeBps');
  const cbStartFeeBps = bps(a.cbStartFeeBps, 'cbStartFeeBps');
  if (feeProtocolBps + feeOpsBps + feeBurnBps > 10_000)
    throw new ChainOpsError(
      'bad_amount',
      'feeProtocolBps + feeOpsBps + feeBurnBps must be <= 10000',
    );
  if (minFeeBps > maxFeeBps)
    throw new ChainOpsError('bad_amount', 'minFeeBps must be <= maxFeeBps');
  if (maxFeeBps > cbStartFeeBps)
    throw new ChainOpsError('bad_amount', 'maxFeeBps must be <= cbStartFeeBps');
  if (!Number.isInteger(a.cbWindowSecs) || a.cbWindowSecs <= 0 || a.cbWindowSecs > 0xffff_ffff)
    throw new ChainOpsError('bad_amount', 'cbWindowSecs must be a positive u32');
  const grad = uint(a.gradMcapUsd1e6, 'gradMcapUsd1e6');
  if (grad === 0n) throw new ChainOpsError('bad_amount', 'gradMcapUsd1e6 must be > 0');
  const out = Buffer.alloc(8 + 2 * 6 + 4 + 8);
  anchorDiscriminator('set_params').copy(out, 0);
  let o = 8;
  for (const v of [feeProtocolBps, feeOpsBps, feeBurnBps, minFeeBps, maxFeeBps, cbStartFeeBps]) {
    out.writeUInt16LE(v, o);
    o += 2;
  }
  out.writeUInt32LE(a.cbWindowSecs, o);
  o += 4;
  out.writeBigUInt64LE(grad, o);
  return out;
}

/** `BaseOracle` per `state.rs`: bump, base_mint, price_1e6 u64, conf_1e6 u64, publish_time i64, base_decimals u8. */
export function decodeSolanaBaseOracle(base64: string): {
  baseMint: string;
  price1e6: string;
  conf1e6: string;
  publishTime: number;
} {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 8 + 1 + 32 + 8 + 8 + 8)
    throw new ChainOpsError('bad_account', 'BaseOracle account too short');
  let o = 9;
  const baseMint = new PublicKey(buf.subarray(o, o + 32)).toBase58();
  o += 32;
  const price1e6 = buf.readBigUInt64LE(o).toString();
  o += 8;
  const conf1e6 = buf.readBigUInt64LE(o).toString();
  o += 8;
  const publishTime = Number(buf.readBigInt64LE(o));
  return { baseMint, price1e6, conf1e6, publishTime };
}

export function solanaGlobalPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('global')], programId)[0];
}

export function solanaPauserPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pauser')], programId)[0];
}

export async function readSolanaGlobal(
  rpc: SolanaAccountDataSource,
  programId: PublicKey,
): Promise<{
  global: SolanaGlobalState | null;
  pauser: string | null;
  /** Runtime params; `initialised: false` with the defaults when `set_params` was never called. */
  params: SolanaParamsState;
}> {
  const [g, p, prm] = await Promise.all([
    rpc.getAccountDataBase64(solanaGlobalPda(programId).toBase58()),
    rpc.getAccountDataBase64(solanaPauserPda(programId).toBase58()),
    rpc.getAccountDataBase64(solanaParamsPda(programId).toBase58()),
  ]);
  return {
    global: g ? decodeSolanaGlobal(g) : null,
    pauser: p ? decodeSolanaPauserConfig(p).pauser : null,
    params: decodeSolanaParams(prm),
  };
}

export type SolanaAdminAction =
  | {
      kind: 'set_pause';
      trading?: boolean | undefined;
      launch?: boolean | undefined;
      protocolWithdrawals?: boolean | undefined;
      opsWithdrawals?: boolean | undefined;
    }
  | {
      kind: 'pause';
      trading: boolean;
      launch: boolean;
      protocolWithdrawals: boolean;
      opsWithdrawals: boolean;
    }
  | { kind: 'set_pauser'; pauser: string }
  | { kind: 'set_oracle_authority'; authority: string }
  | { kind: 'set_max_oracle_staleness'; seconds: number }
  | { kind: 'set_withdraw_authorities'; protocol?: string | undefined; ops?: string | undefined }
  | { kind: 'propose_admin'; admin: string }
  | { kind: 'accept_admin' }
  | {
      kind: 'withdraw_treasury';
      which: 0 | 1 | 2;
      baseMint: string;
      amountAtoms: string;
      to: string;
    }
  | { kind: 'push_price'; baseMint: string; price1e6: string; conf1e6: string }
  | { kind: 'set_params'; params: SolanaParamsArgs };

function pubkey(v: string, what: string): PublicKey {
  try {
    return new PublicKey(v);
  } catch {
    throw new ChainOpsError('bad_address', `${what} is not a Solana address`);
  }
}

function encodeOptionBool(v: boolean | undefined): Buffer {
  return v === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encodeBool(v)]);
}

function encodeOptionPubkey(v: string | undefined, what: string): Buffer {
  return v === undefined
    ? Buffer.from([0])
    : Buffer.concat([Buffer.from([1]), pubkey(v, what).toBuffer()]);
}

function encodeI64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}

/**
 * One unsigned instruction per admin action; account order per the Rust
 * `#[derive(Accounts)]` structs. `signer` is the wallet that must sign it.
 */
export function buildSolanaAdminInstruction(
  programId: PublicKey,
  signer: PublicKey,
  action: SolanaAdminAction,
): { ix: TransactionInstruction; summary: string; signer: PreparedEvmTx['signer'] } {
  const global = solanaGlobalPda(programId);
  const disc = (name: string): Buffer => anchorDiscriminator(name);
  switch (action.kind) {
    case 'set_pause':
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: true },
            { pubkey: signer, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([
            disc('set_pause'),
            encodeOptionBool(action.trading),
            encodeOptionBool(action.launch),
            encodeOptionBool(action.protocolWithdrawals),
            encodeOptionBool(action.opsWithdrawals),
          ]),
        }),
        summary: `set_pause(trading=${action.trading ?? '-'}, launch=${action.launch ?? '-'}, protocolWithdrawals=${action.protocolWithdrawals ?? '-'}, opsWithdrawals=${action.opsWithdrawals ?? '-'})`,
        signer: 'admin',
      };
    case 'pause':
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: true },
            { pubkey: solanaPauserPda(programId), isSigner: false, isWritable: false },
            { pubkey: signer, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([
            disc('pause'),
            encodeBool(action.trading),
            encodeBool(action.launch),
            encodeBool(action.protocolWithdrawals),
            encodeBool(action.opsWithdrawals),
          ]),
        }),
        summary: `pause(set-only): trading=${action.trading}, launch=${action.launch}, protocolWithdrawals=${action.protocolWithdrawals}, opsWithdrawals=${action.opsWithdrawals}`,
        signer: 'pauser',
      };
    case 'set_pauser':
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: false },
            { pubkey: solanaPauserPda(programId), isSigner: false, isWritable: true },
            { pubkey: signer, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc('set_pauser'), pubkey(action.pauser, 'pauser').toBuffer()]),
        }),
        summary: `set_pauser(${action.pauser})`,
        signer: 'admin',
      };
    case 'set_oracle_authority':
      return {
        ix: adminOnly(
          programId,
          global,
          signer,
          Buffer.concat([
            disc('set_oracle_authority'),
            pubkey(action.authority, 'authority').toBuffer(),
          ]),
        ),
        summary: `set_oracle_authority(${action.authority})`,
        signer: 'admin',
      };
    case 'set_max_oracle_staleness': {
      const s = BigInt(Math.floor(action.seconds));
      if (s <= 0n) throw new ChainOpsError('bad_amount', 'staleness must be > 0');
      return {
        ix: adminOnly(
          programId,
          global,
          signer,
          Buffer.concat([disc('set_max_oracle_staleness'), encodeI64(s)]),
        ),
        summary: `set_max_oracle_staleness(${s}s)`,
        signer: 'admin',
      };
    }
    case 'set_withdraw_authorities':
      return {
        ix: adminOnly(
          programId,
          global,
          signer,
          Buffer.concat([
            disc('set_withdraw_authorities'),
            encodeOptionPubkey(action.protocol, 'protocol'),
            encodeOptionPubkey(action.ops, 'ops'),
          ]),
        ),
        summary: `set_withdraw_authorities(protocol=${action.protocol ?? '-'}, ops=${action.ops ?? '-'})`,
        signer: 'admin',
      };
    case 'propose_admin':
      return {
        ix: adminOnly(
          programId,
          global,
          signer,
          Buffer.concat([disc('propose_admin'), pubkey(action.admin, 'admin').toBuffer()]),
        ),
        summary: `propose_admin(${action.admin})`,
        signer: 'admin',
      };
    case 'accept_admin':
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: true },
            { pubkey: signer, isSigner: true, isWritable: false },
          ],
          data: disc('accept_admin'),
        }),
        summary: 'accept_admin()',
        signer: 'pendingAdmin',
      };
    case 'withdraw_treasury': {
      if (![0, 1, 2].includes(action.which))
        throw new ChainOpsError('bad_amount', 'which must be 0, 1 or 2');
      const amount = uint(action.amountAtoms, 'amount');
      if (amount === 0n) throw new ChainOpsError('bad_amount', 'amount must be > 0');
      const baseMint = pubkey(action.baseMint, 'baseMint');
      const pdas = derivePdas(programId, baseMint, baseMint);
      const vault =
        action.which === 0
          ? pdas.protocolVault
          : action.which === 1
            ? pdas.opsVault
            : pdas.burnVault;
      const destination = getAssociatedTokenAddressSync(baseMint, pubkey(action.to, 'to'), true);
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: false },
            { pubkey: baseMint, isSigner: false, isWritable: false },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: signer, isSigner: true, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([
            disc('withdraw_treasury'),
            Buffer.from([action.which]),
            encodeU64(amount),
          ]),
        }),
        summary: `withdraw_treasury(which=${action.which}, base=${action.baseMint}, amount=${amount}, to=${action.to})`,
        signer: 'withdrawAuthority',
      };
    }
    case 'push_price': {
      const price = uint(action.price1e6, 'price1e6');
      if (price === 0n) throw new ChainOpsError('bad_amount', 'price must be > 0');
      const baseMint = pubkey(action.baseMint, 'baseMint');
      const oracle = derivePdas(programId, baseMint, baseMint).oracle;
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: false },
            { pubkey: oracle, isSigner: false, isWritable: true },
            { pubkey: baseMint, isSigner: false, isWritable: false },
            { pubkey: signer, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([
            disc('push_price'),
            encodeU64(price),
            encodeU64(uint(action.conf1e6, 'conf1e6')),
          ]),
        }),
        summary: `push_price(${action.baseMint}, ${price}, ${action.conf1e6})`,
        signer: 'oracleAuthority',
      };
    }
    case 'set_params': {
      // `SetParams`: global (has_one admin), params PDA (init_if_needed, so
      // writable + admin pays), admin signer, system program.
      const a = action.params;
      return {
        ix: new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: false },
            { pubkey: solanaParamsPda(programId), isSigner: false, isWritable: true },
            { pubkey: signer, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: encodeSetParamsData(a),
        }),
        summary: `set_params(protocol=${a.feeProtocolBps}, ops=${a.feeOpsBps}, burn=${a.feeBurnBps}, fee=${a.minFeeBps}..${a.maxFeeBps} bps, cbStart=${a.cbStartFeeBps} bps, cbWindow=${a.cbWindowSecs}s, grad=$${Number(BigInt(a.gradMcapUsd1e6) / 1_000_000n)})`,
        signer: 'admin',
      };
    }
  }
}

function adminOnly(
  programId: PublicKey,
  global: PublicKey,
  admin: PublicKey,
  data: Buffer,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: global, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** A legacy transaction with the admin as fee payer, serialised unsigned (base64) for the browser wallet. */
export async function composeSolanaAdminTransaction(
  rpc: SolanaBlockhashSource,
  feePayer: PublicKey,
  ix: TransactionInstruction,
): Promise<{ transaction: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  tx.add(ix);
  return {
    transaction: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    lastValidBlockHeight,
  };
}

export class ChainOpsError extends Error {
  constructor(
    readonly code:
      'bad_address' | 'bad_amount' | 'bad_account' | 'not_deployed' | 'rpc_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ChainOpsError';
  }
}
