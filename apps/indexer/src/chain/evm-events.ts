import { decodeEventLog, type Abi } from 'viem';

/**
 * `programs/evm/src/StonkzLaunchpad.sol`'s and `StonkzRouter.sol`'s event ABIs,
 * transcribed from the Solidity source.
 *
 * Hand-written for the same reason `apps/api/src/router/evm-abi.ts` is: there
 * is no committed Foundry build artifact, so importing an ABI JSON would make
 * the indexer depend on a `forge build` having run wherever it is deployed.
 * `apps/api`'s file carries only the function fragments plus `TokenCreated`,
 * because that is all `/launch/confirm` needed; the indexer needs every event,
 * so the full set lives here rather than being bolted onto the router's file.
 *
 * Decoding goes through viem's `decodeEventLog`, which checks the topic0
 * signature hash and the indexed/non-indexed split — not a string match on the
 * log data.
 */
export const LAUNCHPAD_EVENTS_ABI = [
  {
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'baseToken', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'ticker', type: 'string', indexed: false },
      { name: 'supply', type: 'uint256', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false },
      { name: 'cashback', type: 'bool', indexed: false },
      { name: 'cbStart', type: 'uint64', indexed: false },
      { name: 'virtualBase', type: 'uint256', indexed: false },
      { name: 'virtualToken', type: 'uint256', indexed: false },
      { name: 'tokensForSale', type: 'uint256', indexed: false },
      { name: 'lpReserve', type: 'uint256', indexed: false },
      { name: 'gradMcapBase', type: 'uint256', indexed: false },
      { name: 'basePrice1e6', type: 'uint256', indexed: false },
    ],
  },
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
    name: 'FeeAccrued',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'baseToken', type: 'address', indexed: true },
      { name: 'feeTotal', type: 'uint256', indexed: false },
      { name: 'protocol', type: 'uint256', indexed: false },
      { name: 'ops', type: 'uint256', indexed: false },
      { name: 'burn', type: 'uint256', indexed: false },
      { name: 'creatorBucket', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TreasuryCredit',
    inputs: [
      { name: 'baseToken', type: 'address', indexed: true },
      { name: 'protocolDelta', type: 'uint256', indexed: false },
      { name: 'opsDelta', type: 'uint256', indexed: false },
      { name: 'burnDelta', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TreasuryWithdrawn',
    inputs: [
      { name: 'baseToken', type: 'address', indexed: true },
      { name: 'which', type: 'uint8', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Graduated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'reason', type: 'uint8', indexed: false },
      { name: 'baseMigrated', type: 'uint256', indexed: false },
      { name: 'tokensMigrated', type: 'uint256', indexed: false },
      { name: 'tokensBurned', type: 'uint256', indexed: false },
      { name: 'mcapBase', type: 'uint256', indexed: false },
      { name: 'mcapUsd1e6', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LiquidityMigrated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'liquidityBurned', type: 'uint256', indexed: false },
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
    name: 'Staked',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'lockDays', type: 'uint16', indexed: false },
      { name: 'weight', type: 'uint256', indexed: false },
      { name: 'lockUntil', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Unstaked',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
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
] as const satisfies Abi;

/**
 * `StonkzRouter.sol`'s two events. These matter for a reason the launchpad's
 * own events cannot cover: `Trade.baseAmount` is denominated in the curve's
 * *base* asset, but every game weighting and every tape row is denominated in
 * the chain's **native** unit. On an atomic RH trade the router is the only
 * place that knows the real ETH leg, so `AtomicBuy.ethIn` / `AtomicSell.ethOut`
 * are used to set `nativeAmount` exactly instead of inferring it through a USD
 * price. See `market.ts` for the fallback when a trade did not go through the
 * router.
 */
export const ROUTER_EVENTS_ABI = [
  {
    type: 'event',
    name: 'AtomicBuy',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'ethIn', type: 'uint256', indexed: false },
      { name: 'baseFromAggregator', type: 'uint256', indexed: false },
      { name: 'tokensOut', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AtomicSell',
    inputs: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'tokensIn', type: 'uint256', indexed: false },
      { name: 'baseFromCurve', type: 'uint256', indexed: false },
      { name: 'ethOut', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies Abi;

export const STONKZ_EVENTS_ABI = [...LAUNCHPAD_EVENTS_ABI, ...ROUTER_EVENTS_ABI] as const;

export type EvmEventName =
  (typeof LAUNCHPAD_EVENTS_ABI)[number]['name'] | (typeof ROUTER_EVENTS_ABI)[number]['name'];

export interface RawEvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface DecodedEvmEvent {
  name: EvmEventName;
  args: Record<string, unknown>;
}

/**
 * Decodes one log against the combined ABI, or `null` when topic0 matches
 * nothing we know. Unknown logs are expected — a launchpad transaction also
 * emits ERC-20 `Transfer`s — so this is a filter, not an error path.
 */
export function decodeStonkzLog(log: { topics: string[]; data: string }): DecodedEvmEvent | null {
  if (log.topics.length === 0) return null;
  try {
    const decoded = decodeEventLog({
      abi: STONKZ_EVENTS_ABI,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data as `0x${string}`,
    });
    return {
      name: decoded.eventName as EvmEventName,
      args: decoded.args as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}
