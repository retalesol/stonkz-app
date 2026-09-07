import { decodeEventLog, encodeFunctionData, type Address, type Hex } from 'viem';
import type { EvmLog } from '../chain/types.js';
import { LAUNCHPAD_ABI, TOKEN_CREATED_EVENT_ABI } from './evm-abi.js';

export interface CreateTokenCallArgs {
  name: string;
  ticker: string;
  uri: string;
  /** Whole-token units — `StonkzLaunchpad.createToken` multiplies by `1e18` itself, exactly like the Solana instruction does by `10^TOKEN_DECIMALS`. */
  supply: bigint;
  baseToken: Address;
  feeBps: number;
  cashback: boolean;
}

export function encodeCreateTokenCall(args: CreateTokenCallArgs): Hex {
  return encodeFunctionData({
    abi: LAUNCHPAD_ABI,
    functionName: 'createToken',
    args: [args.name, args.ticker, args.uri, args.supply, args.baseToken, args.feeBps, args.cashback],
  });
}

export function encodeClaimCreatorFeesCall(token: Address): Hex {
  return encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: 'claimCreatorFees', args: [token] });
}

export interface DecodedTokenCreated {
  token: Address;
  baseToken: Address;
  creator: Address;
  ticker: string;
  supply: bigint;
  feeBps: number;
  cashback: boolean;
  cbStart: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  tokensForSale: bigint;
  lpReserve: bigint;
  gradMcapBase: bigint;
  basePrice1e6: bigint;
}

/**
 * Finds and decodes `TokenCreated` off a confirmed transaction's logs.
 * Returns `null` if no such log is present — `/launch/confirm` treats that as
 * "this transaction did not create a token," regardless of whether it
 * otherwise succeeded.
 */
export function decodeTokenCreated(logs: EvmLog[], launchpad: Address): DecodedTokenCreated | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== launchpad.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: TOKEN_CREATED_EVENT_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'TokenCreated') continue;
      const a = decoded.args;
      return {
        token: a.token,
        baseToken: a.baseToken,
        creator: a.creator,
        ticker: a.ticker,
        supply: a.supply,
        feeBps: a.feeBps,
        cashback: a.cashback,
        cbStart: a.cbStart,
        virtualBase: a.virtualBase,
        virtualToken: a.virtualToken,
        tokensForSale: a.tokensForSale,
        lpReserve: a.lpReserve,
        gradMcapBase: a.gradMcapBase,
        basePrice1e6: a.basePrice1e6,
      };
    } catch {
      // Not a `TokenCreated` log (wrong shape/topic) — keep scanning.
    }
  }
  return null;
}
