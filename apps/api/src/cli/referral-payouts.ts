/**
 * Referral native payouts — the operator half of `POST /referrals/claim
 * { payout: 'native' }`.
 *
 * A referrer's commission is 15 / 10 / 5% of a referred trader's curve fee,
 * taken out of the platform's 15% leg. The programs do not know about
 * referrals: the whole protocol leg lands in the on-chain protocol vault and
 * the indexer credits the DB protocol treasury **net** of every commission
 * (`apps/indexer/src/ingest.ts` `reconcileFeeAccrued`). So the unpaid
 * commissions are exactly the difference between the on-chain protocol vault
 * and the DB protocol treasury, and paying one out is a protocol-vault
 * withdrawal — `withdrawTreasury(0, base, amount, wallet)` on EVM,
 * `withdraw_treasury(Protocol, amount)` on Solana — which only the protocol
 * withdraw authority may sign. That is a multisig / cold key by design
 * (`StonkzLaunchpad.protocolWithdrawAuthority`, `Global.protocol_withdraw_authority`);
 * the API process never holds it, so settlement is this batch:
 *
 *   DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts list [--net BASE]
 *       prints every requested payout with the exact call the authority signs
 *   DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts paid --tx 0x… --ids 12,13 [--note "batch 3"]
 *       marks those requests settled by that transaction (the referrer's panel
 *       shows PAID OUT with the hash)
 *   DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts void --id 12 --note "wrong wallet"
 *       cancels a request and returns the amount to the wallet's pending balance
 *
 * Only **batch** rows (`method = 'batch'`) are listed or settled here. A
 * self-serve on-chain claim (`method = 'onchain'`, docs/referral-payouts.md)
 * is redeemed by the referrer's own voucher against the referral vault and
 * must never also be paid by the authority; `paid` and `void` refuse them.
 *
 * `list` writes nothing. Amounts are converted from the ledger's native
 * units to atoms at the base asset's decimals: 18 for WETH / ETH on the EVM
 * nets, 9 for wrapped SOL. Commissions are booked in the chain's native unit,
 * so payouts draw on the **wrapped-native** protocol vault (WETH on Base and
 * RH, wSOL on Solana); fills against other bases (USDC, stock tokens) credit
 * those vaults instead and the operator tops the native vault up from them if
 * it runs short — `scripts/reconcile-fees.ts` shows each vault's balance.
 */
import { encodeFunctionData, getAddress, parseUnits } from 'viem';

type Net = 'SOL' | 'RH' | 'BASE' | 'ARC';

const WITHDRAW_ABI = [
  {
    type: 'function',
    name: 'withdrawTreasury',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'which', type: 'uint8' },
      { name: 'baseToken', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
] as const;

/** Where each net's native protocol vault lives and what it is denominated in. */
const NETS: Record<Net, { launchpad: string; base: string; baseSym: string; decimals: number }> = {
  BASE: {
    launchpad: '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35',
    base: '0x4200000000000000000000000000000000000006',
    baseSym: 'WETH',
    decimals: 18,
  },
  RH: {
    launchpad: '0xe308287C9A85E2B53F1027a1c589B5e3969928e8',
    base: '0x7943e237c7F95DA44E0301572D358911207852Fa',
    baseSym: 'WETH',
    decimals: 18,
  },
  ARC: { launchpad: '', base: '', baseSym: 'USDC', decimals: 18 },
  SOL: {
    launchpad: 'FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg',
    base: 'So11111111111111111111111111111111111111112',
    baseSym: 'wSOL',
    decimals: 9,
  },
};

let ARGV: string[] = [];
function arg(name: string): string | undefined {
  const i = ARGV.indexOf(`--${name}`);
  return i >= 0 ? ARGV[i + 1] : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  ARGV = argv;
  const cmd = argv[0];
  if (!cmd || !['list', 'paid', 'void'].includes(cmd)) {
    console.error(
      'usage: referral-payouts.ts list [--net N] | paid --tx SIG --ids 1,2 [--note …] | void --id N --note …',
    );
    process.exit(2);
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');

  const { createDb } = await import('../db/client.js');
  const { ReferralService } = await import('../game/referrals.js');
  const handle = createDb({ url, singleConnection: true });
  try {
    // The ledger is only needed for `stonkz` claims, which this batch never makes.
    const referrals = new ReferralService({
      db: handle.db,
      ledger: {
        readBalance: async () => ({ stonkz: 0 }),
        creditStonkz: async () => 0,
        creditSpOnly: async () => undefined,
      } as never,
    });

    if (cmd === 'list') {
      const net = arg('net')?.toUpperCase() as Net | undefined;
      const rows = await referrals.listPayoutRequests(net);
      if (rows.length === 0) {
        console.log('no native payout requests pending');
        return;
      }
      const byNet = new Map<Net, typeof rows>();
      for (const r of rows) byNet.set(r.net, [...(byNet.get(r.net) ?? []), r]);
      for (const [n, list] of byNet) {
        const cfg = NETS[n];
        const total = list.reduce((s, r) => s + r.amountNative, 0);
        console.log(
          `\n== ${n}: ${list.length} request(s), ${total.toFixed(9)} ${cfg.baseSym} from the protocol vault ${cfg.base}`,
        );
        console.log(
          `   signer: the ${n} protocol withdraw authority (cold key / multisig). Launchpad ${cfg.launchpad}.`,
        );
        for (const r of list) {
          const atoms = parseUnits(r.amountNative.toFixed(cfg.decimals), cfg.decimals);
          const tiers = Object.entries(r.tiers)
            .map(([t, v]) => `T${t} ${v.toFixed(9)}`)
            .join(', ');
          console.log(
            `\n   #${r.id}  ${r.wallet}  ${r.amountNative.toFixed(9)} ${cfg.baseSym}  (${tiers})  requested ${new Date(r.requestedAt).toISOString()}`,
          );
          if (n === 'SOL') {
            console.log(
              `     withdraw_treasury(Protocol, ${atoms}) — accounts: global, base_mint ${cfg.base}, vault = protocol_vault PDA(base_mint), destination = ${r.wallet}'s wSOL ATA, authority = protocol_withdraw_authority`,
            );
          } else {
            const data = encodeFunctionData({
              abi: WITHDRAW_ABI,
              functionName: 'withdrawTreasury',
              args: [0, getAddress(cfg.base), atoms, getAddress(r.wallet)],
            });
            console.log(
              `     cast send ${cfg.launchpad} ${data}   # withdrawTreasury(0, ${cfg.baseSym}, ${atoms}, ${r.wallet})`,
            );
          }
        }
        console.log(
          `\n   after broadcasting: referral-payouts.ts paid --tx <hash> --ids ${list.map((r) => r.id).join(',')}`,
        );
      }
      return;
    }

    if (cmd === 'paid') {
      const tx = arg('tx');
      const ids = (arg('ids') ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!tx || ids.length === 0) throw new Error('paid needs --tx and --ids');
      const n = await referrals.markPayoutsPaid(ids, tx, arg('note'));
      console.log(`marked ${n} of ${ids.length} request(s) paid by ${tx}`);
      if (n !== ids.length) process.exit(1);
      return;
    }

    const id = Number(arg('id'));
    const note = arg('note');
    if (!Number.isInteger(id) || !note) throw new Error('void needs --id and --note');
    const ok = await referrals.voidPayoutRequest(id, note);
    console.log(
      ok ? `voided #${id}; amount returned to pending` : `#${id} is not an open native request`,
    );
    if (!ok) process.exit(1);
  } finally {
    await handle.close();
  }
}
