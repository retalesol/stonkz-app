import { describe, expect, it } from 'vitest';
import { readEnv } from '@stonkz/api/env';
import { LEGACY_ROUTERS, readIndexerConfig, routerAddressList } from './config.js';

const NEW_RH_ROUTER = '0x00000000000000000000000000000000000A70e1';
const RH_LEGACY = [
  '0xc98f8214999220ce06e04ca8739a34cb8af5779c',
  '0x985877acdf01a21527e093bc4fce513eb180c775',
  '0x3aaeea60419e90fee3d9629eb36faff8179984ae',
  '0x1d44a1868d84900953b02ff8d653bb42e3a26db7',
];
const BASE_LEGACY = [
  '0x05b245fbdf5acbffc3ceefffb1648e1dcbf5413d',
  '0xa947241914e934e6a77480a49a7ea09c2d09ca9c',
];

const base = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  CRATE_HMAC_SECRET: 'test-crate-secret-at-least-32-chars-long',
};
const fixtures = { INDEXER_SOURCE: 'fixtures', INDEXER_ALLOW_FIXTURES: '1' };

describe('router address lists (atomic-launch router + its predecessor)', () => {
  it('defaults to the current router plus the testnet predecessors', () => {
    const env = readEnv({ ...base, RH_ROUTER_ADDRESS: NEW_RH_ROUTER });
    const config = readIndexerConfig(env, fixtures);
    expect(config.rhRouterAddresses).toEqual([NEW_RH_ROUTER.toLowerCase(), ...RH_LEGACY]);
    // No BASE_ROUTER_ADDRESS: the zero default is dropped, the predecessor kept.
    expect(config.baseRouterAddresses).toEqual(BASE_LEGACY);
    expect(config.arcRouterAddresses).toEqual([]);
  });

  it('dedupes when the current router still is the predecessor', () => {
    const env = readEnv({ ...base, RH_ROUTER_ADDRESS: LEGACY_ROUTERS[46630]![0]! });
    expect(readIndexerConfig(env, fixtures).rhRouterAddresses).toEqual(RH_LEGACY);
  });

  it('never trusts testnet addresses on mainnet', () => {
    const env = readEnv({ ...base, RH_CHAIN_ID: '4663', BASE_CHAIN_ID: '8453' });
    const config = readIndexerConfig(env, fixtures);
    expect(config.rhRouterAddresses).toEqual([]);
    expect(config.baseRouterAddresses).toEqual([]);
  });

  it('takes an explicit <NET>_ROUTER_ADDRESSES list, always with the current router', () => {
    const env = readEnv({ ...base, RH_ROUTER_ADDRESS: NEW_RH_ROUTER });
    const config = readIndexerConfig(env, {
      ...fixtures,
      RH_ROUTER_ADDRESSES: ` 0x000000000000000000000000000000000000beef , ${NEW_RH_ROUTER}`,
    });
    expect(config.rhRouterAddresses).toEqual([
      NEW_RH_ROUTER.toLowerCase(),
      '0x000000000000000000000000000000000000beef',
    ]);
  });

  it('refuses a malformed list entry instead of silently dropping a router', () => {
    expect(() => routerAddressList({ X: '0x1234' }, 'X', '', 46630)).toThrow(/X/);
  });
});
