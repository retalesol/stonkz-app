/**
 * One-shot: initialize launchpad on Solana devnet, launch DEVCOIN (WSOL base),
 * buy then sell, print mint/curve for API seeding.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=/path/to/funded.json \
 *   pnpm exec tsx programs/solana/scripts/devnet-smoke.ts
 */
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import type { Launchpad } from '../target/types/launchpad.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const enc = (s: string) => Buffer.from(s, 'utf8');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const walletPath =
    process.env.ANCHOR_WALLET ||
    '/Users/development/Documents/builds/nave-contracts/smart-contracts/.deploy-wallet-devnet.json';
  const secret = JSON.parse(fs.readFileSync(walletPath, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const conn = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com',
    'confirmed',
  );
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, '../target/idl/launchpad.json'), 'utf8'));
  const program = new anchor.Program(idl, provider) as Program<Launchpad>;
  const pid = program.programId;
  console.log('program', pid.toBase58());
  console.log('payer', payer.publicKey.toBase58());

  const globalPda = PublicKey.findProgramAddressSync([enc('global')], pid)[0];
  const vault = (seed: string, key: PublicKey) =>
    PublicKey.findProgramAddressSync([enc(seed), key.toBuffer()], pid)[0];
  const oraclePda = PublicKey.findProgramAddressSync([enc('oracle'), NATIVE_MINT.toBuffer()], pid)[0];

  const globalInfo = await conn.getAccountInfo(globalPda);
  if (!globalInfo) {
    console.log('initializing global…');
    const opsAuth = Keypair.generate().publicKey;
    await program.methods
      .initialize(
        payer.publicKey,
        payer.publicKey, // protocol
        opsAuth,
        payer.publicKey, // oracle
        payer.publicKey, // migration
      )
      .accountsPartial({
        global: globalPda,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } else {
    console.log('global already exists');
  }

  console.log('pushing WSOL oracle price…');
  await program.methods
    .pushPrice(new BN(150_000_000), new BN(100))
    .accountsPartial({
      global: globalPda,
      oracle: oraclePda,
      baseMint: NATIVE_MINT,
      oracleAuthority: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log('init treasury…');
  try {
    await program.methods
      .initTreasury()
      .accountsPartial({
        global: globalPda,
        baseMint: NATIVE_MINT,
        protocolVault: vault('protocol_vault', NATIVE_MINT),
        opsVault: vault('ops_vault', NATIVE_MINT),
        payer: payer.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } catch (e) {
    console.log('initTreasury:', (e as Error).message.slice(0, 120));
  }

  const ticker = 'DEVCOIN';
  const mint = PublicKey.findProgramAddressSync([enc('mint'), enc(ticker)], pid)[0];
  const curve = vault('curve', mint);
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo) {
    console.log('creating', ticker, mint.toBase58());
    await program.methods
      .createToken(`${ticker} coin`, ticker, `https://ston.kz/t/${ticker}`, new BN(1_000_000_000), 300, false)
      .accountsPartial({
        global: globalPda,
        mint,
        curve,
        baseMint: NATIVE_MINT,
        oracle: oraclePda,
        curveTokenVault: vault('curve_token', mint),
        lpVault: vault('lp_vault', mint),
        curveBaseVault: vault('curve_base', mint),
        bucketBaseVault: vault('bucket_base', mint),
        bucketTokenVault: vault('bucket_token', mint),
        stakeEscrow: vault('stake_escrow', mint),
        creator: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .rpc();
  } else {
    console.log(ticker, 'already exists', mint.toBase58());
  }

  const traderBase = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const traderToken = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const wrapIx = [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, traderBase, payer.publicKey, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, traderToken, payer.publicKey, mint),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: traderBase, lamports: 50_000_000 }), // 0.05 SOL
    createSyncNativeInstruction(traderBase),
  ];
  await sendAndConfirmTransaction(conn, new Transaction().add(...wrapIx), [payer]);

  const buyAmount = 20_000_000n; // 0.02 SOL
  console.log('buying…');
  await program.methods
    .buy(new BN(buyAmount.toString()), new BN(0))
    .accountsPartial({
      global: globalPda,
      curve,
      mint,
      baseMint: NATIVE_MINT,
      curveBaseVault: vault('curve_base', mint),
      curveTokenVault: vault('curve_token', mint),
      bucketBaseVault: vault('bucket_base', mint),
      bucketTokenVault: vault('bucket_token', mint),
      protocolVault: vault('protocol_vault', NATIVE_MINT),
      opsVault: vault('ops_vault', NATIVE_MINT),
      trader: payer.publicKey,
      traderBaseAccount: traderBase,
      traderTokenAccount: traderToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      baseTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const tokBal = (await getAccount(conn, traderToken)).amount;
  console.log('token balance', tokBal.toString());

  const sellAmount = tokBal / 2n;
  console.log('selling', sellAmount.toString());
  await program.methods
    .sell(new BN(sellAmount.toString()), new BN(0))
    .accountsPartial({
      global: globalPda,
      curve,
      mint,
      baseMint: NATIVE_MINT,
      curveBaseVault: vault('curve_base', mint),
      curveTokenVault: vault('curve_token', mint),
      bucketBaseVault: vault('bucket_base', mint),
      bucketTokenVault: vault('bucket_token', mint),
      protocolVault: vault('protocol_vault', NATIVE_MINT),
      opsVault: vault('ops_vault', NATIVE_MINT),
      trader: payer.publicKey,
      traderBaseAccount: traderBase,
      traderTokenAccount: traderToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      baseTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const curveAcc = await conn.getAccountInfo(curve);
  console.log('curve data len', curveAcc?.data.length);
  console.log(
    JSON.stringify(
      {
        programId: pid.toBase58(),
        mint: mint.toBase58(),
        curve: curve.toBase58(),
        baseMint: NATIVE_MINT.toBase58(),
        ticker,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
