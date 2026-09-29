import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TokenFees } from '@stonkz/shared';
import { splitFee } from '@stonkz/shared';
import { COINS_WORD } from '../chain/stake-reads.js';
import {
  creatorVaults,
  referralFeeEvents,
  stakePositions,
  tokens,
  trades,
  treasuryCredits,
} from '../db/schema.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { evmWallet } from '../test/wallets.js';
import { invalidateStakePool } from './stake-data.js';

/**
 * `GET /tokens/:sym/fees` — the Fees tab's ledger, on BASE against a fake
 * launchpad, seeded to look like MEMEMAN: one 0.02 ETH buy at 2%, a 0.0004
 * ETH fee split 15 / 10 / 6 / 69 on chain.
 */

const LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const MEMEMAN = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const E18 = 10n ** 18n;
const CREATOR = evmWallet('mememan-creator');
const STRANGER = evmWallet('mememan-stranger');

const FEE = 0.0004;
const LEGS = splitFee(FEE);
/** The chain's creator ledger after that fill: the whole 69% bucket (FLEX-only stake). */
const CLAIMABLE_WEI = 276_000_000_000_000n;

let h: TestApp;
let coinsCalls = 0;

function coinsWords(): string {
  const words = new Array<bigint>(38).fill(0n);
  words[0] = BigInt(MEMEMAN);
  words[COINS_WORD.creator] = BigInt(CREATOR.address);
  words[COINS_WORD.tokensForSale] = 800_000n * E18;
  words[COINS_WORD.realToken] = 787_705n * E18;
  words[COINS_WORD.creatorClaimableBase] = CLAIMABLE_WEI;
  words[COINS_WORD.creatorClaimableToken] = 0n;
  words[COINS_WORD.flexStaked] = 12_294n * E18;
  return '0x' + words.map((w) => w.toString(16).padStart(64, '0')).join('');
}

beforeAll(async () => {
  h = await createTestApp({ env: { BASE_LAUNCHPAD_ADDRESS: LAUNCHPAD } });
  h.rpcs.BASE.setContract(LAUNCHPAD, () => {
    coinsCalls++;
    return coinsWords();
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  coinsCalls = 0;
  invalidateStakePool(h.deps, 'BASE', MEMEMAN);
  const t0 = new Date(h.now() - 600_000);
  await h.deps.db.insert(tokens).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    name: 'Meme Man',
    creator: CREATOR.address,
    mint: MEMEMAN,
    baseSymbol: 'WETH',
    baseMint: WETH_BASE,
    supply: 1_000_000,
    feeBps: 200,
    seed: 7,
    tokenDecimals: 18,
    baseDecimals: 18,
    curveTokensForSale: (800_000n * E18).toString(),
    curveRealToken: (787_705n * E18).toString(),
    launchedAt: t0,
  });
  await h.deps.db.insert(trades).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    mint: MEMEMAN,
    trader: STRANGER.address,
    side: 'buy',
    nativeAmount: 0.02,
    baseAmount: 0.02,
    tokenAmount: 12_294,
    usdValue: 80,
    mc: 5000,
    price: 0.0000065,
    cashback: false,
    txSig: '0xfill1',
    logIndex: 4,
    blockTime: t0,
    chainPosition: 100,
  });
  // The indexer's view of that fill: the protocol leg net of a T1 referral
  // commission (15% of the fee, which is the whole 15% leg), buyback and RWA
  // in full, the bucket to the creator vault.
  const referral = FEE * 0.15;
  await h.deps.db.insert(treasuryCredits).values([
    {
      net: 'BASE',
      kind: 'protocol',
      sym: 'MEMEMAN',
      amount: LEGS.protocol - referral,
      txSig: '0xfill1',
      logIndex: 5,
      blockTime: t0,
      chainPosition: 100,
    },
    {
      net: 'BASE',
      kind: 'buyback',
      sym: 'MEMEMAN',
      amount: LEGS.buyback,
      txSig: '0xfill1',
      logIndex: 5,
      blockTime: t0,
      chainPosition: 100,
    },
    {
      net: 'BASE',
      kind: 'rwa',
      sym: 'MEMEMAN',
      amount: LEGS.rwa,
      txSig: '0xfill1',
      logIndex: 5,
      blockTime: t0,
      chainPosition: 100,
    },
  ]);
  await h.deps.db.insert(referralFeeEvents).values({
    net: 'BASE',
    earner: evmWallet('mememan-referrer').address,
    sourceTrader: STRANGER.address,
    tier: 1,
    txSig: '0xfill1',
    feeAmount: FEE,
    payoutNative: referral,
  });
  await h.deps.db.insert(creatorVaults).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    mint: MEMEMAN,
    creator: CREATOR.address,
    unclaimedNative: LEGS.creatorBucket,
    unclaimedTokens: 0,
    stakerPoolNative: 0,
    lifetimeNative: LEGS.creatorBucket,
  });
  // An old indexed FLEX position, so the pool summary is served from the
  // indexer and the only chain read left in this route is the creator's.
  await h.deps.db.insert(stakePositions).values({
    net: 'BASE',
    sym: 'MEMEMAN',
    mint: MEMEMAN,
    wallet: CREATOR.address,
    amount: 12_294,
    lockDays: 0,
    mult: 0,
    untilMs: h.now() - 600_000,
    updatedAt: new Date(h.now() - 600_000),
  });
});

