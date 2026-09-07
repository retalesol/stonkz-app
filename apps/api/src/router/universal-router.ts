/**
 * Off-chain construction of Uniswap Universal Router `execute(commands,
 * inputs, deadline)` payloads, for `router/evm-router.ts`'s `StonkzRouter`
 * calls.
 *
 * `docs/robinhood-chain.md` §3.3 (post-correction) and
 * `programs/evm/src/StonkzRouter.sol`'s own header are both explicit about
 * the one thing that must never be transposed: the Universal Router's two
 * recipient sentinels.
 *
 * - `MSG_SENDER = address(1)` resolves to whoever called `execute` — for
 *   every leg this module builds, that is `StonkzRouter` itself, since it is
 *   the one holding `universalRouter` and calling into it. This is the
 *   sentinel a swap's *final* output must carry.
 * - `ADDRESS_THIS = address(2)` resolves to the Universal Router's own
 *   address. Encoding it as a final recipient strands the output in a
 *   contract with no owner; it is only ever correct for an *intermediate*
 *   hop inside a multi-command sequence that the same `execute` call
 *   continues to spend from.
 *
 * This module never forwards calldata from Uniswap's `/v1/swap` endpoint —
 * that calldata targets the Universal Router with the trader's own EOA as
 * recipient, which is precisely the non-atomic shape `StonkzRouter` exists to
 * replace (`router/evm-tx.ts`'s header has the full history). The Trading
 * API's `/v1/quote` is used for *pricing only* (`router/uniswap.ts`); every
 * command byte and input blob below is built here, against the same
 * `V3_SWAP_EXACT_IN` / `WRAP_ETH` / `UNWRAP_WETH` encoding
 * `programs/evm/test/mocks/MockUniversalRouter.sol` documents as "the real
 * Universal Router command bytes".
 *
 * **One thing that mock deliberately does not exercise**: it lets
 * `V3_SWAP_EXACT_IN` accept `msg.value` directly, as a test simplification.
 * The real Universal Router's V3 module always settles from an ERC-20
 * balance (Uniswap v3 pools do not hold native ETH) — a swap whose input is
 * ETH needs a preceding `WRAP_ETH` command to actually produce a WETH
 * balance the router can then spend with `payerIsUser = false`, and
 * symmetrically a swap whose *output* the caller wants as native ETH needs a
 * trailing `UNWRAP_WETH`. That is confirmed by Uniswap's `Payments.pay()`:
 * a non-ETH-sentinel token with `payer == address(this)` is moved with a
 * plain `ERC20.transfer` from whatever balance the router already holds —
 * nothing wraps it implicitly. `programs/evm/test/Router.t.sol`'s suite is
 * therefore silent on this two-command shape (the mock's single-command
 * shortcut passes as-is); this module's own tests
 * (`universal-router.test.ts`) are the correctness backstop for it until a
 * fork test or an upgraded mock exercises it at the contract layer too —
 * flagged in the phase report, not hidden.
 */
import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem';

/** Whoever called `execute` — always `StonkzRouter` for every leg this module builds. */
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
/** The Universal Router itself — only ever correct for an intermediate hop. */
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
/** `1 << 255` — "spend/wrap/unwrap the router's entire current balance of the relevant asset", the idiomatic Universal Router sentinel for chaining commands without tracking exact intermediate amounts off-chain. */
export const CONTRACT_BALANCE = 1n << 255n;

/** Real Universal Router command bytes (`programs/evm/test/mocks/MockUniversalRouter.sol`'s own naming). */
const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_WRAP_ETH = 0x0b;
const CMD_UNWRAP_WETH = 0x0c;

function commandsBytes(cmds: readonly number[]): Hex {
  return `0x${cmds.map((c) => c.toString(16).padStart(2, '0')).join('')}` as Hex;
}

/** `(tokenIn, fee, tokenOut)` packed 20/3/20 bytes — a single-pool v3 path. Multi-hop paths are out of scope: `rhV3FeeTierOverrides` pins one pool per base mint, not a route. */
export function encodeV3Path(tokenIn: Address, feeTier: number, tokenOut: Address): Hex {
  return encodePacked(['address', 'uint24', 'address'], [tokenIn, feeTier, tokenOut]);
}

