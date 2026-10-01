/**
 * Graduation → Meteora DLMM migration → post-bond fee claim, against the
 * **real** `lb_clmm` program cloned from devnet onto a local validator.
 *
 * Not part of `anchor test` (whose validator still clones Raydium — see
 * `Anchor.toml`). Run it by hand:
 *
 *   solana-test-validator --reset --rpc-port 8999 --url https://api.devnet.solana.com \
 *     --clone-upgradeable-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo \
 *     --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
 *     --clone 7FEVd6LpxTyKuBpLXYJVAGPhZpE6KrPBLdtx7sBbZ97z \
 *     --bpf-program FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg target/deploy/launchpad.so
 *   solana airdrop 500 -u http://127.0.0.1:8999
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8999 ANCHOR_WALLET=~/.config/solana/id.json \
 *     pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/meteora-graduation.ts
 *
 * What it pins:
 *   1. `graduate` on an exhausted curve, then the two migration steps signed
 *      by the migration authority; each step refuses to run twice.
 *   2. The position DLMM opened: owner = escrow PDA (a key only the program
 *      signs for), default fee owner (= owner), no operator. DLMM's operator
 *      timelock is not available to us — `initialize_position_by_operator`
 *      is whitelisted (`UnauthorizedAccess` for every caller on both pair
 *      types, probed on this validator) — so permanence is "no instruction
 *      of the launchpad removes liquidity", the same trust as the EVM UUPS.
 *   3. Real swaps against the pool accrue fees; `claim_dex_fees` (anyone)
 *      routes them through the curve's split and the second call has
 *      nothing to claim.
 */
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
} from '@solana/spl-token';
import { assert } from 'chai';
import type { Launchpad } from '../target/types/launchpad';

const enc = (s: string) => Buffer.from(s, 'utf8');
const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const PRESET = new PublicKey('7FEVd6LpxTyKuBpLXYJVAGPhZpE6KrPBLdtx7sBbZ97z');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// PositionV2 offsets (lb_clmm IDL 0.12.0), mirrored from `constants.rs`.
const POS_LB_PAIR = 8;
const POS_OWNER = 40;
const POS_OPERATOR = 7960;
const POS_LOCK_RELEASE = 7992;
const POS_FEE_OWNER = 8001;
const LB_PAIR_ACTIVE_ID = 76;

const i32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};
const i64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
};

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

/** 15 / 10 / 6 / 69, remainder to the bucket — `math.rs::split_fee`. */
function splitFee(fee: bigint) {
  const protocol = (fee * 1500n) / 10_000n;
  const ops = (fee * 1000n) / 10_000n;
  const burn = (fee * 600n) / 10_000n;
  return { protocol, ops, burn, bucket: fee - protocol - ops - burn };
}

