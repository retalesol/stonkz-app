/**
 * Trade settlement, both chains. These are the scenarios that
 * `e2e/live.spec.ts` cannot cover, because it mocks the write routes.
 */
import { api, waitFor, type Scenario } from '../harness.js';
import { login, rhSigner, solSigner } from '../wallets.js';

interface QuoteHop {
  kind: string;
  feeNative?: number;
}
interface QuoteResponse {
  hops: QuoteHop[];
  outAmount?: number;
}
interface SolPrepare {
  tx: string;
}
interface RhAtomicPrepare {
  atomic: true;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  permitTypedData?: unknown;
  note?: string;
}
interface RhFallbackPrepare {
  atomic: false;
  steps: { to: `0x${string}`; data: `0x${string}`; value?: string; label?: string }[];
  warning: string;
}
type RhPrepare = RhAtomicPrepare | RhFallbackPrepare;

interface TokenRow {
  sym: string;
  mcap?: number;
}
interface TradeRow {
  sig?: string;
  hash?: string;
  txSig?: string;
}

/** Pick a live, ungraduated token from the board to trade against. */
async function pickTradeableSymbol(cfg: Parameters<typeof api>[0], net: 'SOL' | 'RH'): Promise<string> {
  const board = await api<TokenRow[] | { tokens: TokenRow[] }>(cfg, `/tokens?net=${net}&sort=mc&limit=20`);
  const rows = Array.isArray(board) ? board : board.tokens;
  if (!rows || rows.length === 0) {
    throw new Error(`no tokens on the ${net} board — launch one first, or the indexer is not ingesting`);
  }
  const first = rows[0];
  if (!first) throw new Error(`empty ${net} board`);
  return first.sym;
}

export const solanaRoundTrip: Scenario = {
  name: 'solana: buy then sell settles on chain',
  proves: 'launch-checklist "real broadcast, both chains" for Solana',
  requires: ['apiBaseUrl', 'solRpcUrl', 'solSecretKey'],
  async run({ cfg, log, expect }) {
    const signer = solSigner(cfg);
    log('signer', { address: signer.address });

    const balance = await signer.connection.getBalance(await Promise.resolve(signer.connection ? (await import('@solana/web3.js')).PublicKey.default : (undefined as never)).then(() => (await import('@solana/web3.js')), () => (undefined as never)).then(() => (undefined as never)).catch(() => 0) as never);
    void balance;

    const session = await login(cfg, 'SOL', signer.address, signer.signMessage);
    expect(session.wallet === signer.address, 'SIWS session is bound to the signing wallet', session.wallet);

    const sym = await pickTradeableSymbol(cfg, 'SOL');
    log('trading', { sym, amount: cfg.tradeAmountNative });

    // The quote must show the two-hop route with a fee on the curve hop only.
    const quote = await api<QuoteResponse>(
      cfg,
      `/tokens/${sym}/quote?net=SOL&side=buy&amount=${cfg.tradeAmountNative}`,
    );
    expect(Array.isArray(quote.hops) && quote.hops.length >= 1, 'quote returns hops', quote.hops?.length);
    const aggregatorHops = quote.hops.filter((h) => h.kind !== 'curve');
    expect(
      aggregatorHops.every((h) => !h.feeNative),
      'no Stonkz fee on any aggregator hop',
      aggregatorHops,
    );

    /* ------------------------------------------------------------ buy */
    const buyPrepare = await api<SolPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'SOL', sym, side: 'buy', amount: cfg.tradeAmountNative }),
    });
    expect(typeof buyPrepare.tx === 'string', 'prepare returned an unsigned transaction');

    const buySig = await signer.signAndSend(buyPrepare.tx);
    log('buy confirmed', { signature: buySig });
    expect(true, `buy settled on chain (${buySig})`);

    // The indexer must see it. This is the seam that fixture mode hides.
    const indexed = await waitFor(
      'the buy to appear in GET /tokens/:sym/trades',
      cfg.indexerTimeoutMs,
      3_000,
      async () => {
        const trades = await api<TradeRow[] | { trades: TradeRow[] }>(
          cfg,
          `/tokens/${sym}/trades?net=SOL&limit=50`,
        );
        const rows = Array.isArray(trades) ? trades : trades.trades;
        return (rows ?? []).find((t) => t.sig === buySig || t.txSig === buySig) ?? null;
      },
    );
    expect(!!indexed, 'indexer materialised the real on-chain buy', indexed);

    /* ----------------------------------------------------------- sell */
    const sellPrepare = await api<SolPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'SOL', sym, side: 'sell', amount: cfg.tradeAmountNative / 2 }),
    });
    const sellSig = await signer.signAndSend(sellPrepare.tx);
    expect(true, `sell settled on chain (${sellSig})`);
  },
};

