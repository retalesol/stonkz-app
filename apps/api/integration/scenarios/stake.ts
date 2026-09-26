/**
 * Stake / unstake / claim round-trips + creator fee / referral smoke.
 * Spends real testnet funds; FLEX lock (0 days) so unstake is immediate.
 */
import { api, waitFor, ScenarioSkip, type Scenario } from '../harness.js';
import { baseSigner, login, rhSigner, solSigner } from '../wallets.js';

interface TokenRow {
  sym: string;
  mint?: string;
  base?: string;
  baseSymbol?: string;
}
interface SolPrepare {
  transaction?: string;
  tx?: string;
  quote?: { amountOut?: number; outAmount?: number };
}
interface EvmPrepare {
  atomic?: boolean;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  quote?: { amountOut?: number };
  warning?: string;
  steps?: { to: `0x${string}`; data: `0x${string}`; value?: string; label?: string }[];
}
interface StakeView {
  amt: number;
  days: number;
  rewSol?: number;
  rewTok?: number;
}
interface FeesView {
  vaults: { sym: string; unclaimedNative: number; mint?: string }[];
}
interface ReferralView {
  code: string;
  pendingNative: number;
  lifetimeNative: number;
}

async function pickTradeable(
  cfg: Parameters<typeof api>[0],
  net: 'SOL' | 'RH' | 'BASE',
): Promise<TokenRow> {
  const board = await api<TokenRow[] | { tokens: TokenRow[] }>(
    cfg,
    `/tokens?net=${net}&sort=mc&limit=20`,
  );
  const rows = Array.isArray(board) ? board : board.tokens;
  if (!rows?.length) throw new ScenarioSkip(`no tokens on ${net} board`);
  const preferred = rows.find((r) => {
    const base = (r.baseSymbol ?? r.base)?.toUpperCase();
    return !base || base === 'ETH' || base === 'WETH' || base === 'SOL' || base === 'WSOL';
  });
  return preferred ?? rows[0]!;
}

async function buyNative(
  cfg: Parameters<typeof api>[0],
  opts: {
    net: 'SOL' | 'RH' | 'BASE';
    sym: string;
    amount: number;
    token: string;
    signSol?: (b64: string) => Promise<string>;
    signEvm?: (call: { to: `0x${string}`; data: `0x${string}`; value?: string }) => Promise<string>;
  },
): Promise<number> {
  const prep = await api<SolPrepare & EvmPrepare>(cfg, '/trade/prepare', {
    method: 'POST',
    token: opts.token,
    body: JSON.stringify({ net: opts.net, sym: opts.sym, side: 'buy', amount: opts.amount }),
  });
  if (opts.net === 'SOL') {
    const tx = prep.transaction ?? prep.tx;
    if (!tx || !opts.signSol) throw new Error('sol buy prepare missing tx');
    await opts.signSol(tx);
  } else {
    if (prep.atomic === false)
      throw new Error(`${opts.net} buy fell back to non-atomic: ${prep.warning}`);
    if (!opts.signEvm) throw new Error('evm signer missing');
    await opts.signEvm({
      to: prep.to,
      data: prep.data,
      ...(prep.value !== undefined ? { value: prep.value } : {}),
    });
  }
  return prep.quote?.amountOut ?? prep.quote?.outAmount ?? 0;
}

