import { Hono } from 'hono';
import { PublicKey } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import {
  ALL_NETS,
  EVM_NETS,
  MAJORS,
  isEvmNet,
  stockBasesFor,
  type EvmNet,
  type Net,
} from '@stonkz/shared';
import type { EthCaller } from '../auth/siwe.js';
import {
  ChainOpsError,
  buildSolanaAdminInstruction,
  composeSolanaAdminTransaction,
  decodeSolanaBaseOracle,
  prepareEvmAdminTx,
  readEvmLaunchpadState,
  readEvmVaults,
  readPushPriceSource,
  readSolanaGlobal,
  safeTransactionBuilderJson,
  type EvmAdminAction,
  type SolanaAdminAction,
} from '../admin/chain-ops.js';
import { requireAdmin, audited, type AdminEnv } from '../admin/middleware.js';
import { bad, confirmed, netParam, readBody, str } from '../admin/http.js';
import { evmChainId, evmLaunchpadAddress } from '../chain/evm-net.js';
import type { ChainRpc, SolanaAccountDataSource } from '../chain/types.js';
import { indexerCursors, tokens, treasuries } from '../db/schema.js';
import { derivePdas } from '../router/solana-idl.js';
import { asSolanaBlockhashSource } from '../router/solana-tx.js';
import { isNetDeployed } from './health.js';

/**
 * `/admin/chain` — live on-chain admin state per net, treasury vault
 * balances, oracle legs, and **preparation** of admin transactions. The
 * server returns unsigned calldata / unsigned Solana transactions plus a Safe
 * Transaction Builder export; the admin's browser wallet signs. Nothing here
 * holds a key or broadcasts.
 */
function ethCallerOf(rpc: ChainRpc): EthCaller | null {
  const c = rpc as Partial<EthCaller>;
  return typeof c.ethCall === 'function' ? (c as EthCaller) : null;
}

function solanaReader(rpc: ChainRpc): SolanaAccountDataSource | null {
  const c = rpc as Partial<SolanaAccountDataSource>;
  return typeof c.getAccountDataBase64 === 'function' ? (c as SolanaAccountDataSource) : null;
}

/** Owner-only actions: anything that moves funds or hands over control. */
const OWNER_ACTIONS = new Set([
  'withdrawTreasury',
  'withdraw_treasury',
  'proposeAdmin',
  'propose_admin',
  'setMigrator',
  'setWithdrawAuthorities',
  'set_withdraw_authorities',
  'setPriceSource',
  'set_oracle_authority',
]);

/** Distinct base mints the net has launched against, plus the configured majors/stocks. */
async function baseMintsFor(
  deps: AdminEnv['Variables']['deps'],
  net: Net,
): Promise<{ symbol: string; mint: string }[]> {
  const out = new Map<string, string>();
  const symbols = [...MAJORS[net].map((m) => m[0]), ...stockBasesFor(net).map((s) => s[0])];
  for (const sym of symbols) {
    const mint = deps.baseMints.mintFor(net, sym);
    if (mint) out.set(mint.toLowerCase(), sym);
  }
  const rows = await deps.db
    .selectDistinct({ baseMint: tokens.baseMint, baseSymbol: tokens.baseSymbol })
    .from(tokens)
    .where(eq(tokens.net, net))
    .catch(() => []);
  for (const r of rows) if (r.baseMint) out.set(r.baseMint.toLowerCase(), r.baseSymbol);
  const seen = new Set<string>();
  const list: { symbol: string; mint: string }[] = [];
  for (const [mintLower, symbol] of out) {
    if (seen.has(mintLower)) continue;
    seen.add(mintLower);
    const original =
      rows.find((r) => r.baseMint?.toLowerCase() === mintLower)?.baseMint ??
      deps.baseMints.mintFor(net, symbol) ??
      mintLower;
    list.push({ symbol, mint: original });
  }
  return list;
}