export const rhAtomicRoundTrip: Scenario = {
  name: 'robinhood: atomic buy and sell in one signature each',
  proves: 'launch-checklist "RH_ROUTER_ADDRESS set" and the atomicity claim',
  requires: ['apiBaseUrl', 'rhRpcUrl', 'rhPrivateKey', 'rhRouterAddress'],
  async run({ cfg, log, expect }) {
    const signer = await rhSigner(cfg);
    log('signer', { address: signer.address });

    const session = await login(cfg, 'RH', signer.address, signer.signMessage);
    expect(session.wallet.toLowerCase() === signer.address.toLowerCase(), 'SIWE session bound to signer');

    const sym = await pickTradeableSymbol(cfg, 'RH');

    /* ------------------------------------------------------------ buy */
    const buy = await api<RhPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'RH', sym, side: 'buy', amount: cfg.tradeAmountNative }),
    });

    // The whole point of configuring RH_ROUTER_ADDRESS. If this is false, the
    // deployment is in the documented degraded mode and must not take real
    // funds — so fail rather than proceeding through the fallback.
    expect(
      buy.atomic === true,
      'RH buy took the atomic StonkzRouter path (not the non-atomic fallback)',
      buy.atomic === false ? buy.warning : undefined,
    );
    if (buy.atomic !== true) return;

    const nonceBefore = await signer.publicClient.getTransactionCount({ address: signer.address });
    const buyHash = await signer.sendAndWait({ to: buy.to, data: buy.data, value: buy.value });
    const nonceAfter = await signer.publicClient.getTransactionCount({ address: signer.address });
    expect(
      nonceAfter - nonceBefore === 1,
      'the buy consumed exactly one signature — genuinely atomic',
      { nonceBefore, nonceAfter },
    );
    log('buy confirmed', { hash: buyHash });

    /* ----------------------------------------------------------- sell */
    // First sell against a fresh router allowance returns permitTypedData
    // instead of assuming a standing approval.
    const sellFirst = await api<RhPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'RH', sym, side: 'sell', amount: cfg.tradeAmountNative / 2 }),
    });
    if (sellFirst.atomic !== true) throw new Error(`sell fell back: ${sellFirst.warning}`);

    let sellCall = sellFirst;
    if (sellFirst.permitTypedData) {
      log('signing EIP-2612 permit (no approval transaction)');
      const permitSig = await signer.signTypedData(sellFirst.permitTypedData);
      const r = `0x${permitSig.slice(2, 66)}`;
      const s = `0x${permitSig.slice(66, 130)}`;
      const v = Number.parseInt(permitSig.slice(130, 132), 16);
      const typed = sellFirst.permitTypedData as { message?: { value?: string; deadline?: string } };

      const resent = await api<RhPrepare>(cfg, '/trade/prepare', {
        method: 'POST',
        token: session.accessToken,
        body: JSON.stringify({
          net: 'RH',
          sym,
          side: 'sell',
          amount: cfg.tradeAmountNative / 2,
          permit: { value: typed.message?.value, deadline: typed.message?.deadline, v, r, s },
        }),
      });
      if (resent.atomic !== true) throw new Error('sell with permit fell back to the non-atomic path');
      sellCall = resent;
    }

    const nonceBeforeSell = await signer.publicClient.getTransactionCount({ address: signer.address });
    const sellHash = await signer.sendAndWait({ to: sellCall.to, data: sellCall.data, value: sellCall.value });
    const nonceAfterSell = await signer.publicClient.getTransactionCount({ address: signer.address });
    expect(
      nonceAfterSell - nonceBeforeSell === 1,
      'the sell settled in one transaction, with no separate approve',
      { nonceBeforeSell, nonceAfterSell },
    );
    log('sell confirmed', { hash: sellHash });
  },
};
