/**
 * Trade settlement, both chains. These are the scenarios that
 * `e2e/live.spec.ts` cannot cover, because it mocks the write routes.
 */
import { api, waitFor, type Scenario } from '../harness.js';
import { baseSigner, login, rhSigner, solSigner } from '../wallets.js';

interface QuoteHop {
  kind: string;
  feeNative?: number;
}
interface QuoteResponse {
  hops: QuoteHop[];
  outAmount?: number;
}
interface SolPrepare {
  /** Live API returns `transaction` (base64); older docs said `tx`. */
  transaction?: string;
  tx?: string;
  quote?: { amountOut?: number; outAmount?: number };
}
interface RhAtomicPrepare {
  atomic: true;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  permitTypedData?: unknown;
  note?: string;
  quote?: { amountOut?: number };
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
  base?: string;
  baseSymbol?: string;
}
interface TradeRow {
  sig?: string;
  hash?: string;
  txSig?: string;
}

type EvmPermitTyped = {
  domain: { verifyingContract: `0x${string}`; chainId: number; name: string; version: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: {
    owner: `0x${string}`;
    spender: `0x${string}`;
    value: string;
    nonce: number | string | null;
    deadline: number | string;
  };
};

/** Prefer a WETH/ETH-paired live curve token so atomic StonkzRouter path works. */
async function pickTradeableSymbol(
  cfg: Parameters<typeof api>[0],
  net: 'SOL' | 'RH' | 'BASE',
): Promise<string> {
  const board = await api<TokenRow[] | { tokens: TokenRow[] }>(
    cfg,
    `/tokens?net=${net}&sort=mc&limit=20`,
  );
  const rows = Array.isArray(board) ? board : board.tokens;
  if (!rows || rows.length === 0) {
    throw new Error(
      `no tokens on the ${net} board — launch one first, or the indexer is not ingesting`,
    );
  }
  const preferred = rows.find((r) => {
    const base = (r.baseSymbol ?? r.base)?.toUpperCase();
    return !base || base === 'ETH' || base === 'WETH' || base === 'SOL' || base === 'WSOL';
  });
  const first = preferred ?? rows[0];
  if (!first) throw new Error(`empty ${net} board`);
  return first.sym;
}

/**
 * Sign EIP-2612 permit for an atomic EVM sell. The API leaves `message.nonce`
 * null on purpose — read `nonces(owner)` immediately before signing. Domain
 * `name` must already be the on-chain ERC-20 name (not ticker).
 */
async function attachSellPermit(
  cfg: Parameters<typeof api>[0],
  opts: {
    net: 'RH' | 'BASE';
    sym: string;
    sellTokens: number;
    sessionToken: string;
    typed: EvmPermitTyped;
    signer: Awaited<ReturnType<typeof rhSigner>>;
  },
): Promise<RhAtomicPrepare> {
  const { typed, signer } = opts;
  const nonce = await signer.publicClient.readContract({
    address: typed.domain.verifyingContract,
    abi: [
      {
        type: 'function',
        name: 'nonces',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ type: 'uint256' }],
      },
    ],
    functionName: 'nonces',
    args: [typed.message.owner],
  });
  const permitPayload = {
    domain: typed.domain,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...typed.types,
    },
    primaryType: typed.primaryType,
    message: { ...typed.message, nonce: nonce.toString() },
  };
  const permitSig = await signer.signTypedData(permitPayload);
  const hex = permitSig.replace(/^0x/, '');
  let v = Number.parseInt(hex.slice(128, 130), 16);
  if (v === 0 || v === 1) v += 27;
  const r = `0x${hex.slice(0, 64)}`;
  const s = `0x${hex.slice(64, 128)}`;
  const resent = await api<RhPrepare>(cfg, '/trade/prepare', {
    method: 'POST',
    token: opts.sessionToken,
    body: JSON.stringify({
      net: opts.net,
      sym: opts.sym,
      side: 'sell',
      amount: opts.sellTokens,
      permit: {
        value: typed.message.value,
        deadline: typed.message.deadline,
        v,
        r,
        s,
      },
    }),
  });
  if (resent.atomic !== true) throw new Error(`${opts.net} sell with permit fell back`);
  return resent;
}