export const solanaStakeRoundTrip: Scenario = {
  name: 'solana: stake flex then unstake settles',
  proves: 'stake / unstake prepare→sign→broadcast; indexer stakePositions',
  requires: ['apiBaseUrl', 'solRpcUrl', 'solSecretKey'],
  async run({ cfg, log, expect }) {
    const signer = solSigner(cfg);
    const bal = await signer.balanceNative();
    log('balance', { sol: bal });
    expect(bal > 0.05, 'funded Solana wallet', bal);

    const session = await login(cfg, 'SOL', signer.address, signer.signMessage);
    const token = await pickTradeable(cfg, 'SOL');
    const sym = token.sym;
    log('token', { sym, mint: token.mint });

    const bought = await buyNative(cfg, {
      net: 'SOL',
      sym,
      amount: cfg.tradeAmountNative,
      token: session.accessToken,
      signSol: signer.signAndSend,
    });
    expect(bought > 0, 'buy returned tokens', bought);
    const stakeAmt = Math.max(bought * 0.25, 1);
    log('staking flex', { stakeAmt });

    const stakePrep = await api<SolPrepare>(cfg, '/stake/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'SOL', sym, amount: stakeAmt, days: 0 }),
    });
    const stakeTx = stakePrep.transaction ?? stakePrep.tx;
    expect(typeof stakeTx === 'string', 'stake prepare returned tx');
    const stakeSig = await signer.signAndSend(stakeTx!);
    log('stake settled', { stakeSig });

    const pos = await waitFor('indexer stake position', cfg.indexerTimeoutMs, 3_000, async () => {
      const row = await api<StakeView>(cfg, `/stake/${sym}`, { token: session.accessToken });
      return row.amt > 0 ? row : null;
    });
    expect(pos.amt > 0, 'stake position amount > 0', pos);

    const unstakeAmt = Math.min(pos.amt, stakeAmt);
    const unstakePrep = await api<SolPrepare>(cfg, '/stake/unstake/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'SOL', sym, amount: unstakeAmt }),
    });
    const unstakeTx = unstakePrep.transaction ?? unstakePrep.tx;
    expect(typeof unstakeTx === 'string', 'unstake prepare returned tx');
    const unstakeSig = await signer.signAndSend(unstakeTx!);
    expect(true, `unstake settled (${unstakeSig})`);

    // Only claim when the indexer shows accrued rewards — prepare still
    // returns a tx that reverts with NothingToClaim otherwise.
    const after = await api<StakeView>(cfg, `/stake/${sym}`, { token: session.accessToken });
    if ((after.rewSol ?? 0) > 0 || (after.rewTok ?? 0) > 0) {
      const claimPrep = await api<SolPrepare>(cfg, '/stake/claim/prepare', {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({ net: 'SOL', sym }),
      });
      const claimTx = claimPrep.transaction ?? claimPrep.tx;
      if (claimTx) {
        const claimSig = await signer.signAndSend(claimTx);
        log('claim settled', { claimSig });
      }
    } else {
      log('claim skipped — nothing accrued yet (expected for a fresh flex stake)');
    }
  },
};
function evmStakeScenario(net: 'RH' | 'BASE', name: string): Scenario {
  return {
    name,
    proves: `${net} stake flex → unstake on launchpad`,
    requires:
      net === 'RH'
        ? ['apiBaseUrl', 'rhRpcUrl', 'rhPrivateKey', 'rhLaunchpadAddress']
        : ['apiBaseUrl', 'baseRpcUrl', 'basePrivateKey', 'baseLaunchpadAddress'],
    async run({ cfg, log, expect }) {
      const signer = net === 'RH' ? await rhSigner(cfg) : await baseSigner(cfg);
      log('signer', { address: signer.address, net });
      const session = await login(cfg, net, signer.address, signer.signMessage);
      const token = await pickTradeable(cfg, net);
      const sym = token.sym;

      const bought = await buyNative(cfg, {
        net,
        sym,
        amount: cfg.tradeAmountNative,
        token: session.accessToken,
        signEvm: (call) => signer.sendAndWait(call),
      });
      expect(bought > 0, 'buy returned tokens', bought);
      const stakeAmt = Math.max(bought * 0.25, 1);
      log('staking flex', { stakeAmt, sym });

      const stakePrep = await api<EvmPrepare>(cfg, '/stake/prepare', {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({ net, sym, amount: stakeAmt, days: 0 }),
      });
      const stakeSteps =
        stakePrep.steps && stakePrep.steps.length > 0
          ? stakePrep.steps
          : [{ to: stakePrep.to, data: stakePrep.data, value: stakePrep.value, label: 'Stake' }];
      expect(stakeSteps.length >= 1, 'stake prepare returned call(s)');
      let stakeHash = '';
      for (const step of stakeSteps) {
        stakeHash = await signer.sendAndWait({
          to: step.to,
          data: step.data,
          ...(step.value !== undefined ? { value: step.value } : {}),
        });
        log('stake step settled', { label: step.label, stakeHash });
      }

      const pos = await waitFor('indexer stake position', cfg.indexerTimeoutMs, 3_000, async () => {
        const row = await api<StakeView>(cfg, `/stake/${sym}`, { token: session.accessToken });
        return row.amt > 0 ? row : null;
      });
      expect(pos.amt > 0, 'stake position amount > 0', pos);

      const unstakePrep = await api<EvmPrepare>(cfg, '/stake/unstake/prepare', {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({ net, sym, amount: Math.min(pos.amt, stakeAmt) }),
      });
      const unstakeHash = await signer.sendAndWait({
        to: unstakePrep.to,
        data: unstakePrep.data,
        value: unstakePrep.value,
      });
      expect(true, `unstake settled (${unstakeHash})`);
    },
  };
}

export const rhStakeRoundTrip = evmStakeScenario(
  'RH',
  'robinhood: stake flex then unstake settles',
);
export const baseStakeRoundTrip = evmStakeScenario('BASE', 'base: stake flex then unstake settles');

export const creatorFeesAndReferrals: Scenario = {
  name: 'live: creator fees list + referral claim path',
  proves: 'GET /fees and /referrals respond; claim when pending > 0',
  requires: ['apiBaseUrl', 'rhRpcUrl', 'rhPrivateKey'],
  async run({ cfg, log, expect }) {
    const signer = await rhSigner(cfg);
    const session = await login(cfg, 'RH', signer.address, signer.signMessage);

    const fees = await api<FeesView>(cfg, '/fees', { token: session.accessToken });
    expect(Array.isArray(fees.vaults), 'GET /fees returned vaults array');
    log('creator vaults', { n: fees.vaults.length, sample: fees.vaults.slice(0, 3) });

    // If this wallet created a token and has unclaimed fees, prepare+broadcast a claim.
    const claimable = fees.vaults.find((v) => v.unclaimedNative > 0);
    if (claimable) {
      const prep = await api<EvmPrepare>(cfg, '/fees/claim/prepare', {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({ net: 'RH', sym: claimable.sym }),
      });
      const hash = await signer.sendAndWait({ to: prep.to, data: prep.data, value: prep.value });
      expect(true, `creator fee claim settled (${hash})`);
    } else {
      log('no unclaimed creator fees for this wallet — list path verified only');
    }

    const refs = await api<ReferralView>(cfg, '/referrals', { token: session.accessToken });
    expect(typeof refs.code === 'string' && refs.code.length > 0, 'referral code issued', refs);
    log('referrals', {
      code: refs.code,
      pending: refs.pendingNative,
      lifetime: refs.lifetimeNative,
    });

    if (refs.pendingNative > 0) {
      const claimed = await api<{ optionz: number; optionzTotal: number }>(
        cfg,
        '/referrals/claim',
        {
          method: 'POST',
          token: session.accessToken,
          body: '{}',
        },
      );
      expect(claimed.optionz > 0, 'referral claim minted Optionz', claimed);
    } else {
      log('no pending referral fees — code + zero-pending path verified');
    }
  },
};
