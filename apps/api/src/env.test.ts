import { describe, expect, it } from 'vitest';
import { DEV_CRATE_SECRET, DEV_JWT_SECRET, readEnv, ZERO_EVM_ADDRESS } from './env.js';
import { RH_PUBLIC_RPC_URL } from './chain/evm.js';

const secrets = {
  JWT_SECRET: 'production-jwt-secret-at-least-32-chars!!',
  CRATE_HMAC_SECRET: 'production-crate-secret-not-the-dev-one',
};

describe('readEnv production gates', () => {
  it('refuses the dev secrets', () => {
    expect(() => readEnv({ NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET })).toThrow(/JWT_SECRET/);
    expect(() =>
      readEnv({ NODE_ENV: 'production', ...secrets, CRATE_HMAC_SECRET: DEV_CRATE_SECRET }),
    ).toThrow(/CRATE_HMAC_SECRET/);
  });

  it('requires RH_ROUTER_ADDRESS in production (including STONKZ_STAGING)', () => {
    expect(() =>
      readEnv({
        NODE_ENV: 'production',
        STONKZ_STAGING: '1',
        ...secrets,
        RH_RPC_URL: RH_PUBLIC_RPC_URL,
        RH_LAUNCHPAD_ADDRESS: ZERO_EVM_ADDRESS,
      }),
    ).toThrow(/RH_ROUTER_ADDRESS/);

    const env = readEnv({
      NODE_ENV: 'production',
      STONKZ_STAGING: '1',
      ...secrets,
      RH_RPC_URL: RH_PUBLIC_RPC_URL,
      RH_LAUNCHPAD_ADDRESS: ZERO_EVM_ADDRESS,
      RH_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
    });
    expect(env.rhLaunchpadAddress).toBe(ZERO_EVM_ADDRESS);
    expect(env.rhRouterAddress.toLowerCase()).toBe('0x00000000000000000000000000000000000000aa');
  });

  it('refuses a missing launchpad address unless STONKZ_STAGING=1', () => {
    expect(() =>
      readEnv({
        NODE_ENV: 'production',
        ...secrets,
        RH_RPC_URL: 'https://example.invalid/rh',
        RH_LAUNCHPAD_ADDRESS: ZERO_EVM_ADDRESS,
        RH_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
      }),
    ).toThrow(/RH_LAUNCHPAD_ADDRESS/);

    const env = readEnv({
      NODE_ENV: 'production',
      STONKZ_STAGING: '1',
      ...secrets,
      RH_RPC_URL: RH_PUBLIC_RPC_URL,
      RH_LAUNCHPAD_ADDRESS: ZERO_EVM_ADDRESS,
      RH_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
    });
    expect(env.rhLaunchpadAddress).toBe(ZERO_EVM_ADDRESS);
  });
});
