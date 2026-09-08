import { nativeUnit, type Net } from '@stonkz/shared';
import type { Db } from '@stonkz/api/db/client';
import type { PriceOracle } from '@stonkz/api/chain/types';
import type { ApiEnv } from '@stonkz/api/env';
import type { Logger } from '@stonkz/api/observability/logger';
import { createBaseMintRegistry, parseBaseMintOverrides } from '@stonkz/api/router/base-mints';
import type { IndexerConfig } from '../config.js';
import type { EventSource } from '../source.js';
import { EvmChainSource } from './evm-source.js';
import { HttpEvmIndexRpc } from './evm-rpc.js';
import { TokenRegistry } from './registry.js';
import { HttpSolanaIndexRpc } from './solana-rpc.js';
import { SolanaChainSource } from './solana-source.js';

/**
 * Builds both chain sources from configuration.
 *
 * The registry is shared between them and returned, because it is the one
 * piece of state a reorg rollback invalidates: dropping a launch deletes the
 * `tokens` row its cache entry was read from, so the runner needs a handle to
 * forget that chain's entries.
 */
export interface ChainSourcesOptions {
  config: IndexerConfig;
  env: ApiEnv;
  db: Db;
  oracle: PriceOracle;
  logger: Logger;
}

export interface ChainSources {
  sources: Record<Net, EventSource>;
  registry: TokenRegistry;
}

export function buildChainSources(opts: ChainSourcesOptions): ChainSources {
  const { config, env, db, oracle, logger } = opts;

  const registry = new TokenRegistry(db);
  const baseMints = createBaseMintRegistry({
    SOL: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_SOL']),
    RH: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_RH']),
  });

  // The oracle is only consulted for fills whose base asset is not the
  // chain's wrapped native token; a wrapped-native fill's base leg *is* its
  // native leg and needs no price at all. Both sources treat a failure here as
  // "record 0 native", never as an invented figure.
  const nativeUsd = (net: Net) => () => oracle.nativeUsd(nativeUnit(net));

  const sources: Record<Net, EventSource> = {
    SOL: new SolanaChainSource({
      rpc: new HttpSolanaIndexRpc({ url: env.solanaRpcUrl }),
      programId: config.solanaProgramId,
      startSlot: config.solanaStartSlot,
      registry,
      baseMints,
      nativeUsd: nativeUsd('SOL'),
      logger,
      confirmations: config.confirmations.SOL,
      signaturePageSize: config.solanaSignaturePageSize,
      maxTxPerPass: config.solanaMaxTxPerPass,
      trackBlockhash: config.solanaTrackBlockhash,
    }),
    RH: new EvmChainSource({
      rpc: new HttpEvmIndexRpc({ url: env.rhRpcUrl }),
      launchpadAddress: config.rhLaunchpadAddress,
      routerAddress: config.rhRouterAddress,
      startBlock: config.rhStartBlock,
      registry,
      baseMints,
      nativeUsd: nativeUsd('RH'),
      logger,
      confirmations: config.confirmations.RH,
      logWindow: config.rhLogWindow,
    }),
  };

  return { sources, registry };
}
