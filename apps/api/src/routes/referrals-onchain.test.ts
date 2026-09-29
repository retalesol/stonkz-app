import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicKey, Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseUnits,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authed, createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';
import { evmWallet, solanaWallet } from '../test/wallets.js';
import {
  REFERRAL_CLAIM_TYPES,
  REFERRAL_EVM_DOMAIN,
  REFERRAL_SOL_MESSAGE_LEN,
  referralMessageSol,
  solClusterTag,
  solSignerFromKey,
  verifyEd25519,
} from '../game/referral-signer.js';
import { REFERRAL_VAULT_ABI } from '../router/evm-referral.js';
import { encodeReferralClaimedEvent, referralPdas } from '../router/solana-referral.js';

/**
 * Self-serve on-chain referral claims (`docs/referral-payouts.md`): the
 * voucher the API signs is bound to the vault / chain / recipient / asset, is
 * **cumulative** so re-preparing never double-counts, the confirm settles the
 * rows the chain's event covers, and a net without a vault keeps the request
 * flow.
 */

const EVM_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SOL_SEED = 'a'.repeat(64);
const BASE_VAULT = '0x1111111111111111111111111111111111111111';
const BASE_WETH = '0x4200000000000000000000000000000000000006';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp({
    env: {
      REFERRAL_SIGNER_KEY_EVM: EVM_KEY,
      REFERRAL_SIGNER_KEY_SOL: SOL_SEED,
      REFERRAL_VAULT_ADDRESS_BASE: BASE_VAULT,
      // RH deliberately has no vault: it keeps the operator-batch flow.
    },
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.setNow(FROZEN_NOW);
});

const json = { 'content-type': 'application/json' };

/** referrer ← trader, then one fill worth `fee` with a 20% protocol leg (T1 = 15% of fee). */
async function earn(net: 'SOL' | 'BASE' | 'RH', seed: string, fee: number) {
  const mk = net === 'SOL' ? solanaWallet : evmWallet;
  const referrer = await h.login(net, mk(`${seed}-ref`));
  const trader = await h.login(net, mk(`${seed}-trader`));
  const { code } = (await (
    await h.app.request('/referrals', { headers: authed(referrer.token) })
  ).json()) as { code: string };
  await h.app.request('/referrals/attach', {
    method: 'POST',
    headers: { ...authed(trader.token), ...json },
    body: JSON.stringify({ code }),
  });
  await h.deps.referrals.creditFeesFromFill({
    net,
    trader: trader.address,
    feeAmount: fee,
    protocolLeg: fee * 0.2,
    txSig: `sig-${seed}-${fee}-${Math.random()}`,
  });
  return referrer;
}

function evmClaimedLog(
  vault: string,
  recipient: string,
  asset: string,
  amount: bigint,
  cum: bigint,
) {
  const topics = encodeEventTopics({
    abi: REFERRAL_VAULT_ABI,
    eventName: 'ReferralClaimed',
    args: { recipient: recipient as Address, asset: asset as Address },
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'address' }],
    [amount, cum, true, recipient as Address],
  );
  return { address: vault, topics: topics as string[], data, logIndex: 0 };
}

