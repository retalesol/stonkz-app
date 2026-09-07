/**
 * Builds the single atomic transaction `POST /trade/prepare` sends for
 * Robinhood Chain once a `StonkzRouter` deployment is configured
 * (`ApiEnv.rhRouterAddress`) and the trade's base asset has a route the
 * router can take (`stonkzRouterDecision`) — one call to
 * `buyViaAggregator`/`sellViaAggregator`, `atomic: true`, closing the gap
 * `docs/rh-trade-atomicity-gap.md` and `router/evm-tx.ts`'s header document.
 *
 * `router/evm-tx.ts`'s ordered `EvmStep[]` composer is kept, unchanged, as
 * the fallback for whatever `stonkzRouterDecision` returns `null` for: no
 * router configured at all (`rhRouterAddress` still the zero-address
 * placeholder), or an aggregator-hop base asset with no pinned v3 fee tier
 * (`ApiEnv.rhV3FeeTierOverrides` — deliberately empty by default, see that
 * field's doc comment).
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { Net } from '@stonkz/shared';
import { ZERO_EVM_ADDRESS } from '../env.js';
import { STONKZ_ROUTER_ABI } from './evm-abi.js';
import {
  buildBuyAggregatorLeg,
  buildSellAggregatorLeg,
  buildUnwrapOnlyLeg,
  buildWrapOnlyLeg,
  type UniversalRouterLeg,
} from './universal-router.js';

/** `StonkzRouter.sol`'s `MAX_SLIPPAGE_BPS` — the ceiling the contract itself enforces on `AggregatorLeg.maxSlippageBps` (`SlippageTooWide` otherwise). Mirrored here so a caller with a wide `Settings.slip` gets a working, clamped call instead of a guaranteed on-chain revert. */
export const ROUTER_MAX_SLIPPAGE_BPS = 500;

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}` as Hex;

export interface EvmAtomicCall {
  atomic: true;
  chain: 'RH';
  to: Address;
  data: Hex;
  /** Decimal wei string; `'0'` for the sell path (no `msg.value`). */
  value: string;
}

/** `StonkzRouter.PermitData` with `deadline == 0` taking the standing-allowance branch — `PermitData(0, 0, 0, 0x0..0, 0x0..0)`, exactly `programs/evm/test/Router.t.sol`'s `_noPermit()`. */
export function noPermit(): { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex } {
  return { value: 0n, deadline: 0n, v: 0, r: ZERO_BYTES32, s: ZERO_BYTES32 };
}

export interface PermitInput {
  /** Decimal atoms string — must match `amountToken` for `permit`'s signature to verify. */
  value: string;
  /** Unix seconds. */
  deadline: number;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * Which base assets `StonkzRouter` may be used for on this net, given the
 * operator's own config. `null` means "use the `EvmStep[]` fallback" — never
 * a guessed default; see `ApiEnv.rhV3FeeTierOverrides`'s doc comment for why.
 */
export type RouterRoute = { mode: 'direct' } | { mode: 'aggregator'; feeTier: number };

/** Looks a pinned v3 fee tier up by base mint or symbol (`ApiEnv.rhV3FeeTierOverrides`'s keys are upper-cased by `env.ts`'s `intMap`). */
export function pinnedV3FeeTierFor(
  baseMint: string,
  baseSymbol: string,
  overrides: Record<string, number>,
): number | null {
  const key = baseSymbol.toUpperCase();
  const mintKey = baseMint.toUpperCase();
  return overrides[key] ?? overrides[mintKey] ?? null;
}

/**
 * `isDirectPair`: `aggregatorFor(net, baseSymbol) === null` — the base asset
 * already is wrapped-native, so no v3 pool is needed at all (`buildWrapOnlyLeg`
 * / `buildUnwrapOnlyLeg`). Otherwise a pinned fee tier is required.
 */
export function stonkzRouterDecision(
  net: Net,
  routerAddress: string,
  isDirectPair: boolean,
  baseMint: string,
  baseSymbol: string,
  feeTierOverrides: Record<string, number>,
): RouterRoute | null {
  if (net !== 'RH') return null;
  if (!routerAddress || routerAddress.toLowerCase() === ZERO_EVM_ADDRESS) return null;
  if (isDirectPair) return { mode: 'direct' };
  const feeTier = pinnedV3FeeTierFor(baseMint, baseSymbol, feeTierOverrides);
  return feeTier === null ? null : { mode: 'aggregator', feeTier };
}

function clampSlippageBps(userSlippagePct: number): number {
  const bps = Math.round(userSlippagePct * 100);
  return Math.max(0, Math.min(ROUTER_MAX_SLIPPAGE_BPS, bps));
}

function legFor(route: RouterRoute, side: 'buy' | 'sell', weth: Address, base: Address): UniversalRouterLeg {
  if (route.mode === 'direct') return side === 'buy' ? buildWrapOnlyLeg() : buildUnwrapOnlyLeg();
  return side === 'buy'
    ? buildBuyAggregatorLeg(weth, base, route.feeTier)
    : buildSellAggregatorLeg(base, weth, route.feeTier);
}

export interface BuildAtomicBuyParams {
  routerAddress: Address;
  token: Address;
  weth: Address;
  baseMint: Address;
  route: RouterRoute;
  /** `msg.value` — `curveAmountInAtoms` for a buy (native atoms in). */
  ethInAtoms: bigint;
  /** The base token amount this leg is expected to deliver — `aggregatorQuote.outAmountAtoms` on the aggregator hop, or `ethInAtoms` itself on the direct-pair path (1:1 wrap). */
  quotedBaseOutAtoms: bigint;
  /** `curveMinOutAtoms` — the curve's own floor, tokens out. Kept independent of the aggregator leg's own bound; see `StonkzRouter.buyViaAggregator`'s doc comment. */
  minTokenOutAtoms: bigint;
  /** `Settings.slip`, percent (e.g. `1.5` = 1.5%). Clamped to the contract's `MAX_SLIPPAGE_BPS` for the aggregator leg's own tolerance; `0` on the direct-pair path (an exact 1:1 wrap has no market risk to tolerate). */
  userSlippagePct: number;
  deadlineUnixSeconds: number;
}

/** `StonkzRouter.buyViaAggregator(token, leg, minTokenOut, deadline)`, `atomic: true`. */
export function buildAtomicBuyCall(p: BuildAtomicBuyParams): EvmAtomicCall {
  const leg = legFor(p.route, 'buy', p.weth, p.baseMint);
  const maxSlippageBps = p.route.mode === 'direct' ? 0 : clampSlippageBps(p.userSlippagePct);
  const deadline = BigInt(p.deadlineUnixSeconds);

  const data = encodeFunctionData({
    abi: STONKZ_ROUTER_ABI,
    functionName: 'buyViaAggregator',
    args: [
      p.token,
      {
        commands: leg.commands,
        inputs: [...leg.inputs],
        deadline,
        // Ignored on the buy path per the contract's own doc comment — the input is `msg.value`.
        amountIn: 0n,
        quotedOut: p.quotedBaseOutAtoms,
        maxSlippageBps: BigInt(maxSlippageBps),
      },
      p.minTokenOutAtoms,
      deadline,
    ],
  });

  return { atomic: true, chain: 'RH', to: p.routerAddress, data, value: p.ethInAtoms.toString() };
}

export interface BuildAtomicSellParams {
  routerAddress: Address;
  token: Address;
  weth: Address;
  baseMint: Address;
  route: RouterRoute;
  /** `curveAmountInAtoms` for a sell — launched-token atoms being sold. */
  amountTokenAtoms: bigint;
  /** `curveNetBaseOutAtoms` — the curve's expected base proceeds, which is also exactly `AggregatorLeg.amountIn` (the amount the off-chain quote, if any, was built against). */
  netBaseOutAtoms: bigint;
  /** The final ETH amount this leg is expected to deliver — `aggregatorQuote.outAmountAtoms` on the aggregator hop, or `netBaseOutAtoms` itself on the direct-pair path (1:1 unwrap). */
  quotedEthOutAtoms: bigint;
  /** `curveMinBaseOutAtoms` — the curve-only floor, base terms. */
  minBaseOutAtoms: bigint;
  /** `curveMinOutAtoms` — the end-to-end floor, final ETH terms. Independent of `minBaseOutAtoms`; see `CurveTradeComposition.curveMinBaseOutAtoms`'s doc comment. */
  minEthOutAtoms: bigint;
  userSlippagePct: number;
  deadlineUnixSeconds: number;
  /** `null` takes the standing-allowance branch (`PermitData.deadline == 0`) — the caller must already have approved `routerAddress` on `token`. */
  permit: PermitInput | null;
}

/** `StonkzRouter.sellViaAggregator(token, amountToken, permitData, minBaseOut, leg, minEthOut, deadline)`, `atomic: true`. */
export function buildAtomicSellCall(p: BuildAtomicSellParams): EvmAtomicCall {
  const leg = legFor(p.route, 'sell', p.weth, p.baseMint);
  const maxSlippageBps = p.route.mode === 'direct' ? 0 : clampSlippageBps(p.userSlippagePct);
  const deadline = BigInt(p.deadlineUnixSeconds);
  const permitData = p.permit
    ? { value: BigInt(p.permit.value), deadline: BigInt(p.permit.deadline), v: p.permit.v, r: p.permit.r, s: p.permit.s }
    : noPermit();

  const data = encodeFunctionData({
    abi: STONKZ_ROUTER_ABI,
    functionName: 'sellViaAggregator',
    args: [
      p.token,
      p.amountTokenAtoms,
      permitData,
      p.minBaseOutAtoms,
      {
        commands: leg.commands,
        inputs: [...leg.inputs],
        deadline,
        amountIn: p.netBaseOutAtoms,
        quotedOut: p.quotedEthOutAtoms,
        maxSlippageBps: BigInt(maxSlippageBps),
      },
      p.minEthOutAtoms,
      deadline,
    ],
  });

  return { atomic: true, chain: 'RH', to: p.routerAddress, data, value: '0' };
}

/**
 * EIP-2612 typed data for a sell's permit signature — `StonkzToken.sol`'s own
 * domain (`name` = the *token's* name, `version` = `"1"`) and `Permit` type.
 * Returned so a future caller can skip the standing-allowance branch's prior
 * `approve` transaction entirely; not consumed anywhere in this phase since
 * `apps/web`'s trade-box wiring (Phase 2.C) has not landed yet — see the
 * phase report.
 *
 * `nonce` is deliberately `null`, not pre-fetched: `nonces(owner)` is an
 * on-chain read this endpoint would have to make on every sell quote just in
 * case the caller wants to sign a permit, and a value baked into this
 * response can go stale in the (likely longer) gap between `/trade/prepare`
 * and the wallet actually prompting for a signature. The caller must read it
 * fresh immediately before signing.
 */
export interface Eip712PermitTypedData {
  domain: { name: string; version: '1'; chainId: number; verifyingContract: Address };
  types: { Permit: { name: string; type: string }[] };
  primaryType: 'Permit';
  message: { owner: Address; spender: Address; value: string; nonce: null; deadline: number };
  note: string;
}

export function buildSellPermitTypedData(params: {
  tokenAddress: Address;
  tokenName: string;
  chainId: number;
  routerAddress: Address;
  owner: Address;
  valueAtoms: bigint;
  deadlineUnixSeconds: number;
}): Eip712PermitTypedData {
  return {
    domain: {
      name: params.tokenName,
      version: '1',
      chainId: params.chainId,
      verifyingContract: params.tokenAddress,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: params.owner,
      spender: params.routerAddress,
      value: params.valueAtoms.toString(),
      nonce: null,
      deadline: params.deadlineUnixSeconds,
    },
    note:
      'nonce is not pre-fetched: read nonces(owner) on the token contract immediately before signing, ' +
      'not this value (which does not exist), to avoid a stale-nonce signature failure.',
  };
}