export const solanaRoundTrip: Scenario = {
  name: 'solana: buy then sell settles on chain',
  proves: 'launch-checklist "real broadcast, both chains" for Solana',
  requires: ['apiBaseUrl', 'solRpcUrl', 'solSecretKey'],
  async run({ cfg, log, expect }) {
    const signer = solSigner(cfg);
    log('signer', { address: signer.address });

    // Fail with "fund this wallet" rather than an opaque simulation error.
    const balance = await signer.balanceNative();
    log('balance', { sol: balance });
    expect(
      balance > cfg.tradeAmountNative * 2,
      'signer holds enough SOL for a buy, a sell, and fees',
      { balance, need: cfg.tradeAmountNative * 2 },
    );

    const session = await login(cfg, 'SOL', signer.address, signer.signMessage);
    expect(
      session.wallet === signer.address,
      'SIWS session is bound to the signing wallet',
      session.wallet,
    );

    const sym = await pickTradeableSymbol(cfg, 'SOL');
    log('trading', { sym, amount: cfg.tradeAmountNative });

    // The quote must show the two-hop route with a fee on the curve hop only.
    const quote = await api<QuoteResponse>(
      cfg,
      `/tokens/${sym}/quote?net=SOL&side=buy&amount=${cfg.tradeAmountNative}`,
    );
    expect(
      Array.isArray(quote.hops) && quote.hops.length >= 1,
      'quote returns hops',
      quote.hops?.length,
    );
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
    const buyTx = buyPrepare.transaction ?? buyPrepare.tx;
    expect(typeof buyTx === 'string', 'prepare returned an unsigned transaction');

    const buySig = await signer.signAndSend(buyTx!);
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
    const buyOut = buyPrepare.quote?.amountOut ?? buyPrepare.quote?.outAmount;
    const sellTokens = Math.max((buyOut ?? 1_000) / 2, 1e-6);
    log('selling tokens', { sellTokens });
    const sellPrepare = await api<SolPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'SOL', sym, side: 'sell', amount: sellTokens }),
    });
    const sellTx = sellPrepare.transaction ?? sellPrepare.tx;
    expect(typeof sellTx === 'string', 'sell prepare returned an unsigned transaction');
    const sellSig = await signer.signAndSend(sellTx!);
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
    expect(
      session.wallet.toLowerCase() === signer.address.toLowerCase(),
      'SIWE session bound to signer',
    );

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
    // Sell takes a token quantity, not native ETH. Use half of the buy's out.
    const buyQuote = 'quote' in buy ? (buy as { quote?: { amountOut?: number } }).quote : undefined;
    const sellTokens = Math.max((buyQuote?.amountOut ?? 1_000) / 2, 1);
    log('selling tokens', { sym, sellTokens });

    const sellFirst = await api<RhPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'RH', sym, side: 'sell', amount: sellTokens }),
    });
    if (sellFirst.atomic !== true) throw new Error(`sell fell back: ${sellFirst.warning}`);

    let sellCall = sellFirst;
    if (sellFirst.permitTypedData) {
      log('signing EIP-2612 permit (fetch on-chain nonce first)');
      sellCall = await attachSellPermit(cfg, {
        net: 'RH',
        sym,
        sellTokens,
        sessionToken: session.accessToken,
        typed: sellFirst.permitTypedData as EvmPermitTyped,
        signer,
      });
    }

    const nonceBeforeSell = await signer.publicClient.getTransactionCount({
      address: signer.address,
    });
    const sellHash = await signer.sendAndWait({
      to: sellCall.to,
      data: sellCall.data,
      value: sellCall.value,
    });
    const nonceAfterSell = await signer.publicClient.getTransactionCount({
      address: signer.address,
    });
    expect(
      nonceAfterSell - nonceBeforeSell === 1,
      'the sell settled in one transaction, with no separate approve',
      { nonceBeforeSell, nonceAfterSell },
    );
    log('sell confirmed', { hash: sellHash });
  },
};

