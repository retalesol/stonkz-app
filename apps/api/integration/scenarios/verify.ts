/**
 * The claims that are only meaningful when checked against a real chain:
 * the LP burn, the oracle staleness guard, smart-account login, and
 * server-side tip verification after an actual transfer.
 */
import { PublicKey } from '@solana/web3.js';
import { api, waitFor, type Scenario } from '../harness.js';
import { login, rhSigner, solSigner } from '../wallets.js';

export const solanaGraduationBurn: Scenario = {
  name: 'solana: graduated LP mint supply is zero',
  proves: 'launch-checklist "liquidity is burned forever", Solana side (finding H1)',
  requires: ['apiBaseUrl', 'solRpcUrl', 'solLaunchpadProgramId'],
  async run({ cfg, log, expect }) {
    // Read-only: find a token the indexer has already recorded as graduated,
    // rather than spending the ~$13.8k of testnet base it takes to graduate
    // one here. `INTEGRATION_RUN_GRADUATION=1` plus a funded wallet is the
    // path for forcing one, and that belongs in a dedicated run.
    interface Row {
      sym: string;
      graduatedAt?: number | string | null;
      lpMint?: string | null;
      poolAddress?: string | null;
    }
    const board = await api<Row[] | { tokens: Row[] }>(cfg, '/tokens?net=SOL&lane=grad&limit=25');
    const rows = Array.isArray(board) ? board : board.tokens;
    const graduated = (rows ?? []).filter((r) => r.graduatedAt);

    if (graduated.length === 0) {
      throw new Error(
        'no graduated SOL token on the board yet — this check cannot be satisfied by reasoning, ' +
          'only by a real graduation. Run one on testnet, then re-run.',
      );
    }

    const signer = solSigner(cfg);
    let checked = 0;

    for (const row of graduated) {
      if (!row.lpMint) {
        log('skipping (no lpMint recorded)', { sym: row.sym });
        continue;
      }
      const supply = await signer.connection.getTokenSupply(new PublicKey(row.lpMint));
      log('lp supply', { sym: row.sym, lpMint: row.lpMint, amount: supply.value.amount });
      expect(
        supply.value.amount === '0',
        `${row.sym}: 100% of the LP is burned (mint supply is exactly 0)`,
        supply.value.amount,
      );
      checked += 1;
    }

    expect(checked > 0, 'at least one graduated token had an LP mint to verify', { checked });
  },
};

export const rhGraduationBurn: Scenario = {
  name: 'robinhood: graduated LP sits at the dead address',
  proves: 'launch-checklist "liquidity is burned forever", RH side',
  requires: ['apiBaseUrl', 'rhRpcUrl'],
  async run({ cfg, log, expect }) {
    const DEAD = '0x000000000000000000000000000000000000dEaD' as const;
    interface Row {
      sym: string;
      graduatedAt?: number | string | null;
      poolAddress?: string | null;
    }
    const board = await api<Row[] | { tokens: Row[] }>(cfg, '/tokens?net=RH&lane=grad&limit=25');
    const rows = Array.isArray(board) ? board : board.tokens;
    const graduated = (rows ?? []).filter((r) => r.graduatedAt && r.poolAddress);

    if (graduated.length === 0) {
      throw new Error('no graduated RH token with a pool address on the board yet — graduate one on testnet first');
    }

    const signer = await rhSigner(cfg);
    const erc20 = [
      {
        type: 'function',
        name: 'totalSupply',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
      },
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ type: 'uint256' }],
      },
    ] as const;

    for (const row of graduated) {
      const pool = row.poolAddress as `0x${string}`;
      const [total, dead] = await Promise.all([
        signer.publicClient.readContract({ address: pool, abi: erc20, functionName: 'totalSupply' }),
        signer.publicClient.readContract({ address: pool, abi: erc20, functionName: 'balanceOf', args: [DEAD] }),
      ]);
      log('lp accounting', { sym: row.sym, pool, total: total.toString(), dead: dead.toString() });

      // v2 mints MINIMUM_LIQUIDITY to address(0) on the first deposit, so the
      // dead address holds everything the migrator ever received rather than
      // exactly totalSupply. Assert it holds effectively all of it.
      const pct = total === 0n ? 0 : Number((dead * 10_000n) / total) / 100;
      expect(pct > 99.9, `${row.sym}: essentially all LP is at the dead address`, { pct });
    }
  },
};