describe('EVM (Base) self-serve claim', () => {
  it('reports the position, signs a domain-bound cumulative voucher and never double-counts', async () => {
    const referrer = await earn('BASE', 'evm-a', 1); // T1 = 0.15 ETH
    const wallet = getAddress(referrer.address);

    const claimable = (await (
      await h.app.request('/referrals/claimable', { headers: authed(referrer.token) })
    ).json()) as { configured: boolean; assets: { claimableAtoms: string; symbol: string }[] };
    expect(claimable.configured).toBe(true);
    expect(claimable.assets[0]!.symbol).toBe('WETH');
    expect(claimable.assets[0]!.claimableAtoms).toBe(parseUnits('0.15', 18).toString());

    const res = await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const prep = (await res.json()) as {
      to: string;
      data: Hex;
      dataUnwrap: Hex;
      value: string;
      signature: Hex;
      cumulativeAtoms: string;
      amountAtoms: string;
      deadline: number;
      chainId: number;
      payoutId: number;
    };
    expect(prep.to).toBe(getAddress(BASE_VAULT));
    expect(prep.value).toBe('0');
    expect(prep.cumulativeAtoms).toBe(parseUnits('0.15', 18).toString());
    expect(prep.amountAtoms).toBe(prep.cumulativeAtoms);
    expect(prep.deadline).toBe(Math.floor(FROZEN_NOW / 1000) + 1800);

    // The voucher verifies under the vault's EIP-712 domain for the API key…
    const signer = privateKeyToAccount(EVM_KEY);
    const ok = await verifyTypedData({
      address: signer.address,
      domain: {
        ...REFERRAL_EVM_DOMAIN,
        chainId: prep.chainId,
        verifyingContract: getAddress(BASE_VAULT),
      },
      types: REFERRAL_CLAIM_TYPES,
      primaryType: 'ReferralClaim',
      message: {
        recipient: wallet,
        asset: getAddress(BASE_WETH),
        cumulativeAmount: BigInt(prep.cumulativeAtoms),
        deadline: BigInt(prep.deadline),
      },
      signature: prep.signature,
    });
    expect(ok).toBe(true);
    // …and not under another vault's.
    const other = await verifyTypedData({
      address: signer.address,
      domain: { ...REFERRAL_EVM_DOMAIN, chainId: prep.chainId, verifyingContract: BASE_WETH },
      types: REFERRAL_CLAIM_TYPES,
      primaryType: 'ReferralClaim',
      message: {
        recipient: wallet,
        asset: getAddress(BASE_WETH),
        cumulativeAmount: BigInt(prep.cumulativeAtoms),
        deadline: BigInt(prep.deadline),
      },
      signature: prep.signature,
    });
    expect(other).toBe(false);

    // Both calldata shapes carry the voucher verbatim.
    const call = decodeFunctionData({ abi: REFERRAL_VAULT_ABI, data: prep.data });
    expect(call.functionName).toBe('claim');
    expect(call.args).toEqual([
      wallet,
      getAddress(BASE_WETH),
      BigInt(prep.cumulativeAtoms),
      BigInt(prep.deadline),
      prep.signature,
    ]);
    const unwrap = decodeFunctionData({ abi: REFERRAL_VAULT_ABI, data: prep.dataUnwrap });
    expect(unwrap.functionName).toBe('claimAsEth');

    // Pending is drained: the snapshot shows it awaiting payout, not pending.
    const snap = await h.deps.referrals.snapshot('BASE', referrer.address);
    expect(snap.pendingNative).toBe(0);
    expect(snap.requestedNative).toBeCloseTo(0.15, 10);
    expect(snap.payouts[0]).toMatchObject({ method: 'onchain', status: 'requested' });

    // Preparing again (voucher lost / expired) re-issues the same cumulative — no new row.
    h.advance(60_000);
    const again = (await (
      await h.app.request('/referrals/claim/prepare', {
        method: 'POST',
        headers: { ...authed(referrer.token), ...json },
        body: '{}',
      })
    ).json()) as { cumulativeAtoms: string; payoutId: number; deadline: number };
    expect(again.cumulativeAtoms).toBe(prep.cumulativeAtoms);
    expect(again.payoutId).toBe(prep.payoutId);
    expect(again.deadline).toBeGreaterThan(prep.deadline);
    expect((await h.deps.referrals.payouts('BASE', referrer.address)).length).toBe(1);

    // More accrues before the first voucher is redeemed: the next voucher is
    // cumulative (0.15 + 0.03) and the chain would pay the full 0.18.
    await h.deps.referrals.creditFeesFromFill({
      net: 'BASE',
      trader: evmWallet('evm-a-trader').address,
      feeAmount: 0.2,
      protocolLeg: 0.04,
      txSig: 'sig-evm-a-second',
    });
    const third = (await (
      await h.app.request('/referrals/claim/prepare', {
        method: 'POST',
        headers: { ...authed(referrer.token), ...json },
        body: '{}',
      })
    ).json()) as { cumulativeAtoms: string; amountAtoms: string };
    expect(third.cumulativeAtoms).toBe(parseUnits('0.18', 18).toString());
    expect(third.amountAtoms).toBe(parseUnits('0.18', 18).toString());
    expect((await h.deps.referrals.payouts('BASE', referrer.address)).length).toBe(2);

    // The wallet redeems the newest voucher; the vault pays 0.18 and reports cumulative 0.18.
    h.rpcs.BASE.setEvmReceipt('0xabc', {
      status: 'success',
      from: wallet,
      to: BASE_VAULT,
      input: '0x',
      logs: [
        evmClaimedLog(
          BASE_VAULT,
          wallet,
          BASE_WETH,
          parseUnits('0.18', 18),
          parseUnits('0.18', 18),
        ),
      ],
      blockNumber: 10,
    });
    const confirm = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: '0xabc' }),
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({
      ok: true,
      paidAtoms: parseUnits('0.18', 18).toString(),
      settled: 2,
    });
    const after = await h.deps.referrals.snapshot('BASE', referrer.address);
    expect(after.requestedNative).toBe(0);
    expect(after.paidNative).toBeCloseTo(0.18, 10);
    expect(after.payouts.every((p) => p.status === 'paid' && p.txSig === '0xabc')).toBe(true);

    // Nothing left: prepare is the honest empty answer, confirm of the same tx settles nothing new.
    const empty = await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    expect(empty.status).toBe(422);
    const dup = (await (
      await h.app.request('/referrals/claim/confirm', {
        method: 'POST',
        headers: { ...authed(referrer.token), ...json },
        body: JSON.stringify({ signature: '0xabc' }),
      })
    ).json()) as { settled: number };
    expect(dup.settled).toBe(0);
  });

  it('confirm refuses a receipt that did not pay this wallet, and a pending one', async () => {
    const referrer = await earn('BASE', 'evm-b', 1);
    await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    const missing = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: '0xnope' }),
    });
    expect(missing.status).toBe(404);

    const someoneElse = evmWallet('evm-b-other').address;
    h.rpcs.BASE.setEvmReceipt('0xother', {
      status: 'success',
      to: BASE_VAULT,
      input: '0x',
      logs: [evmClaimedLog(BASE_VAULT, someoneElse, BASE_WETH, 1n, 1n)],
    });
    const wrong = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: '0xother' }),
    });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toEqual({ error: 'no_claim_in_tx' });

    h.rpcs.BASE.setEvmReceipt('0xrev', {
      status: 'reverted',
      to: BASE_VAULT,
      input: '0x',
      logs: [],
    });
    const reverted = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: '0xrev' }),
    });
    expect(reverted.status).toBe(422);
    const snap = await h.deps.referrals.snapshot('BASE', referrer.address);
    expect(snap.requestedNative).toBeCloseTo(0.15, 10);
  });

  it('a wallet mid-prepare gets claim_in_progress, not a second voucher', async () => {
    const referrer = await earn('BASE', 'evm-c', 1);
    await h.redis.set(`refclaim:BASE:${referrer.address}`, '1', {
      ttlSeconds: 20,
      ifNotExists: true,
    });
    const res = await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'claim_in_progress' });
    await h.redis.del(`refclaim:BASE:${referrer.address}`);
    const ok = await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    // and the lock is released afterwards
    expect(await h.redis.get(`refclaim:BASE:${referrer.address}`)).toBeNull();
  });

  it('on-chain rows never reach the operator batch and cannot be voided', async () => {
    const referrer = await earn('BASE', 'evm-d', 1);
    const prep = (await (
      await h.app.request('/referrals/claim/prepare', {
        method: 'POST',
        headers: { ...authed(referrer.token), ...json },
        body: '{}',
      })
    ).json()) as { payoutId: number };
    expect(await h.deps.referrals.listPayoutRequests('BASE')).toEqual([]);
    expect(await h.deps.referrals.voidPayoutRequest(prep.payoutId, 'oops')).toBe(false);
    expect(await h.deps.referrals.markPayoutsPaid([prep.payoutId], '0xbatch')).toBe(0);
    const snap = await h.deps.referrals.snapshot('BASE', referrer.address);
    expect(snap.pendingNative).toBe(0);
    expect(snap.payouts[0]).toMatchObject({ status: 'requested', method: 'onchain' });
  });
});

