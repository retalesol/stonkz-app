/**
 * Referral payout vault against a local validator.
 *
 * Proves the settlement half of `instructions/referral.rs`: a voucher signed
 * by the configured Ed25519 key pays exactly `cumulative - claimed` into the
 * recipient's ATA, a replay (or an older voucher) pays nothing and fails, a
 * tampered amount / stranger signer / expired deadline / paused config /
 * exhausted daily cap all fail closed, and the pauser can stop but not start.
 *
 * Self-contained: it initialises `Global` with its own admin. Run it against
 * a **fresh** validator (see docs/referral-payouts.md "Solana"):
 *
 *   solana-test-validator --reset --bpf-program FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg target/deploy/launchpad.so
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=<funded.json> \
 *     pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/referral.ts
 *
 * Under `anchor test` (where `tests/launchpad.ts` already initialised Global
 * with a different admin) the admin-gated cases skip themselves.
 */
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { assert } from 'chai';

import type { Launchpad } from '../target/types/launchpad';

const enc = (s: string) => Buffer.from(s, 'utf8');
const PREFIX = enc('STONKZ_REFERRAL_V1');
const CLUSTER_TAG = Buffer.from('localnet', 'utf8'); // exactly 8 bytes

/** The voucher bytes, byte-for-byte `referral_message` in referral.rs. */
function referralMessage(
  vault: PublicKey,
  recipient: PublicKey,
  baseMint: PublicKey,
  cumulative: bigint,
  deadline: bigint,
): Buffer {
  const cum = Buffer.alloc(8);
  cum.writeBigUInt64LE(cumulative);
  const dl = Buffer.alloc(8);
  dl.writeBigInt64LE(deadline);
  const m = Buffer.concat([
    PREFIX,
    CLUSTER_TAG,
    vault.toBuffer(),
    recipient.toBuffer(),
    baseMint.toBuffer(),
    cum,
    dl,
  ]);
  assert.equal(m.length, 138);
  return m;
}

/** Ed25519 over `message` with a Solana keypair, via Node's crypto (no extra deps). */
function ed25519Sign(kp: Keypair, message: Buffer): Buffer {
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return Buffer.from(nodeSign(null, message, key));
}

async function rejects(p: Promise<unknown>, match: RegExp) {
  try {
    await p;
  } catch (e) {
    const msg = `${(e as Error).message ?? ''}\n${JSON.stringify((e as { logs?: unknown }).logs ?? [])}`;
    assert.match(msg, match, `rejected, but not with ${match}`);
    return;
  }
  assert.fail(`expected a rejection matching ${match}`);
}