export const rhOracleStalenessGuard: Scenario = {
  name: 'robinhood: oracle staleness bound is heartbeat-scale',
  proves: 'launch-checklist "maxOracleStaleness is heartbeat-scale, not minute-scale"',
  requires: ['rhRpcUrl', 'rhLaunchpadAddress'],
  async run({ cfg, log, expect }) {
    const signer = await rhSigner(cfg);
    const abi = [
      {
        type: 'function',
        name: 'maxOracleStaleness',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint64' }],
      },
    ] as const;

    const staleness = await signer.publicClient.readContract({
      address: cfg.rhLaunchpadAddress as `0x${string}`,
      abi,
      functionName: 'maxOracleStaleness',
    });
    log('maxOracleStaleness', { seconds: staleness.toString() });

    // Chainlink on 4663 has an 86400s heartbeat. A bound below it makes
    // oracle graduation permanently unreachable — a bug this build already
    // hit once, which is why it is asserted against a live deployment and not
    // only in a unit test.
    expect(
      staleness >= 86_400n,
      'staleness bound is at least the 24h Chainlink heartbeat',
      staleness.toString(),
    );
    // And not absurdly wide, which would price graduations off a dead feed.
    expect(staleness <= 172_800n, 'staleness bound is not wider than 48h', staleness.toString());

    // The feed itself must be answering within that window.
    const feedAbi = [
      {
        type: 'function',
        name: 'latestRoundData',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          { name: 'roundId', type: 'uint80' },
          { name: 'answer', type: 'int256' },
          { name: 'startedAt', type: 'uint256' },
          { name: 'updatedAt', type: 'uint256' },
          { name: 'answeredInRound', type: 'uint80' },
        ],
      },
    ] as const;
    const ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' as const;
    try {
      const round = await signer.publicClient.readContract({
        address: ETH_USD,
        abi: feedAbi,
        functionName: 'latestRoundData',
      });
      const updatedAt = Number(round[3]) * 1000;
      const ageSecs = Math.round((Date.now() - updatedAt) / 1000);
      log('ETH/USD feed', { answer: round[1].toString(), ageSecs });
      expect(ageSecs < Number(staleness), 'the live ETH/USD feed is inside the configured window', { ageSecs });
    } catch (err) {
      // A testnet may not carry the mainnet feed; say so rather than failing
      // the deployment check on an unrelated absence.
      log('could not read the mainnet ETH/USD feed (expected on a testnet)', { error: String(err) });
    }
  },
};

export const smartAccountLogin: Scenario = {
  name: 'robinhood: ERC-1271 smart account can sign in',
  proves: 'launch-checklist smart-account support (RH is ERC-4337-heavy)',
  requires: ['apiBaseUrl', 'rhRpcUrl', 'rhPrivateKey', 'rhSmartAccountAddress'],
  async run({ cfg, log, expect }) {
    const owner = await rhSigner(cfg);
    const smartAccount = cfg.rhSmartAccountAddress as string;
    log('smart account', { smartAccount, owner: owner.address });

    // The owner key signs, but the *claimed* address is the contract. A plain
    // ecrecover check rejects this; only the ERC-1271 fallback admits it.
    const session = await login(cfg, 'RH', smartAccount, owner.signMessage);
    expect(
      session.wallet.toLowerCase() === smartAccount.toLowerCase(),
      'session is bound to the smart account, not the owner EOA',
      session.wallet,
    );
    expect(
      session.wallet.toLowerCase() !== owner.address.toLowerCase(),
      'the owner EOA did not get silently substituted for the account',
    );
  },
};

export const tipVerification: Scenario = {
  name: 'solana: a wall tip is verified against the real transfer',
  proves: 'the server never trusts a client-claimed tip amount',
  requires: ['apiBaseUrl', 'solRpcUrl', 'solSecretKey', 'solSecretKeyB'],
  async run({ cfg, log, expect }) {
    const sender = solSigner(cfg, 'primary');
    const recipient = solSigner(cfg, 'secondary');
    const session = await login(cfg, 'SOL', sender.address, sender.signMessage);

    const TIP = 0.002; // above the 0.001 SOL minimum
    const signature = await sender.transferTo(recipient.address, TIP);
    log('tip transferred', { signature, amount: TIP });

    // The signature needs to be visible to the RPC the API queries, which is
    // not necessarily the same node this harness used.
    await waitFor('the API to see the transfer', 60_000, 3_000, async () => {
      const res = await api<{ ok?: boolean }>(cfg, `/wall/SOL/${recipient.address}`, {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({ body: 'integration harness tip', tipSig: signature }),
      }).catch(() => null);
      return res;
    });

    interface WallPost {
      tipNative?: number;
      body?: string;
    }
    const wall = await api<WallPost[] | { posts: WallPost[] }>(cfg, `/wall/SOL/${recipient.address}?limit=10`);
    const posts = Array.isArray(wall) ? wall : wall.posts;
    const post = (posts ?? []).find((p) => p.body === 'integration harness tip');
    expect(!!post, 'the tipped post landed on the wall', post);
    expect(
      Math.abs((post?.tipNative ?? 0) - TIP) < 1e-9,
      'the recorded tip equals the on-chain amount, not a client claim',
      post?.tipNative,
    );

    /* --------- and the negative case: a lie must be refused --------- */
    let refused = false;
    try {
      await api(cfg, `/wall/SOL/${recipient.address}`, {
        method: 'POST',
        token: session.accessToken,
        // Reusing a spent signature: already consumed, so this must fail even
        // though the transfer it names really happened.
        body: JSON.stringify({ body: 'replayed tip', tipSig: signature }),
      });
    } catch {
      refused = true;
    }
    expect(refused, 'the same tip signature cannot be posted twice');
  },
};