describe('a net without a vault keeps the request flow', () => {
  it('RH: claimable says not configured, prepare refuses, the batch request still works', async () => {
    const referrer = await earn('RH', 'rh-a', 1);
    const claimable = (await (
      await h.app.request('/referrals/claimable', { headers: authed(referrer.token) })
    ).json()) as { configured: boolean; assets: unknown[] };
    expect(claimable).toMatchObject({ configured: false, assets: [] });
    const snap = (await (
      await h.app.request('/referrals', { headers: authed(referrer.token) })
    ).json()) as { onchainClaims: boolean };
    expect(snap.onchainClaims).toBe(false);

    const prep = await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    expect(prep.status).toBe(409);

    const req = await h.app.request('/referrals/claim', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ payout: 'native' }),
    });
    expect(req.status).toBe(200);
    expect((await h.deps.referrals.listPayoutRequests('RH')).length).toBe(1);
  });
});

describe('Solana self-serve claim', () => {
  it('prepends an Ed25519 verification of the exact voucher and settles on the program event', async () => {
    const referrer = await earn('SOL', 'sol-a', 1); // T1 = 0.15 SOL
    const res = await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const prep = (await res.json()) as {
      transaction: string;
      cumulativeAtoms: string;
      deadline: number;
      vault: string;
      signature: string;
      lastValidBlockHeight: number;
    };
    expect(prep.cumulativeAtoms).toBe('150000000');

    const tx = Transaction.from(Buffer.from(prep.transaction, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(referrer.address);
    expect(tx.instructions).toHaveLength(2);
    const [verify, claim] = tx.instructions as [
      (typeof tx.instructions)[0],
      (typeof tx.instructions)[0],
    ];
    expect(verify.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');

    // The verified message is byte-for-byte the program's layout…
    const signer = solSignerFromKey(SOL_SEED)!;
    const programId = new PublicKey(h.deps.env.solanaLaunchpadProgramId);
    const recipient = new PublicKey(referrer.address);
    const pdas = referralPdas(programId, NATIVE_MINT, recipient);
    expect(prep.vault).toBe(pdas.vault.toBase58());
    const expected = referralMessageSol({
      clusterTag: solClusterTag(h.deps.env.solanaCluster),
      vault: pdas.vault,
      recipient,
      baseMint: NATIVE_MINT,
      cumulativeAmount: BigInt(prep.cumulativeAtoms),
      deadline: BigInt(prep.deadline),
    });
    const data = verify.data;
    expect(data[0]).toBe(1);
    const pkOff = data.readUInt16LE(6);
    const sigOff = data.readUInt16LE(2);
    const msgOff = data.readUInt16LE(10);
    const msgLen = data.readUInt16LE(12);
    expect(msgLen).toBe(REFERRAL_SOL_MESSAGE_LEN);
    expect(Buffer.from(data.subarray(pkOff, pkOff + 32))).toEqual(signer.publicKey.toBuffer());
    expect(Buffer.from(data.subarray(msgOff, msgOff + msgLen))).toEqual(expected);
    // …and the signature is the API key's over exactly that message.
    const sig = Buffer.from(data.subarray(sigOff, sigOff + 64));
    expect(sig.toString('base64')).toBe(prep.signature);
    expect(verifyEd25519(signer.publicKey, expected, sig)).toBe(true);
    expect(verifyEd25519(signer.publicKey, Buffer.concat([expected, Buffer.from([0])]), sig)).toBe(
      false,
    );

    // claim_referral carries (cumulative u64, deadline i64) after the discriminator
    expect(claim.programId.equals(programId)).toBe(true);
    expect(claim.data.readBigUInt64LE(8)).toBe(BigInt(prep.cumulativeAtoms));
    expect(claim.data.readBigInt64LE(16)).toBe(BigInt(prep.deadline));
    expect(claim.keys[5]!.pubkey.equals(recipient)).toBe(true);
    expect(claim.keys[5]!.isSigner).toBe(true);

    // The program's ReferralClaimed settles the row.
    const pid = programId.toBase58();
    h.rpcs.SOL.setSolanaTransactionLogs('5sig', {
      slot: 1,
      blockTimeMs: FROZEN_NOW,
      failed: false,
      logMessages: [
        `Program ${pid} invoke [1]`,
        `Program data: ${encodeReferralClaimedEvent({
          baseMint: NATIVE_MINT.toBase58(),
          vault: pdas.vault.toBase58(),
          recipient: referrer.address,
          amount: 150_000_000n,
          cumulativeAmount: 150_000_000n,
          ts: BigInt(Math.floor(FROZEN_NOW / 1000)),
        })}`,
        `Program ${pid} success`,
      ],
      innerInstructions: [],
      accountKeys: [],
    });
    const confirm = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: '5sig' }),
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ ok: true, paidAtoms: '150000000', settled: 1 });
    const snap = await h.deps.referrals.snapshot('SOL', referrer.address);
    expect(snap.paidNative).toBeCloseTo(0.15, 10);
    expect(snap.payouts[0]).toMatchObject({ method: 'onchain', status: 'paid', txSig: '5sig' });
  });

  it('an event for another recipient or a failed transaction settles nothing', async () => {
    const referrer = await earn('SOL', 'sol-b', 1);
    await h.app.request('/referrals/claim/prepare', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: '{}',
    });
    const programId = new PublicKey(h.deps.env.solanaLaunchpadProgramId);
    const pid = programId.toBase58();
    const other = solanaWallet('sol-b-other').address;
    const vault = referralPdas(programId, NATIVE_MINT, new PublicKey(other)).vault.toBase58();
    h.rpcs.SOL.setSolanaTransactionLogs('otherSig', {
      slot: 1,
      blockTimeMs: FROZEN_NOW,
      failed: false,
      logMessages: [
        `Program ${pid} invoke [1]`,
        `Program data: ${encodeReferralClaimedEvent({
          baseMint: NATIVE_MINT.toBase58(),
          vault,
          recipient: other,
          amount: 1n,
          cumulativeAmount: 1n,
          ts: 0n,
        })}`,
        `Program ${pid} success`,
      ],
      innerInstructions: [],
      accountKeys: [],
    });
    const wrong = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: 'otherSig' }),
    });
    expect(wrong.status).toBe(422);
    h.rpcs.SOL.setSolanaTransactionLogs('failedSig', {
      slot: 1,
      blockTimeMs: FROZEN_NOW,
      failed: true,
      logMessages: [],
      innerInstructions: [],
      accountKeys: [],
    });
    const failed = await h.app.request('/referrals/claim/confirm', {
      method: 'POST',
      headers: { ...authed(referrer.token), ...json },
      body: JSON.stringify({ signature: 'failedSig' }),
    });
    expect(failed.status).toBe(422);
    const snap = await h.deps.referrals.snapshot('SOL', referrer.address);
    expect(snap.requestedNative).toBeCloseTo(0.15, 10);
  });
});