describe('referral payouts', () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.Launchpad as Program<Launchpad>;
  const conn = provider.connection;
  const pid = program.programId;

  const admin = Keypair.generate();
  const pauser = Keypair.generate();
  const signer = Keypair.generate();
  const stranger = Keypair.generate();
  const funder = Keypair.generate();
  const recipient = Keypair.generate();

  const globalPda = PublicKey.findProgramAddressSync([enc('global')], pid)[0];
  const configPda = PublicKey.findProgramAddressSync([enc('referral_config')], pid)[0];
  const pauserPda = PublicKey.findProgramAddressSync([enc('pauser')], pid)[0];
  const authorityPda = PublicKey.findProgramAddressSync([enc('referral_authority')], pid)[0];

  let baseMint: PublicKey;
  let vaultPda: PublicKey;
  let claimPda: PublicKey;
  let recipientAta: PublicKey;
  let weOwnGlobal = false;

  const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;
  const claimed = async () =>
    BigInt((await program.account.referralClaimState.fetch(claimPda)).claimed.toString());
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  async function fund(kp: Keypair, sol = 10) {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }

  /** `[ed25519 verify, claim_referral]` for one voucher, signed by `by`. The program creates the ATA. */
  function claimTx(cumulative: bigint, deadline: bigint, by: Keypair = signer, argCumulative = cumulative) {
    const message = referralMessage(vaultPda, recipient.publicKey, baseMint, cumulative, deadline);
    const verify = Ed25519Program.createInstructionWithPublicKey({
      publicKey: by.publicKey.toBytes(),
      message,
      signature: ed25519Sign(by, message),
    });
    return program.methods
      .claimReferral(new BN(argCumulative.toString()), new BN(deadline.toString()))
      .accountsPartial({
        referralConfig: configPda,
        baseMint,
        referralVault: vaultPda,
        referralAuthority: authorityPda,
        claimState: claimPda,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([verify])
      .signers([recipient]);
  }

  before(async () => {
    await Promise.all([fund(admin), fund(funder), fund(recipient), fund(pauser, 2), fund(stranger, 2)]);

    const existing = await conn.getAccountInfo(globalPda);
    if (!existing) {
      await program.methods
        .initialize(admin.publicKey, admin.publicKey, admin.publicKey, admin.publicKey, admin.publicKey)
        .accountsPartial({ global: globalPda, payer: admin.publicKey, systemProgram: SystemProgram.programId })
        .signers([admin])
        .rpc();
      weOwnGlobal = true;
    }

    baseMint = await createMint(conn, funder, funder.publicKey, null, 6);
    const funderAta = await createAssociatedTokenAccount(conn, funder, baseMint, funder.publicKey);
    await mintTo(conn, funder, baseMint, funderAta, funder, 5_000_000_000n);

    vaultPda = PublicKey.findProgramAddressSync([enc('referral_vault'), baseMint.toBuffer()], pid)[0];
    claimPda = PublicKey.findProgramAddressSync(
      [enc('referral_claim'), baseMint.toBuffer(), recipient.publicKey.toBuffer()],
      pid,
    )[0];
    recipientAta = getAssociatedTokenAddressSync(baseMint, recipient.publicKey);

    // Anyone opens the vault (a stranger pays the rent) …
    await program.methods
      .initReferralVault()
      .accountsPartial({
        global: globalPda,
        baseMint,
        referralVault: vaultPda,
        referralAuthority: authorityPda,
        payer: funder.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();
    // … and re-running it is a no-op.
    await program.methods
      .initReferralVault()
      .accountsPartial({
        global: globalPda,
        baseMint,
        referralVault: vaultPda,
        referralAuthority: authorityPda,
        payer: funder.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([funder])
      .rpc();
    const v = await getAccount(conn, vaultPda);
    assert.ok(v.owner.equals(authorityPda), 'vault authority is the referral authority PDA');

    await program.methods
      .fundReferralVault(new BN(1_000_000_000))
      .accountsPartial({
        baseMint,
        referralVault: vaultPda,
        source: funderAta,
        funder: funder.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([funder])
      .rpc();
    assert.equal(await bal(vaultPda), 1_000_000_000n);
  });

  function adminOnly(this: Mocha.Context) {
    if (!weOwnGlobal) this.skip();
  }

  it('claims are refused before a signer is configured', async function () {
    adminOnly.call(this);
    await rejects(claimTx(1n, now() + 600n).rpc(), /AccountNotInitialized|ReferralSignerUnset/);
  });

  it('admin configures the signer, cap and cluster tag', async function () {
    adminOnly.call(this);
    await rejects(
      program.methods
        .setReferralSigner(signer.publicKey, new BN('1000000000000'), Array.from(CLUSTER_TAG))
        .accountsPartial({
          global: globalPda,
          referralConfig: configPda,
          admin: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc(),
      /Unauthorized|ConstraintHasOne|insufficient funds/,
    );
    await program.methods
      .setReferralSigner(signer.publicKey, new BN('1000000000000'), Array.from(CLUSTER_TAG))
      .accountsPartial({
        global: globalPda,
        referralConfig: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    const cfg = await program.account.referralConfig.fetch(configPda);
    assert.ok(cfg.signer.equals(signer.publicKey));
    assert.equal(cfg.paused, false);
    assert.deepEqual(Buffer.from(cfg.clusterTag), CLUSTER_TAG);
  });

  it('a signed voucher pays the delta into the recipient ATA (created on the fly)', async function () {
    adminOnly.call(this);
    const deadline = now() + 600n;
    await claimTx(600_000n, deadline).rpc();
    assert.equal(await bal(recipientAta), 600_000n);
    assert.equal(await bal(vaultPda), 1_000_000_000n - 600_000n);
    const st = await program.account.referralClaimState.fetch(claimPda);
    assert.equal(st.claimed.toString(), '600000');
    assert.ok(st.recipient.equals(recipient.publicKey));
  });

  it('a replay pays nothing and an older voucher pays nothing', async function () {
    adminOnly.call(this);
    const deadline = now() + 600n;
    await rejects(claimTx(600_000n, deadline).rpc(), /ReferralNothingToClaim/);
    await rejects(claimTx(100_000n, deadline).rpc(), /ReferralNothingToClaim/);
    assert.equal(await bal(recipientAta), 600_000n, 'balance unchanged');
    assert.equal((await program.account.referralClaimState.fetch(claimPda)).claimed.toString(), '600000');
  });

  it('a later voucher pays only the increase', async function () {
    adminOnly.call(this);
    await claimTx(1_000_000n, now() + 600n).rpc();
    assert.equal(await bal(recipientAta), 1_000_000n);
    assert.equal(await bal(vaultPda), 1_000_000_000n - 1_000_000n);
  });

  it('tampered amount, stranger signer, missing verify and expiry all fail closed', async function () {
    adminOnly.call(this);
    const deadline = now() + 600n;
    // signed for 2_000_000 but asking the program for 3_000_000
    await rejects(claimTx(2_000_000n, deadline, signer, 3_000_000n).rpc(), /ReferralSignatureInvalid/);
    // right message, wrong key
    await rejects(claimTx(2_000_000n, deadline, stranger).rpc(), /ReferralSignatureInvalid/);
    // no ed25519 instruction at all
    await rejects(
      program.methods
        .claimReferral(new BN(2_000_000), new BN(deadline.toString()))
        .accountsPartial({
          referralConfig: configPda,
          baseMint,
          referralVault: vaultPda,
          referralAuthority: authorityPda,
          claimState: claimPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientAta,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          baseTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .signers([recipient])
        .rpc(),
      /ReferralSignatureInvalid/,
    );
    // expired — a month back, so a local validator whose clock lags wall time still agrees
    await rejects(claimTx(2_000_000n, now() - 86_400n * 30n).rpc(), /ReferralVoucherExpired/);
    // a forged ed25519 instruction pointing at the real claim message but a
    // different signer key is refused by the runtime before we run
    const message = referralMessage(vaultPda, recipient.publicKey, baseMint, 2_000_000n, deadline);
    const forged = new TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: Ed25519Program.createInstructionWithPublicKey({
        publicKey: signer.publicKey.toBytes(),
        message,
        signature: ed25519Sign(stranger, message),
      }).data,
    });
    const tx = new Transaction().add(forged).add(
      await program.methods
        .claimReferral(new BN(2_000_000), new BN(deadline.toString()))
        .accountsPartial({
          referralConfig: configPda,
          baseMint,
          referralVault: vaultPda,
          referralAuthority: authorityPda,
          claimState: claimPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientAta,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          baseTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );
    await rejects(provider.sendAndConfirm(tx, [recipient]), /precompile|InvalidAccountIndex|failed|Error/);
    assert.equal(await bal(recipientAta), 1_000_000n, 'nothing moved');
  });

  it('the daily cap refuses the crossing claim and rolls', async function () {
    adminOnly.call(this);
    await program.methods
      .setReferralSigner(signer.publicKey, new BN(1_500_000), Array.from(CLUSTER_TAG))
      .accountsPartial({
        global: globalPda,
        referralConfig: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    // Everything so far was claimed "today" (the window opened at the first
    // claim); the cap is 1_500_000 in total, so a top-up past it is refused
    // and one that stays under it pays.
    const before = await claimed();
    assert.equal(before, await bal(recipientAta));
    await rejects(claimTx(1_500_001n, now() + 600n).rpc(), /ReferralDailyCapExceeded/);
    await claimTx(1_400_000n, now() + 600n).rpc();
    assert.equal(await bal(recipientAta), 1_400_000n);
    // restore a wide cap for the rest of the suite
    await program.methods
      .setReferralSigner(signer.publicKey, new BN('1000000000000'), Array.from(CLUSTER_TAG))
      .accountsPartial({
        global: globalPda,
        referralConfig: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  });

  it('the pauser can pause, only admin unpauses', async function () {
    adminOnly.call(this);
    await program.methods
      .setPauser(pauser.publicKey)
      .accountsPartial({
        global: globalPda,
        pauserConfig: pauserPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await rejects(
      program.methods
        .setReferralPaused(true)
        .accountsPartial({ global: globalPda, referralConfig: configPda, pauserConfig: pauserPda, authority: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      /Unauthorized/,
    );
    await program.methods
      .setReferralPaused(true)
      .accountsPartial({ global: globalPda, referralConfig: configPda, pauserConfig: pauserPda, authority: pauser.publicKey })
      .signers([pauser])
      .rpc();
    const base = await claimed();
    await rejects(claimTx(base + 100_000n, now() + 600n).rpc(), /ReferralClaimsPaused/);
    await rejects(
      program.methods
        .setReferralPaused(false)
        .accountsPartial({ global: globalPda, referralConfig: configPda, pauserConfig: pauserPda, authority: pauser.publicKey })
        .signers([pauser])
        .rpc(),
      /Unauthorized/,
    );
    await program.methods
      .setReferralPaused(false)
      .accountsPartial({ global: globalPda, referralConfig: configPda, pauserConfig: null, authority: admin.publicKey })
      .signers([admin])
      .rpc();
    await claimTx(base + 100_000n, now() + 600n).rpc();
    assert.equal(await bal(recipientAta), base + 100_000n);
  });

  it('a short vault fails the whole claim and records nothing', async function () {
    adminOnly.call(this);
    const before = await bal(recipientAta);
    const base = await claimed();
    // 1_000_000_000 was funded; ask for more than remains.
    await rejects(claimTx(5_000_000_000n, now() + 600n).rpc(), /insufficient funds|0x1\b|custom program error/);
    assert.equal(await bal(recipientAta), before);
    assert.equal(await claimed(), base);
  });
});
