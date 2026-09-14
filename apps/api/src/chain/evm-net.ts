import type { EvmNet } from '@stonkz/shared';
import type { ApiEnv } from '../env.js';
import type { ChainRpcs } from './types.js';
import type { EvmRpc } from './evm.js';

export function evmChainId(env: ApiEnv, net: EvmNet): number {
  return net === 'BASE' ? env.baseChainId : env.rhChainId;
}

export function evmLaunchpadAddress(env: ApiEnv, net: EvmNet): string {
  return net === 'BASE' ? env.baseLaunchpadAddress : env.rhLaunchpadAddress;
}

export function evmRouterAddress(env: ApiEnv, net: EvmNet): string {
  return net === 'BASE' ? env.baseRouterAddress : env.rhRouterAddress;
}

export function evmV3FeeTierOverrides(env: ApiEnv, net: EvmNet): Record<string, number> {
  return net === 'BASE' ? env.baseV3FeeTierOverrides : env.rhV3FeeTierOverrides;
}

export function evmV3FactoryAddress(env: ApiEnv, net: EvmNet): string {
  return net === 'BASE' ? env.baseV3FactoryAddress : env.rhV3FactoryAddress;
}

export function evmExplorerUrl(env: ApiEnv, net: EvmNet): string {
  return net === 'BASE' ? env.baseExplorerUrl : env.rhExplorerUrl;
}

export function evmRpc(rpcs: ChainRpcs, net: EvmNet): EvmRpc {
  return rpcs[net] as EvmRpc;
}