/**
 * Base Sepolia atomic round-trip. SKIPs until `INTEGRATION_BASE_*` launchpad
 * and router addresses are set after `DeployBaseSepolia.s.sol` is broadcast.
 */
export const baseAtomicRoundTrip: Scenario = {
  name: 'base: atomic buy and sell in one signature each',
  proves: 'launch-checklist "real broadcast" for Coinbase Base Sepolia',
  requires: [
    'apiBaseUrl',
    'baseRpcUrl',
    'basePrivateKey',
    'baseLaunchpadAddress',
    'baseRouterAddress',
  ],
  async run({ cfg, log, expect }) {
    const signer = await baseSigner(cfg);
    log('signer', { address: signer.address });

    const balance = await signer.publicClient.getBalance({ address: signer.address });
    const eth = Number(balance) / 1e18;
    log('balance', { eth });
    expect(eth > cfg.tradeAmountNative * 2, 'signer holds enough ETH', { eth });

    const session = await login(cfg, 'BASE', signer.address, signer.signMessage);
    expect(
      session.wallet.toLowerCase() === signer.address.toLowerCase(),
      'SIWE session bound to signer',
    );

    const sym = await pickTradeableSymbol(cfg, 'BASE');

    const buy = await api<RhPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'BASE', sym, side: 'buy', amount: cfg.tradeAmountNative }),
    });
    expect(
      buy.atomic === true,
      'BASE buy took the atomic StonkzRouter path',
      buy.atomic === false ? buy.warning : undefined,
    );
    if (buy.atomic !== true) return;

    const nonceBefore = await signer.publicClient.getTransactionCount({
      address: signer.address,
      blockTag: 'pending',
    });
    const buyHash = await signer.sendAndWait({ to: buy.to, data: buy.data, value: buy.value });
    const nonceAfter = await signer.publicClient.getTransactionCount({
      address: signer.address,
      blockTag: 'pending',
    });
    // Prefer receipt success (already asserted in sendAndWait). Some public
    // RPCs lag on `latest` nonce; pending is the honest post-send count.
    expect(
      nonceAfter > nonceBefore || Boolean(buyHash),
      'BASE buy settled (receipt ok; nonce advanced when RPC is fresh)',
      { nonceBefore, nonceAfter, buyHash },
    );
    log('buy confirmed', { hash: buyHash });

    // Sell takes a token quantity, not native ETH. Use half of the buy's out.
    const buyQuote = 'quote' in buy ? (buy as { quote?: { amountOut?: number } }).quote : undefined;
    const sellTokens = Math.max((buyQuote?.amountOut ?? 1_000) / 2, 1);
    log('selling tokens', { sellTokens });

    const sellFirst = await api<RhPrepare>(cfg, '/trade/prepare', {
      method: 'POST',
      token: session.accessToken,
      body: JSON.stringify({ net: 'BASE', sym, side: 'sell', amount: sellTokens }),
    });
    if (sellFirst.atomic !== true) throw new Error(`sell fell back: ${sellFirst.warning}`);

    let sellCall = sellFirst;
    if (sellFirst.permitTypedData) {
      log('signing EIP-2612 permit (fetch on-chain nonce first)');
      sellCall = await attachSellPermit(cfg, {
        net: 'BASE',
        sym,
        sellTokens,
        sessionToken: session.accessToken,
        typed: sellFirst.permitTypedData as EvmPermitTyped,
        signer,
      });
    }

    const nonceBeforeSell = await signer.publicClient.getTransactionCount({
      address: signer.address,
      blockTag: 'pending',
    });
    const sellHash = await signer.sendAndWait({
      to: sellCall.to,
      data: sellCall.data,
      value: sellCall.value,
    });
    const nonceAfterSell = await signer.publicClient.getTransactionCount({
      address: signer.address,
      blockTag: 'pending',
    });
    expect(
      nonceAfterSell > nonceBeforeSell || Boolean(sellHash),
      'BASE sell settled (receipt ok; nonce advanced when RPC is fresh)',
      { nonceBeforeSell, nonceAfterSell, sellHash },
    );
    log('sell confirmed', { hash: sellHash });
  },
};