/** `abi.encode(recipient, amountIn, amountOutMinimum, path, payerIsUser)` — exactly `MockUniversalRouter.sol`'s own decode order, which is itself the real `V3SwapRouter` input layout. */
function encodeV3SwapExactInInput(
  recipient: Address,
  amountIn: bigint,
  amountOutMinimum: bigint,
  path: Hex,
  payerIsUser: boolean,
): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [recipient, amountIn, amountOutMinimum, path, payerIsUser],
  );
}

/** `abi.encode(recipient, amount)` — `WRAP_ETH`'s input (`Payments.sol`'s `wrapETH`). */
function encodeWrapEthInput(recipient: Address, amount: bigint): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amount]);
}

/** `abi.encode(recipient, amountMinimum)` — `UNWRAP_WETH`'s input (`Payments.sol`'s `unwrapWETH9`). */
function encodeUnwrapWethInput(recipient: Address, amountMinimum: bigint): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amountMinimum]);
}

export interface UniversalRouterLeg {
  commands: Hex;
  inputs: readonly Hex[];
}

/**
 * Direct-pair buy fast path (`aggregatorFor` returned `null` — base already
 * is wrapped-native): a single `WRAP_ETH`, recipient `MSG_SENDER`. No V3 pool
 * exists to route through because there is nothing to swap — the only job is
 * turning the `msg.value` `StonkzRouter` just received into the WETH balance
 * it is about to spend on the curve.
 */
export function buildWrapOnlyLeg(): UniversalRouterLeg {
  return { commands: commandsBytes([CMD_WRAP_ETH]), inputs: [encodeWrapEthInput(MSG_SENDER, CONTRACT_BALANCE)] };
}

/**
 * Direct-pair sell fast path: a single `UNWRAP_WETH`, recipient `MSG_SENDER`.
 * `StonkzRouter` transfers exactly the curve's base proceeds to the Universal
 * Router immediately before `execute()`, so "the router's entire WETH
 * balance" and "this leg's amount" are the same number inside one atomic
 * call.
 */
export function buildUnwrapOnlyLeg(): UniversalRouterLeg {
  return { commands: commandsBytes([CMD_UNWRAP_WETH]), inputs: [encodeUnwrapWethInput(MSG_SENDER, 0n)] };
}

/**
 * Aggregator-hop buy: `WRAP_ETH` (recipient `ADDRESS_THIS` — an intermediate
 * hop the same `execute` call continues to spend from) then
 * `V3_SWAP_EXACT_IN` (recipient `MSG_SENDER`, `payerIsUser = false` because
 * the Universal Router is paying from the WETH balance it just wrapped, not
 * pulling from the trader).
 */
export function buildBuyAggregatorLeg(weth: Address, base: Address, feeTier: number): UniversalRouterLeg {
  const path = encodeV3Path(weth, feeTier, base);
  return {
    commands: commandsBytes([CMD_WRAP_ETH, CMD_V3_SWAP_EXACT_IN]),
    inputs: [
      encodeWrapEthInput(ADDRESS_THIS, CONTRACT_BALANCE),
      encodeV3SwapExactInInput(MSG_SENDER, CONTRACT_BALANCE, 0n, path, false),
    ],
  };
}

/**
 * Aggregator-hop sell: `V3_SWAP_EXACT_IN` (recipient `ADDRESS_THIS`,
 * `payerIsUser = false` — the base token was transferred to the Universal
 * Router's own balance by `StonkzRouter` just before `execute()`, exactly the
 * shape `sellViaAggregator`'s doc comment requires) then `UNWRAP_WETH`
 * (recipient `MSG_SENDER`).
 */
export function buildSellAggregatorLeg(base: Address, weth: Address, feeTier: number): UniversalRouterLeg {
  const path = encodeV3Path(base, feeTier, weth);
  return {
    commands: commandsBytes([CMD_V3_SWAP_EXACT_IN, CMD_UNWRAP_WETH]),
    inputs: [
      encodeV3SwapExactInInput(ADDRESS_THIS, CONTRACT_BALANCE, 0n, path, false),
      encodeUnwrapWethInput(MSG_SENDER, 0n),
    ],
  };
}