export function adminChainRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/chain/state', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const cursors = await deps.db
      .select()
      .from(indexerCursors)
      .catch(() => []);
    const vaultRows = await deps.db
      .select()
      .from(treasuries)
      .catch(() => []);
    const nets = await Promise.all(
      ALL_NETS.map(async (net) => {
        const base = {
          net,
          deployed: isNetDeployed(deps.env, net),
          cursor: cursors.find((r) => r.net === net)?.position ?? 0,
          treasuries: vaultRows
            .filter((t) => t.net === net)
            .map((t) => ({
              kind: t.kind,
              nativeBalance: t.nativeBalance,
              lifetimeCredited: t.lifetimeCredited,
            })),
        };
        if (!base.deployed) return { ...base, state: null, error: 'not deployed on this env' };
        try {
          if (isEvmNet(net)) {
            const eth = ethCallerOf(deps.rpcs[net]);
            if (!eth) return { ...base, state: null, error: 'RPC cannot eth_call' };
            const launchpad = evmLaunchpadAddress(deps.env, net);
            return {
              ...base,
              launchpad,
              chainId: evmChainId(deps.env, net),
              state: await readEvmLaunchpadState(eth, launchpad),
              error: null,
            };
          }
          const reader = solanaReader(deps.rpcs.SOL);
          if (!reader) return { ...base, state: null, error: 'RPC cannot read accounts' };
          const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
          const { global, pauser } = await readSolanaGlobal(reader, programId);
          return {
            ...base,
            programId: programId.toBase58(),
            state: global ? { ...global, pauser } : null,
            error: global ? null : 'Global account not found (program not initialised?)',
          };
        } catch (err) {
          return { ...base, state: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return c.json({ nets });
  });

  app.get('/admin/chain/vaults/:net', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    if (!net) return bad(c, 'net is required');
    const bases = await baseMintsFor(deps, net);
    const indexed = await deps.db
      .select()
      .from(treasuries)
      .where(eq(treasuries.net, net))
      .catch(() => []);
    if (!isNetDeployed(deps.env, net))
      return c.json({ net, deployed: false, indexed, onChain: [] });
    if (isEvmNet(net)) {
      const eth = ethCallerOf(deps.rpcs[net]);
      const launchpad = evmLaunchpadAddress(deps.env, net);
      const onChain = await Promise.all(
        bases.map(async (b) => {
          try {
            return {
              ...b,
              ...(eth ? await readEvmVaults(eth, launchpad, b.mint) : {}),
              error: eth ? null : 'no eth_call',
            };
          } catch (err) {
            return { ...b, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return c.json({ net, deployed: true, launchpad, indexed, onChain });
    }
    const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
    const onChain = await Promise.all(
      bases.map(async (b) => {
        try {
          const pdas = derivePdas(programId, new PublicKey(b.mint), new PublicKey(b.mint));
          return {
            ...b,
            vaults: {
              protocol: pdas.protocolVault.toBase58(),
              ops: pdas.opsVault.toBase58(),
              rwa: pdas.burnVault.toBase58(),
            },
            error: null,
          };
        } catch (err) {
          return { ...b, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return c.json({ net, deployed: true, programId: programId.toBase58(), indexed, onChain });
  });

  /** Oracle legs per base: the launchpad's price source (EVM) / the pushed BaseOracle (Solana), plus API-side feeds. */
  app.get('/admin/chain/oracle/:net', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    if (!net) return bad(c, 'net is required');
    const bases = await baseMintsFor(deps, net);
    const feeds = {
      hermes: deps.env.pythHermesUrl ? 'configured' : 'off',
      defillama: deps.env.defillamaCoinsUrl,
      attester: deps.env.stockPriceAttesterKey ? 'configured' : 'off',
      maxDivergenceBps: deps.env.stockPriceMaxDivergenceBps,
    };
    if (!isNetDeployed(deps.env, net)) return c.json({ net, deployed: false, feeds, legs: [] });
    const now = Math.floor(deps.now() / 1000);
    if (isEvmNet(net)) {
      const eth = ethCallerOf(deps.rpcs[net]);
      if (!eth) return c.json({ net, deployed: true, feeds, legs: [], error: 'no eth_call' });
      const launchpad = evmLaunchpadAddress(deps.env, net);
      let state;
      try {
        state = await readEvmLaunchpadState(eth, launchpad);
      } catch (err) {
        return c.json({
          net,
          deployed: true,
          feeds,
          legs: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const legs = await Promise.all(
        bases.map(async (b) => {
          try {
            const leg = await readPushPriceSource(eth, state.priceSource, b.mint);
            const age = leg.publishedAt ? now - leg.publishedAt : null;
            const bound = Math.min(
              leg.maxAge || state.maxOracleStaleness,
              state.maxOracleStaleness,
            );
            return {
              ...b,
              ...leg,
              ageSeconds: age,
              fresh: age !== null && age <= bound && leg.price1e6 !== '0',
            };
          } catch (err) {
            return { ...b, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return c.json({
        net,
        deployed: true,
        feeds,
        priceSource: state.priceSource,
        maxOracleStaleness: state.maxOracleStaleness,
        legs,
      });
    }
    const reader = solanaReader(deps.rpcs.SOL);
    if (!reader)
      return c.json({ net, deployed: true, feeds, legs: [], error: 'RPC cannot read accounts' });
    const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
    const { global } = await readSolanaGlobal(reader, programId).catch(() => ({
      global: null,
      pauser: null,
    }));
    const legs = await Promise.all(
      bases.map(async (b) => {
        try {
          const oracle = derivePdas(programId, new PublicKey(b.mint), new PublicKey(b.mint)).oracle;
          const raw = await reader.getAccountDataBase64(oracle.toBase58());
          if (!raw)
            return {
              ...b,
              oracle: oracle.toBase58(),
              price1e6: null,
              publishTime: null,
              fresh: false,
              error: 'no oracle account',
            };
          const decoded = decodeSolanaBaseOracle(raw);
          const age = now - decoded.publishTime;
          return {
            ...b,
            oracle: oracle.toBase58(),
            ...decoded,
            ageSeconds: age,
            fresh: global ? age <= global.maxOracleStaleness : false,
          };
        } catch (err) {
          return { ...b, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return c.json({
      net,
      deployed: true,
      feeds,
      oracleAuthority: global?.oracleAuthority ?? null,
      maxOracleStaleness: global?.maxOracleStaleness ?? null,
      legs,
    });
  });

  /* --------------------------------------------------------------- prepare */

  app.post('/admin/chain/prepare/:net', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    if (!net) return bad(c, 'net is required');
    if (!isNetDeployed(deps.env, net))
      return bad(c, `${net} is not deployed on this environment`, 422);
    const body = await readBody(c);
    const action = body['action'];
    if (
      !action ||
      typeof action !== 'object' ||
      typeof (action as { kind?: unknown }).kind !== 'string'
    ) {
      return bad(c, 'body.action.kind is required');
    }
    const kind = (action as { kind: string }).kind;
    if (OWNER_ACTIONS.has(kind) && c.get('admin').role !== 'owner') {
      return c.json({ error: 'forbidden', detail: `${kind} requires the owner role` }, 403);
    }
    if (!confirmed(body, `PREPARE ${kind}`)) return bad(c, `confirm with "PREPARE ${kind}"`);
    const signer = str(body['signer'], 64);
    if (!signer) return bad(c, 'signer (the wallet address that will sign) is required');

    try {
      if (isEvmNet(net)) {
        const chainId = evmChainId(deps.env, net);
        const tx = prepareEvmAdminTx(
          net as EvmNet,
          chainId,
          evmLaunchpadAddress(deps.env, net),
          action as EvmAdminAction,
        );
        const safe = safeTransactionBuilderJson({
          chainId,
          name: `Stonkz ${net} ${kind}`,
          description: tx.summary,
          createdAtMs: deps.now(),
          txs: [{ to: tx.to, data: tx.data, value: tx.value }],
        });
        await audited(c, 'chain.prepare', `${net}:${kind}`, null, {
          action,
          signer,
          to: tx.to,
          data: tx.data,
          summary: tx.summary,
        });
        return c.json({ ok: true, net, kind, tx, safe });
      }
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource) return bad(c, 'Solana RPC cannot supply a blockhash', 422);
      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const built = buildSolanaAdminInstruction(
        programId,
        new PublicKey(signer),
        action as SolanaAdminAction,
      );
      const composed = await composeSolanaAdminTransaction(
        blockhashSource,
        new PublicKey(signer),
        built.ix,
      );
      const tx = {
        net,
        programId: programId.toBase58(),
        transaction: composed.transaction,
        lastValidBlockHeight: composed.lastValidBlockHeight,
        summary: built.summary,
        signer: built.signer,
      };
      await audited(c, 'chain.prepare', `${net}:${kind}`, null, {
        action,
        signer,
        summary: built.summary,
      });
      return c.json({ ok: true, net, kind, tx });
    } catch (err) {
      if (err instanceof ChainOpsError)
        return c.json({ error: err.code, detail: err.message }, 400);
      if (err instanceof Error && /Invalid public key|Non-base58/i.test(err.message))
        return bad(c, 'signer is not a Solana address');
      throw err;
    }
  });

  /** The browser reports the hash after the wallet broadcast, so the audit trail links prepare → chain. */
  app.post('/admin/chain/submitted', requireAdmin('admin'), async (c) => {
    const body = await readBody(c);
    const net =
      typeof body['net'] === 'string' && (ALL_NETS as readonly string[]).includes(body['net'])
        ? (body['net'] as Net)
        : null;
    const kind = str(body['kind'], 64);
    const txHash = str(body['txHash'], 128);
    if (!net || !kind || !txHash) return bad(c, 'net, kind and txHash are required');
    await audited(c, 'chain.submitted', `${net}:${kind}`, null, {
      txHash,
      summary: str(body['summary'], 500) ?? null,
    });
    return c.json({ ok: true });
  });

  /** Aggregate indexed treasury totals across nets, for the chain-ops header. */
  app.get('/admin/chain/treasuries', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const rows = await deps.db
      .select({
        net: treasuries.net,
        kind: treasuries.kind,
        nativeBalance: treasuries.nativeBalance,
        lifetimeCredited: treasuries.lifetimeCredited,
        total: sql<number>`0`,
      })
      .from(treasuries);
    return c.json({ nets: EVM_NETS.concat('SOL' as never), treasuries: rows });
  });

  return app;
}