async function fees(token?: string): Promise<TokenFees> {
  const res = await h.app.request(`/tokens/MEMEMAN/fees?net=BASE`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenFees;
}

describe('GET /tokens/:sym/fees', () => {
  it('reconciles gross to the on-chain fee: four legs plus the referral cut', async () => {
    const f = await fees();
    expect(f.totals.gross).toBeCloseTo(FEE, 12);
    expect(f.totals.protocol).toBeCloseTo(LEGS.protocol - FEE * 0.15, 12);
    expect(f.totals.referrals).toBeCloseTo(FEE * 0.15, 12);
    expect(f.totals.protocol + f.totals.referrals).toBeCloseTo(LEGS.protocol, 12);
    expect(f.totals.buyback).toBeCloseTo(LEGS.buyback, 12);
    expect(f.totals.rwa).toBeCloseTo(LEGS.rwa, 12);
    expect(f.totals.creatorBucket).toBeCloseTo(LEGS.creatorBucket, 12);
    expect(f.totals.creator).toBeCloseTo(LEGS.creatorBucket, 12);
    expect(f.totals.stakers).toBe(0);
    expect(f.totals.stakersTokens).toBe(0);
  });

  it('gives a stranger the indexer view of the creator ledger without an RPC read', async () => {
    const stranger = await h.login('BASE', STRANGER);
    const f = await fees(stranger.token);
    expect(f.creator).toMatchObject({ source: 'indexer', claimableTokens: 0, baseSym: 'WETH' });
    expect(f.creator?.wallet.toLowerCase()).toBe(CREATOR.address.toLowerCase());
    expect(f.creator?.claimableBase).toBeCloseTo(LEGS.creatorBucket, 12);
    expect(coinsCalls).toBe(0);
  });

  it('reads the creator ledger on chain for the creator, whatever the indexer row says', async () => {
    // The indexer trails: its row says nothing is claimable.
    await h.deps.db.update(creatorVaults).set({ unclaimedNative: 0 });
    const creator = await h.login('BASE', CREATOR);
    const f = await fees(creator.token);
    expect(f.creator?.source).toBe('chain');
    expect(f.creator?.wallet).toBe(CREATOR.address);
    // 276_000_000_000_000 wei, exactly.
    expect(f.creator?.claimableBase).toBe(0.000276);
    expect(coinsCalls).toBeGreaterThan(0);

    // And the claim prepare agrees with the chain, not the stale row.
    const prep = await h.app.request('/fees/claim/prepare', {
      method: 'POST',
      headers: { authorization: `Bearer ${creator.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sym: 'MEMEMAN', mint: MEMEMAN }),
    });
    expect(prep.status).toBe(200);
    const body = (await prep.json()) as {
      to: string;
      data: string;
      claimableBase: number;
      claimableSource: string;
    };
    expect(body.to).toBe(LAUNCHPAD);
    expect(body.data).toMatch(/^0x/);
    expect(body.claimableBase).toBe(0.000276);
    expect(body.claimableSource).toBe('chain');
  });
});
