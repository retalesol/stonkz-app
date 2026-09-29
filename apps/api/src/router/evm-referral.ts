import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { EvmLog } from '../chain/types.js';

/**
 * `programs/evm/src/ReferralVault.sol` — the slice the API touches: the two
 * claim entrypoints `/referrals/claim/prepare` encodes and the
 * `ReferralClaimed` event `/referrals/claim/confirm` reads back.
 */
export const REFERRAL_VAULT_ABI = parseAbi([
  'function claim(address to, address asset, uint256 cumulativeAmount, uint256 deadline, bytes sig) returns (uint256 paid)',
  'function claimAsEth(address to, uint256 cumulativeAmount, uint256 deadline, bytes sig) returns (uint256 paid)',
  'function claimed(address recipient, address asset) view returns (uint256)',
  'function signer() view returns (address)',
  'function paused() view returns (bool)',
  'function maxPerDay(address asset) view returns (uint256)',
  'event ReferralClaimed(address indexed recipient, address indexed asset, uint256 amount, uint256 cumulativeAmount, bool unwrapped, address caller)',
]);

export interface EvmClaimArgs {
  recipient: Address;
  asset: Address;
  cumulativeAmount: bigint;
  deadline: bigint;
  signature: Hex;
}

/** `claim(...)`: pays the ERC-20 (WETH) itself. Anyone may submit it. */
export function encodeReferralClaimCall(a: EvmClaimArgs): Hex {
  return encodeFunctionData({
    abi: REFERRAL_VAULT_ABI,
    functionName: 'claim',
    args: [a.recipient, a.asset, a.cumulativeAmount, a.deadline, a.signature],
  });
}

/** `claimAsEth(...)`: unwraps WETH to ETH. Only the recipient may send it. */
export function encodeReferralClaimAsEthCall(a: Omit<EvmClaimArgs, 'asset'>): Hex {
  return encodeFunctionData({
    abi: REFERRAL_VAULT_ABI,
    functionName: 'claimAsEth',
    args: [a.recipient, a.cumulativeAmount, a.deadline, a.signature],
  });
}

export interface ReferralClaimedLog {
  recipient: Address;
  asset: Address;
  amount: bigint;
  cumulativeAmount: bigint;
  unwrapped: boolean;
  caller: Address;
}

/** Every `ReferralClaimed` the vault at `vault` emitted in these logs. */
export function decodeReferralClaimedLogs(logs: EvmLog[], vault: string): ReferralClaimedLog[] {
  const out: ReferralClaimedLog[] = [];
  const want = vault.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== want) continue;
    try {
      const decoded = decodeEventLog({
        abi: REFERRAL_VAULT_ABI,
        eventName: 'ReferralClaimed',
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      out.push({
        recipient: decoded.args.recipient,
        asset: decoded.args.asset,
        amount: decoded.args.amount,
        cumulativeAmount: decoded.args.cumulativeAmount,
        unwrapped: decoded.args.unwrapped,
        caller: decoded.args.caller,
      });
    } catch {
      // another event of the vault's (Funded, SignerSet, …)
    }
  }
  return out;
}
