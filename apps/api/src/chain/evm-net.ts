import type { EvmNet } from '@stonkz/shared';
import type { ApiEnv } from '../env.js';
import type { ChainRpcs } from './types.js';
import type { EvmRpc } from './evm.js';

/**
 * One place that maps an EVM net to its `ApiEnv` knobs, so adding a net is a
 * row here rather than a `net === 'BASE' ? … : …` ternary in every route.
 */
interface EvmNetEnv {
  chainId: number;
  launchpadAddress: string;
  routerAddress: string;
  v3FeeTierOverrides: Record<string, number>;
  v3FactoryAddress: string;
  v3QuoterAddress: string;
  explorerUrl: string;
}

function evmNetEnv(env: ApiEnv, net: EvmNet): EvmNetEnv {
  switch (net) {
    case 'BASE':
      return {
        chainId: env.baseChainId,
        launchpadAddress: env.baseLaunchpadAddress,
        routerAddress: env.baseRouterAddress,
        v3FeeTierOverrides: env.baseV3FeeTierOverrides,
        v3FactoryAddress: env.baseV3FactoryAddress,
        v3QuoterAddress: env.baseV3QuoterAddress,
        explorerUrl: env.baseExplorerUrl,
      };
    case 'ARC':
      return {
        chainId: env.arcChainId,
        launchpadAddress: env.arcLaunchpadAddress,
        routerAddress: env.arcRouterAddress,
        v3FeeTierOverrides: env.arcV3FeeTierOverrides,
        v3FactoryAddress: env.arcV3FactoryAddress,
        v3QuoterAddress: env.arcV3QuoterAddress,
        explorerUrl: env.arcExplorerUrl,
      };
    case 'RH':
      return {
        chainId: env.rhChainId,
        launchpadAddress: env.rhLaunchpadAddress,
        routerAddress: env.rhRouterAddress,
        v3FeeTierOverrides: env.rhV3FeeTierOverrides,
        v3FactoryAddress: env.rhV3FactoryAddress,
        v3QuoterAddress: env.rhV3QuoterAddress,
        explorerUrl: env.rhExplorerUrl,
      };
  }
}

export function evmChainId(env: ApiEnv, net: EvmNet): number {
  return evmNetEnv(env, net).chainId;
}

export function evmLaunchpadAddress(env: ApiEnv, net: EvmNet): string {
  return evmNetEnv(env, net).launchpadAddress;
}

export function evmRouterAddress(env: ApiEnv, net: EvmNet): string {
  return evmNetEnv(env, net).routerAddress;
}

export function evmV3FeeTierOverrides(env: ApiEnv, net: EvmNet): Record<string, number> {
  return evmNetEnv(env, net).v3FeeTierOverrides;
}

export function evmV3FactoryAddress(env: ApiEnv, net: EvmNet): string {
  return evmNetEnv(env, net).v3FactoryAddress;
}

/** The exact-input V3 quoter; the zero address when none is deployed. */
export function evmV3QuoterAddress(env: ApiEnv, net: EvmNet): string {
  return evmNetEnv(env, net).v3QuoterAddress;
}

export function evmExplorerUrl(env: ApiEnv, net: EvmNet): string {
  return evmNetEnv(env, net).explorerUrl;
}

export function evmRpc(rpcs: ChainRpcs, net: EvmNet): EvmRpc {
  return rpcs[net] as EvmRpc;
}
