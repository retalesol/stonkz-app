import { describe, expect, it } from 'vitest';
import {
  DEV_CRATE_SECRET,
  DEV_JWT_SECRET,
  publicProviderInUse,
  readEnv,
  ZERO_EVM_ADDRESS,
} from './env.js';
import { RH_PUBLIC_RPC_URL } from './chain/evm.js';

const secrets = {
  JWT_SECRET: 'production-jwt-secret-at-least-32-chars!!',
  CRATE_HMAC_SECRET: 'production-crate-secret-not-the-dev-one',
};

describe('readEnv production gates', () => {
  it('refuses the dev secrets', () => {
    expect(() => readEnv({ NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET })).toThrow(
      /JWT_SECRET/,
    );
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

describe('readEnv mainnet defaults follow the chain id', () => {
  it('pairs Base 8453 with the mainnet RPC/explorer and 84532 with Sepolia', () => {
    const main = readEnv({ NODE_ENV: 'test', BASE_CHAIN_ID: '8453' });
    expect(main.baseRpcUrl).toBe('https://mainnet.base.org');
    expect(main.baseExplorerUrl).toBe('https://basescan.org');
    expect(main.baseV3FactoryAddress).toBe('0x33128a8fC17869897dcE68Ed026d694621f6FDfD');
    expect(main.baseV3QuoterAddress).toBe('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
    const dev = readEnv({ NODE_ENV: 'test' });
    expect(dev.baseRpcUrl).toBe('https://sepolia.base.org');
    expect(dev.baseExplorerUrl).toBe('https://sepolia.basescan.org');
    expect(dev.baseV3QuoterAddress).toBe('0xC5290058841028F1614F3A6F0F5816cAd0df5E27');
    expect(readEnv({ NODE_ENV: 'test', RH_CHAIN_ID: '4663' }).rhV3QuoterAddress).toBe(
      '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
    );
    expect(readEnv({ NODE_ENV: 'test', RH_CHAIN_ID: '46630' }).rhV3QuoterAddress).toBe(
      ZERO_EVM_ADDRESS,
    );
  });

  it('defaults the RH referral asset to the WETH9 of the configured chain', () => {
    expect(readEnv({ NODE_ENV: 'test', RH_CHAIN_ID: '4663' }).referralAsset.RH?.address).toBe(
      '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    );
    expect(readEnv({ NODE_ENV: 'test' }).referralAsset.RH?.address).toBe(
      '0x7943e237c7F95DA44E0301572D358911207852Fa',
    );
  });
});

describe('readEnv chain defaults', () => {
  it('defaults every EVM factory to a well-formed address on testnet and mainnet ids', () => {
    for (const BASE_CHAIN_ID of ['84532', '8453']) {
      const env = readEnv({ NODE_ENV: 'test', BASE_CHAIN_ID });
      expect(env.baseV3FactoryAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    for (const RH_CHAIN_ID of ['46630', '4663']) {
      const env = readEnv({ NODE_ENV: 'test', RH_CHAIN_ID });
      expect(env.rhV3FactoryAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe('readEnv production provider gates', () => {
  const paid = {
    NODE_ENV: 'production',
    ...secrets,
    RH_RPC_URL: 'https://rh.example-provider.invalid/v1/key',
    RH_LAUNCHPAD_ADDRESS: '0x00000000000000000000000000000000000000bb',
    RH_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
    BASE_RPC_URL: 'https://base.example-provider.invalid/v1/key',
    SOLANA_RPC_URL: 'https://sol.example-provider.invalid/?api-key=x',
    JUPITER_API_BASE_URL: 'https://api.jup.ag/swap/v1',
    JUPITER_API_KEY: 'jup-key',
  };

  it('boots with paid providers everywhere', () => {
    const env = readEnv(paid);
    expect(env.stonkzStaging).toBe(false);
    expect(env.allowStaticPrices).toBe(false);
    expect(env.alertWebhookUrl).toBeUndefined();
    expect(env.alertWebhookMinSeverity).toBe('warn');
  });

  it.each([
    ['BASE_RPC_URL', { BASE_RPC_URL: 'https://sepolia.base.org' }, /BASE_RPC_URL/],
    ['BASE_RPC_URL (mainnet)', { BASE_RPC_URL: 'https://mainnet.base.org/' }, /BASE_RPC_URL/],
    ['SOLANA_RPC_URL', { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }, /SOLANA_RPC_URL/],
    [
      'SOLANA_RPC_URL (devnet)',
      { SOLANA_RPC_URL: 'https://api.devnet.solana.com' },
      /SOLANA_RPC_URL/,
    ],
    [
      'SOLANA_PRIVATE_RPC_URL',
      { SOLANA_PRIVATE_RPC_URL: 'https://api.mainnet-beta.solana.com' },
      /SOLANA_PRIVATE_RPC_URL/,
    ],
    [
      'JUPITER lite-api without a key',
      { JUPITER_API_BASE_URL: 'https://lite-api.jup.ag/swap/v1', JUPITER_API_KEY: '' },
      /JUPITER_API_KEY/,
    ],
  ])('refuses the public %s, naming the var', (_, over, pattern) => {
    expect(() => readEnv({ ...paid, ...over })).toThrow(pattern);
  });

  it('accepts the QuickNode provider endpoints (testnet and mainnet hosts) in production', () => {
    // Shape of the project's endpoints: `<name>.<network>.quiknode.pro/<key>/`.
    // The guard is a deny-list of public hosts, so these must all pass, with
    // and without SOLANA_PRIVATE_RPC_URL set.
    const quiknode = {
      ...paid,
      RH_RPC_URL: 'https://icy-example.robinhood-testnet.quiknode.pro/0123abcd/',
      BASE_RPC_URL: 'https://bold-example.base-sepolia.quiknode.pro/0123abcd/',
      SOLANA_RPC_URL: 'https://practical-example.solana-devnet.quiknode.pro/0123abcd/',
    };
    expect(() => readEnv(quiknode)).not.toThrow();
    expect(readEnv(quiknode).solanaPrivateRpcUrl).toBeUndefined();
    expect(() =>
      readEnv({
        ...quiknode,
        RH_CHAIN_ID: '4663',
        BASE_CHAIN_ID: '8453',
        RH_RPC_URL: 'https://thrumming-example.robinhood-mainnet.quiknode.pro/0123abcd/',
        BASE_RPC_URL: 'https://muddy-example.base-mainnet.quiknode.pro/0123abcd/',
        SOLANA_RPC_URL: 'https://withered-example.solana-mainnet.quiknode.pro/0123abcd/',
        SOLANA_PRIVATE_RPC_URL: 'https://withered-example.solana-mainnet.quiknode.pro/0123abcd/',
      }),
    ).not.toThrow();
  });

  it('refuses the defaults (public Base + Solana RPCs, Jupiter lite-api) in production', () => {
    const { BASE_RPC_URL: _b, SOLANA_RPC_URL: _s, JUPITER_API_BASE_URL: _j, ...rest } = paid;
    expect(() => readEnv(rest)).toThrow(/BASE_RPC_URL/);
  });

  it('accepts lite-api with a key, and everything public on STONKZ_STAGING=1', () => {
    expect(() =>
      readEnv({ ...paid, JUPITER_API_BASE_URL: 'https://lite-api.jup.ag/swap/v1' }),
    ).not.toThrow();
    const env = readEnv({
      NODE_ENV: 'production',
      STONKZ_STAGING: '1',
      ...secrets,
      RH_ROUTER_ADDRESS: '0x00000000000000000000000000000000000000aa',
      BASE_RPC_URL: 'https://sepolia.base.org',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    });
    expect(env.stonkzStaging).toBe(true);
  });

  it('reads the static-price escape hatch and the alert webhook knobs', () => {
    const env = readEnv({
      ...paid,
      ALLOW_STATIC_PRICES: '1',
      ALERT_WEBHOOK_URL: ' https://hooks.example/abc ',
      ALERT_WEBHOOK_MIN_SEVERITY: 'critical',
    });
    expect(env.allowStaticPrices).toBe(true);
    expect(env.alertWebhookUrl).toBe('https://hooks.example/abc');
    expect(env.alertWebhookMinSeverity).toBe('critical');
    expect(() => readEnv({ ...paid, ALERT_WEBHOOK_MIN_SEVERITY: 'page' })).toThrow(
      /ALERT_WEBHOOK_MIN_SEVERITY/,
    );
  });

  it('publicProviderInUse is null for private endpoints and tolerant of unparsable URLs', () => {
    expect(
      publicProviderInUse({
        baseRpcUrl: 'not a url',
        solanaRpcUrl: 'https://sol.example-provider.invalid',
        solanaPrivateRpcUrl: undefined,
        jupiterApiBaseUrl: 'https://api.jup.ag/swap/v1',
        jupiterApiKey: undefined,
      }),
    ).toBeNull();
  });
});