async function rejects(p: Promise<unknown>, match: RegExp) {
  try {
    await p;
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${JSON.stringify((e as { logs?: string[] }).logs ?? [])}` : String(e);
    assert.match(msg, match, `expected ${match}, got: ${msg}`);
    return;
  }
  assert.fail(`expected rejection ${match}`);
}

describe('graduation → Meteora DLMM → claim_dex_fees (real lb_clmm)', () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.Launchpad as Program<Launchpad>;
  const conn = provider.connection;
  const pid = program.programId;

  const admin = Keypair.generate();
  const protocolCold = Keypair.generate();
  const opsCold = Keypair.generate();
  const migrationAuth = Keypair.generate();
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  const cranker = Keypair.generate();

  let baseMint: PublicKey;
  let traderBase: PublicKey;

  const globalPda = PublicKey.findProgramAddressSync([enc('global')], pid)[0];
  const paramsPda = PublicKey.findProgramAddressSync([enc('params')], pid)[0];
  const oraclePdaFor = (m: PublicKey) =>
    PublicKey.findProgramAddressSync([enc('oracle'), m.toBuffer()], pid)[0];
  const vault = (seed: string, key: PublicKey) =>
    PublicKey.findProgramAddressSync([enc(seed), key.toBuffer()], pid)[0];
  const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;

  async function fund(kp: Keypair, sol = 20) {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }

  function coinAccounts(mint: PublicKey) {
    return {
      curve: vault('curve', mint),
      curveTokenVault: vault('curve_token', mint),
      curveBaseVault: vault('curve_base', mint),
      lpVault: vault('lp_vault', mint),
      bucketBaseVault: vault('bucket_base', mint),
      bucketTokenVault: vault('bucket_token', mint),
      stakeEscrow: vault('stake_escrow', mint),
      escrow: vault('meteora_escrow', mint),
    };
  }
  const protocolVault = () => vault('protocol_vault', baseMint);
  const opsVault = () => vault('ops_vault', baseMint);
  const burnVault = () => vault('burn_vault', baseMint);

  /** DLMM-side addresses for a coin. */
  function dlmm(mint: PublicKey) {
    const [x, y] = sortMints(mint, baseMint);
    const lbPair = PublicKey.findProgramAddressSync(
      [PRESET.toBuffer(), x.toBuffer(), y.toBuffer()],
      DLMM,
    )[0];
    const reserveX = PublicKey.findProgramAddressSync([lbPair.toBuffer(), x.toBuffer()], DLMM)[0];
    const reserveY = PublicKey.findProgramAddressSync([lbPair.toBuffer(), y.toBuffer()], DLMM)[0];
    const oracle = PublicKey.findProgramAddressSync([enc('oracle'), lbPair.toBuffer()], DLMM)[0];
    const eventAuthority = PublicKey.findProgramAddressSync([enc('__event_authority')], DLMM)[0];
    return { x, y, lbPair, reserveX, reserveY, oracle, eventAuthority };
  }
  const binArrayPda = (lbPair: PublicKey, index: bigint) =>
    PublicKey.findProgramAddressSync([enc('bin_array'), lbPair.toBuffer(), i64le(index)], DLMM)[0];
  const positionPda = (lbPair: PublicKey, base: PublicKey, lower: number, width: number) =>
    PublicKey.findProgramAddressSync(
      [enc('position'), lbPair.toBuffer(), base.toBuffer(), i32le(lower), i32le(width)],
      DLMM,
    )[0];
  const binArrayIndex = (binId: number) => BigInt(Math.floor(binId / 70));

  let launchSalt = 0;
  async function launch(ticker: string) {
    const salt = new BN(++launchSalt);
    const saltBuf = Buffer.alloc(8);
    saltBuf.writeBigUInt64LE(BigInt(salt.toString()));
    const mint = PublicKey.findProgramAddressSync(
      [enc('mint'), creator.publicKey.toBuffer(), saltBuf],
      pid,
    )[0];
    const a = coinAccounts(mint);
    await program.methods
      .createToken(`${ticker} coin`, ticker, `https://ston.kz/t/${ticker}`, new BN(1_000_000_000), 300, false, salt)
      .accountsPartial({
        global: globalPda,
        mint,
        curve: a.curve,
        baseMint,
        oracle: oraclePdaFor(baseMint),
        curveTokenVault: a.curveTokenVault,
        lpVault: a.lpVault,
        curveBaseVault: a.curveBaseVault,
        bucketBaseVault: a.bucketBaseVault,
        bucketTokenVault: a.bucketTokenVault,
        stakeEscrow: a.stakeEscrow,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        params: paramsPda,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .signers([creator])
      .rpc();
    return { mint, ...a };
  }

  async function buy(coin: ReturnType<typeof coinAccounts> & { mint: PublicKey }, amount: bigint) {
    const traderToken = getAssociatedTokenAddressSync(coin.mint, trader.publicKey);
    await program.methods
      .buy(new BN(amount.toString()), new BN(0))
      .accountsPartial({
        global: globalPda,
        curve: coin.curve,
        mint: coin.mint,
        baseMint,
        curveBaseVault: coin.curveBaseVault,
        curveTokenVault: coin.curveTokenVault,
        bucketBaseVault: coin.bucketBaseVault,
        bucketTokenVault: coin.bucketTokenVault,
        protocolVault: protocolVault(),
        opsVault: opsVault(),
        burnVault: burnVault(),
        trader: trader.publicKey,
        traderBaseAccount: traderBase,
        traderTokenAccount: traderToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        params: paramsPda,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(
          trader.publicKey,
          traderToken,
          trader.publicKey,
          coin.mint,
        ),
      ])
      .signers([trader])
      .rpc();
  }

  async function graduate(coin: ReturnType<typeof coinAccounts> & { mint: PublicKey }) {
    await program.methods
      .graduate()
      .accountsPartial({
        global: globalPda,
        curve: coin.curve,
        mint: coin.mint,
        baseMint,
        oracle: oraclePdaFor(baseMint),
        curveTokenVault: coin.curveTokenVault,
        caller: cranker.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        params: paramsPda,
      })
      .signers([cranker])
      .rpc();
  }

  async function migrateCreatePool(coin: ReturnType<typeof coinAccounts> & { mint: PublicKey }) {
    const d = dlmm(coin.mint);
    return program.methods
      .migrateCreatePool()
      .accountsPartial({
        global: globalPda,
        curve: coin.curve,
        mint: coin.mint,
        baseMint,
        dexProgram: DLMM,
        presetParameter: PRESET,
        lbPair: d.lbPair,
        binArrayBitmapExtension: DLMM,
        reserveX: d.reserveX,
        reserveY: d.reserveY,
        oracle: d.oracle,
        tokenBadgeX: DLMM,
        tokenBadgeY: DLMM,
        eventAuthority: d.eventAuthority,
        migrationAuthority: migrationAuth.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([migrationAuth])
      .rpc();
  }

  async function activeId(lbPair: PublicKey): Promise<number> {
    const ai = await conn.getAccountInfo(lbPair);
    if (!ai) throw new Error('lb pair missing');
    return ai.data.readInt32LE(LB_PAIR_ACTIVE_ID);
  }

  async function migrateSeed(coin: ReturnType<typeof coinAccounts> & { mint: PublicKey }) {
    const d = dlmm(coin.mint);
    const active = await activeId(d.lbPair);
    const binArray = binArrayPda(d.lbPair, binArrayIndex(active));
    const position = positionPda(d.lbPair, coin.escrow, active, 1);
    const escrowBase = getAssociatedTokenAddressSync(baseMint, coin.escrow, true);
    const escrowToken = getAssociatedTokenAddressSync(coin.mint, coin.escrow, true);
    const [userTokenX, userTokenY] = d.x.equals(coin.mint)
      ? [escrowToken, escrowBase]
      : [escrowBase, escrowToken];
    const sig = await program.methods
      .migrateSeedLiquidity()
      .accountsPartial({
        global: globalPda,
        curve: coin.curve,
        mint: coin.mint,
        baseMint,
        curveBaseVault: coin.curveBaseVault,
        lpVault: coin.lpVault,
        escrow: coin.escrow,
        escrowBase,
        escrowToken,
        lbPair: d.lbPair,
        binArrayBitmapExtension: DLMM,
        reserveX: d.reserveX,
        reserveY: d.reserveY,
        binArray,
        position,
        eventAuthority: d.eventAuthority,
        dexProgram: DLMM,
        userTokenX,
        userTokenY,
        migrationAuthority: migrationAuth.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          migrationAuth.publicKey,
          escrowBase,
          coin.escrow,
          baseMint,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          migrationAuth.publicKey,
          escrowToken,
          coin.escrow,
          coin.mint,
        ),
      ])
      .signers([migrationAuth])
      .rpc();
    return { sig, active, binArray, position, escrowBase, escrowToken };
  }

  /** `swap2(amount_in, min_amount_out, { slices: [] })` by the trader, bin arrays as remaining accounts. */
  async function swap(
    coin: { mint: PublicKey },
    tokenIn: PublicKey,
    amountIn: bigint,
    binArrays: PublicKey[],
  ) {
    const d = dlmm(coin.mint);
    const tokenOut = tokenIn.equals(baseMint) ? coin.mint : baseMint;
    const userIn = getAssociatedTokenAddressSync(tokenIn, trader.publicKey);
    const userOut = getAssociatedTokenAddressSync(tokenOut, trader.publicKey);
    const data = Buffer.concat([
      Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]),
      i64le(amountIn),
      i64le(0n),
      Buffer.from([0, 0, 0, 0]),
    ]);
    const keys = [
      { pubkey: d.lbPair, isSigner: false, isWritable: true },
      { pubkey: DLMM, isSigner: false, isWritable: false }, // bitmap extension: absent
      { pubkey: d.reserveX, isSigner: false, isWritable: true },
      { pubkey: d.reserveY, isSigner: false, isWritable: true },
      { pubkey: userIn, isSigner: false, isWritable: true },
      { pubkey: userOut, isSigner: false, isWritable: true },
      { pubkey: d.x, isSigner: false, isWritable: false },
      { pubkey: d.y, isSigner: false, isWritable: false },
      { pubkey: d.oracle, isSigner: false, isWritable: true },
      { pubkey: DLMM, isSigner: false, isWritable: false }, // host fee: absent
      { pubkey: trader.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MEMO, isSigner: false, isWritable: false },
      { pubkey: d.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: DLMM, isSigner: false, isWritable: false },
      ...binArrays.map((b) => ({ pubkey: b, isSigner: false, isWritable: true })),
    ];
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, userOut, trader.publicKey, tokenOut),
      new TransactionInstruction({ programId: DLMM, keys, data }),
    );
    return provider.sendAndConfirm(tx, [trader]);
  }

  async function claimDexFees(
    coin: ReturnType<typeof coinAccounts> & { mint: PublicKey },
    position: PublicKey,
    binArray: PublicKey,
  ) {
    const d = dlmm(coin.mint);
    return program.methods
      .claimDexFees()
      .accountsPartial({
        global: globalPda,
        curve: coin.curve,
        mint: coin.mint,
        baseMint,
        bucketBaseVault: coin.bucketBaseVault,
        bucketTokenVault: coin.bucketTokenVault,
        protocolVault: protocolVault(),
        opsVault: opsVault(),
        burnVault: burnVault(),
        escrow: coin.escrow,
        escrowBase: getAssociatedTokenAddressSync(baseMint, coin.escrow, true),
        escrowToken: getAssociatedTokenAddressSync(coin.mint, coin.escrow, true),
        lbPair: d.lbPair,
        position,
        binArrayLower: binArray,
        binArrayUpper: binArray,
        reserveX: d.reserveX,
        reserveY: d.reserveY,
        eventAuthority: d.eventAuthority,
        dexProgram: DLMM,
        memoProgram: MEMO,
        caller: cranker.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        params: paramsPda,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .signers([cranker])
      .rpc();
  }

  before(async () => {
    for (const kp of [admin, migrationAuth, creator, trader, cranker]) await fund(kp, 50);
    baseMint = await createMint(conn, admin, admin.publicKey, null, 6);

    await program.methods
      .initialize(
        admin.publicKey,
        protocolCold.publicKey,
        opsCold.publicKey,
        admin.publicKey,
        migrationAuth.publicKey,
      )
      .accountsPartial({ global: globalPda, payer: admin.publicKey, systemProgram: SystemProgram.programId })
      .signers([admin])
      .rpc();
    await program.methods
      .setMeteoraConfig(DLMM, PRESET)
      .accountsPartial({ global: globalPda, admin: admin.publicKey })
      .signers([admin])
      .rpc();
    await program.methods
      .pushPrice(new BN(1_000_000), new BN(100))
      .accountsPartial({
        global: globalPda,
        oracle: oraclePdaFor(baseMint),
        baseMint,
        oracleAuthority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    await program.methods
      .initTreasury()
      .accountsPartial({
        global: globalPda,
        baseMint,
        protocolVault: protocolVault(),
        opsVault: opsVault(),
        burnVault: burnVault(),
        payer: admin.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    traderBase = await createAssociatedTokenAccount(conn, trader, baseMint, trader.publicKey);
    await mintTo(conn, admin, baseMint, traderBase, admin, 5_000_000n * 1_000_000n);
  });

  it('graduates, migrates into an escrow-held DLMM position and claims its fees into the split', async () => {
    const coin = await launch('BOND');
    await buy(coin, 100_000n * 1_000_000n); // far more than the curve absorbs: exhausts it
    let c = await program.account.curve.fetch(coin.curve);
    assert.isTrue(c.complete, 'curve exhausted');
    const raise = BigInt(c.realBase.toString());
    const escrowTokens = BigInt(c.lpReserve.toString());

    // Migration before graduation fails closed.
    await rejects(migrateCreatePool(coin), /NotGraduable/);

    await graduate(coin);
    c = await program.account.curve.fetch(coin.curve);
    assert.isTrue(c.graduated);

    // Step 1: the pool, at the curve's closing price.
    await migrateCreatePool(coin);
    c = await program.account.curve.fetch(coin.curve);
    const d = dlmm(coin.mint);
    assert.equal(c.dexPool.toBase58(), d.lbPair.toBase58(), 'pool recorded');
    await rejects(migrateCreatePool(coin), /PoolAlreadyExists/);

    // Step 2: seed + lock.
    const seeded = await migrateSeed(coin);
    c = await program.account.curve.fetch(coin.curve);
    assert.isTrue(c.migrated);
    assert.equal(c.realBase.toString(), '0');
    assert.equal(c.lpReserve.toString(), '0');
    await rejects(migrateSeed(coin), /AlreadyMigrated/);

    // Reserves left the curve vaults for the pool; the escrow keeps nothing.
    assert.equal(await bal(coin.curveBaseVault), 0n);
    assert.equal(await bal(coin.lpVault), 0n);
    assert.equal(await bal(seeded.escrowBase), 0n, 'escrow holds no base');
    assert.equal(await bal(seeded.escrowToken), 0n, 'escrow holds no tokens');
    const [rx, ry] = [await bal(d.reserveX), await bal(d.reserveY)];
    const poolBase = d.x.equals(baseMint) ? rx : ry;
    const poolTokens = d.x.equals(coin.mint) ? rx : ry;
    assert.equal(poolBase, raise, 'the whole raise is in the pool');
    assert.equal(poolTokens, escrowTokens, 'so is the 20% escrow');

    // The position: the escrow PDA owns it and (by default) its fees; there is
    // no operator. Its rent came from the authority's buffer, refunded net.
    const pos = await conn.getAccountInfo(seeded.position);
    assert.isNotNull(pos);
    const pk = (o: number) => new PublicKey(pos!.data.subarray(o, o + 32)).toBase58();
    assert.equal(pk(POS_LB_PAIR), d.lbPair.toBase58());
    assert.equal(pk(POS_OWNER), coin.escrow.toBase58(), 'owner = escrow PDA');
    assert.equal(pk(POS_FEE_OWNER), PublicKey.default.toBase58(), 'fee owner defaults to the owner (the escrow)');
    assert.equal(pk(POS_OPERATOR), PublicKey.default.toBase58(), 'no operator');
    assert.equal(pos!.data.readBigUInt64LE(POS_LOCK_RELEASE), 0n, 'no DLMM timelock (unavailable to non-whitelisted operators)');
    assert.equal(await conn.getBalance(coin.escrow), 0, 'the unspent rent buffer went back to the authority');

    // Nothing to claim yet.
    await rejects(claimDexFees(coin, seeded.position, seeded.binArray), /NothingToClaim/);

    // Trade against the pool both ways so fees accrue on both sides.
    const traderToken = getAssociatedTokenAddressSync(coin.mint, trader.publicKey);
    const tokensBefore = await bal(traderToken);
    await swap(coin, baseMint, 200n * 1_000_000n, [seeded.binArray]);
    const bought = (await bal(traderToken)) - tokensBefore;
    assert.isTrue(bought > 0n, 'bought tokens from the pool');
    await swap(coin, coin.mint, bought / 2n, [seeded.binArray]);

    // Claim: the split lands in the same vaults a curve fill pays.
    const before = {
      protocol: await bal(protocolVault()),
      ops: await bal(opsVault()),
      burn: await bal(burnVault()),
      bucket: await bal(coin.bucketBaseVault),
      bucketTok: await bal(coin.bucketTokenVault),
      supply: (await getMint(conn, coin.mint)).supply,
      creatorBase: BigInt(c.creatorClaimableBase.toString()),
      creatorTok: BigInt(c.creatorClaimableToken.toString()),
    };
    await claimDexFees(coin, seeded.position, seeded.binArray);
    const after = {
      protocol: await bal(protocolVault()),
      ops: await bal(opsVault()),
      burn: await bal(burnVault()),
      bucket: await bal(coin.bucketBaseVault),
      bucketTok: await bal(coin.bucketTokenVault),
      supply: (await getMint(conn, coin.mint)).supply,
    };
    c = await program.account.curve.fetch(coin.curve);

    // Which sides carry fees depends on the pair's `collect_fee_mode`
    // (StaticParameters byte 36: 0 = both tokens, 1 = quote/Y only) and on
    // which mint sorted as Y — so assert the split on whichever side accrued
    // and require that at least one did.
    const lbPairData = (await conn.getAccountInfo(d.lbPair))!.data;
    const collectFeeMode = lbPairData.readUInt8(36);
    console.log(`      collect_fee_mode=${collectFeeMode} tokenIsX=${d.x.equals(coin.mint)}`);

    const feeBase =
      after.protocol - before.protocol +
      (after.ops - before.ops) +
      (after.burn - before.burn) +
      (after.bucket - before.bucket);
    const tokBucket = after.bucketTok - before.bucketTok;
    const tokBurned = before.supply - after.supply;
    const feeTok = tokBucket + tokBurned;
    assert.isTrue(feeBase > 0n || feeTok > 0n, 'fees were claimed on at least one side');
    if (collectFeeMode === 0) {
      assert.isTrue(feeBase > 0n && feeTok > 0n, 'both-token mode: both sides accrued');
    }
    if (feeBase > 0n) {
      const want = splitFee(feeBase);
      assert.equal(after.protocol - before.protocol, want.protocol, '15% protocol');
      assert.equal(after.ops - before.ops, want.ops, '10% buyback');
      assert.equal(after.burn - before.burn, want.burn, '6% crate fund');
      assert.equal(after.bucket - before.bucket, want.bucket, '69% bucket');
      // No stakers, so the whole bucket is the creator's.
      assert.equal(BigInt(c.creatorClaimableBase.toString()) - before.creatorBase, want.bucket);
    }
    if (feeTok > 0n) {
      const wantTok = splitFee(feeTok);
      assert.equal(tokBucket, wantTok.bucket, '69% of token fees to the bucket');
      assert.equal(tokBurned, wantTok.protocol + wantTok.ops + wantTok.burn, 'the treasury legs are burned');
      assert.equal(BigInt(c.creatorClaimableToken.toString()) - before.creatorTok, wantTok.bucket);
    }

    // Escrow keeps nothing, the position is still locked, and a second claim is empty.
    assert.equal(await bal(seeded.escrowBase), 0n);
    assert.equal(await bal(seeded.escrowToken), 0n);
    const pos2 = await conn.getAccountInfo(seeded.position);
    assert.equal(pk(POS_OWNER), new PublicKey(pos2!.data.subarray(POS_OWNER, POS_OWNER + 32)).toBase58(), 'still escrow-owned');
    await rejects(claimDexFees(coin, seeded.position, seeded.binArray), /NothingToClaim/);
  });

  it('refuses to claim through a position that is not the coin’s own', async () => {
    const a = await launch('ONE');
    const b = await launch('TWO');
    for (const coin of [a, b]) {
      await buy(coin, 100_000n * 1_000_000n);
      await graduate(coin);
      await migrateCreatePool(coin);
    }
    const sa = await migrateSeed(a);
    await migrateSeed(b);
    // b's curve with a's position: wrong pool → PoolNotCreated (address constraint) or PositionMismatch.
    await rejects(claimDexFees(b, sa.position, sa.binArray), /PositionMismatch|ConstraintAddress|PoolNotCreated/);
  });
});
