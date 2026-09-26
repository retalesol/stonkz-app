/**
 * The claims that are only meaningful when checked against a real chain:
 * permanent DLMM position lock, the oracle staleness guard, smart-account
 * login, and server-side tip verification after an actual transfer.
 */
import { PublicKey } from '@solana/web3.js';
import { api, waitFor, ScenarioSkip, type Scenario } from '../harness.js';
import { login, rhSigner, solSigner } from '../wallets.js';

/** Solana incinerator — DLMM position operator / fee owner after migration. */
const METEORA_DEAD = '1nc1nerator11111111111111111111111111111111';
/** PositionV2.owner offset (8-byte disc + lb_pair pubkey). */
const POSITION_OWNER_OFFSET = 40;
/** PositionV2.operator offset. */
const POSITION_OPERATOR_OFFSET = 7960;
/** PositionV2.lock_release_point offset. */
const POSITION_LOCK_OFFSET = 7992;

export const solanaGraduationBurn: Scenario = {
  name: 'solana: graduated DLMM position is permanently locked',
  proves:
    'launch-checklist "liquidity is burned forever", Solana side (finding H1 → Meteora DLMM lock)',
  requires: ['apiBaseUrl', 'solRpcUrl', 'solLaunchpadProgramId'],
  async run({ cfg, log, expect }) {
    interface Row {
      sym: string;
      mint?: string;
      graduatedAt?: number | string | null;
      poolAddress?: string | null;
      positionAddress?: string | null;
    }
    const board = await api<Row[] | { tokens: Row[] }>(cfg, '/tokens?net=SOL&lane=grad&limit=25');
    const rows = Array.isArray(board) ? board : board.tokens;
    const graduated = (rows ?? []).filter((r) => r.graduatedAt);

    if (graduated.length === 0) {
      throw new ScenarioSkip('no graduated SOL token on the board yet');
    }

    const signer = solSigner(cfg);
    let checked = 0;

    for (const row of graduated) {
      if (!row.positionAddress) {
        log('skipping (no positionAddress recorded — migrate may not have run)', { sym: row.sym });
        continue;
      }
      const info = await signer.connection.getAccountInfo(new PublicKey(row.positionAddress));
      expect(!!info?.data, `${row.sym}: position account exists`, row.positionAddress);
      if (!info?.data) continue;

      const data = Buffer.from(info.data);
      const owner = new PublicKey(
        data.subarray(POSITION_OWNER_OFFSET, POSITION_OWNER_OFFSET + 32),
      ).toBase58();
      const operator = new PublicKey(
        data.subarray(POSITION_OPERATOR_OFFSET, POSITION_OPERATOR_OFFSET + 32),
      ).toBase58();
      const lockRelease = data.readBigUInt64LE(POSITION_LOCK_OFFSET);

      log('position lock', {
        sym: row.sym,
        position: row.positionAddress,
        pool: row.poolAddress,
        owner,
        operator,
        lockRelease: lockRelease.toString(),
      });

      expect(
        lockRelease === 0xffff_ffff_ffff_ffffn,
        `${row.sym}: lock_release_point is u64::MAX (permanent)`,
        lockRelease.toString(),
      );
      expect(
        operator === METEORA_DEAD || owner === METEORA_DEAD,
        `${row.sym}: position operator or owner is the dead address`,
        { owner, operator },
      );
      checked += 1;
    }

    expect(checked > 0, 'at least one graduated token had a locked DLMM position to verify', {
      checked,
    });
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
      throw new ScenarioSkip('no graduated RH token with a pool address on the board yet');
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
        inputs: [{ name: 'owner', type: 'address' }],
        stateMutability: 'view',
        outputs: [{ type: 'uint256' }],
      },
    ] as const;

    for (const row of graduated) {
      const pool = row.poolAddress as `0x${string}`;
      const [total, dead] = await Promise.all([
        signer.publicClient.readContract({
          address: pool,
          abi: erc20,
          functionName: 'totalSupply',
        }),
        signer.publicClient.readContract({
          address: pool,
          abi: erc20,
          functionName: 'balanceOf',
          args: [DEAD],
        }),
      ]);
      log('lp accounting', { sym: row.sym, pool, total: total.toString(), dead: dead.toString() });

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

    expect(
      staleness >= 86_400n,
      'staleness bound is at least the 24h Chainlink heartbeat',
      staleness.toString(),
    );
    expect(staleness <= 172_800n, 'staleness bound is not wider than 48h', staleness.toString());

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
      expect(ageSecs < Number(staleness), 'the live ETH/USD feed is inside the configured window', {
        ageSecs,
      });
    } catch (err) {
      log('could not read the mainnet ETH/USD feed (expected on a testnet)', {
        error: String(err),
      });
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

    const TIP = 0.002;
    const signature = await sender.transferTo(recipient.address, TIP);
    log('tip transferred', { signature, amount: TIP });

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
    const wall = await api<WallPost[] | { posts: WallPost[] }>(
      cfg,
      `/wall/SOL/${recipient.address}?limit=10`,
    );
    const posts = Array.isArray(wall) ? wall : wall.posts;
    const post = (posts ?? []).find((p) => p.body === 'integration harness tip');
    expect(!!post, 'the tipped post landed on the wall', post);
    expect(
      Math.abs((post?.tipNative ?? 0) - TIP) < 1e-9,
      'the recorded tip equals the on-chain amount, not a client claim',
      post?.tipNative,
    );

    let refused = false;
    try {
      await api(cfg, `/wall/SOL/${recipient.address}`, {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({ body: 'replayed tip', tipSig: signature }),
      });
    } catch {
      refused = true;
    }
    expect(refused, 'the same tip signature cannot be posted twice');
  },
};
