/**
 * Integration suite against a local validator.
 *
 * The host-side suite in `src/tests.rs` proves the arithmetic. This one proves
 * the *settlement*: that the atoms actually land in the accounts the split says
 * they should, that authorities are revoked, that locks hold, and that the
 * paths which must not exist really do not exist.
 */
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { assert } from 'chai';

import type { Launchpad } from '../target/types/launchpad';

const enc = (s: string) => Buffer.from(s, 'utf8');

/** Assert a call fails, and fails for the reason we meant. */
async function rejects(p: Promise<unknown> | (() => Promise<unknown>), match: RegExp) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    const msg = `${(e as Error).message ?? ''}\n${JSON.stringify((e as { logs?: unknown }).logs ?? [])}`;
    assert.match(msg, match, `rejected, but not with ${match}`);
    return;
  }
  assert.fail(`expected a rejection matching ${match}`);
}

/* ------------------------------------------------------------------ helpers */

/** Mirrors `split_fee` in math.rs. The creator bucket is the remainder. */
function splitFee(fee: bigint) {
  const protocol = (fee * 2000n) / 10000n;
  const ops = (fee * 1000n) / 10000n;
  return { protocol, ops, creatorBucket: fee - protocol - ops };
}

/** Mirrors `split_creator_bucket`. */
function splitBucket(bucket: bigint, eligibleStaked: bigint, circulating: bigint) {
  if (bucket === 0n || eligibleStaked === 0n || circulating === 0n) {
    return { creator: bucket, stakers: 0n };
  }
  const half = bucket / 2n;
  let stakers = (bucket * eligibleStaked) / (circulating * 2n);
  if (stakers > half) stakers = half;
  return { creator: bucket - stakers, stakers };
}

describe('stonkz launchpad', () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.Launchpad as Program<Launchpad>;
  const conn = provider.connection;
  const pid = program.programId;

  const admin = Keypair.generate();
  const protocolCold = Keypair.generate();
  const opsCold = Keypair.generate();
  const oracleAuth = Keypair.generate();
  const migrationAuth = Keypair.generate();
  const creator = Keypair.generate();
  const trader = Keypair.generate();
  const staker = Keypair.generate();

  let baseMint: PublicKey;
  const BASE_DECIMALS = 6;
  /** $1.00, 1e6 scale — a USDC-like base. */
  const BASE_PRICE = new BN(1_000_000);

  const globalPda = PublicKey.findProgramAddressSync([enc('global')], pid)[0];
  const oraclePdaFor = (m: PublicKey) =>
    PublicKey.findProgramAddressSync([enc('oracle'), m.toBuffer()], pid)[0];
  const vault = (seed: string, key: PublicKey) =>
    PublicKey.findProgramAddressSync([enc(seed), key.toBuffer()], pid)[0];

  const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;

  async function fund(kp: Keypair, sol = 20) {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }

  /** Everything a launched coin needs, resolved once. */
  function coinAccounts(mint: PublicKey) {
    return {
      curve: vault('curve', mint),
      curveTokenVault: vault('curve_token', mint),
      curveBaseVault: vault('curve_base', mint),
      lpVault: vault('lp_vault', mint),
      bucketBaseVault: vault('bucket_base', mint),
      bucketTokenVault: vault('bucket_token', mint),
      stakeEscrow: vault('stake_escrow', mint),
    };
  }

  const protocolVault = () => vault('protocol_vault', baseMint);
  const opsVault = () => vault('ops_vault', baseMint);

  async function launch(
    ticker: string,
    opts: { feeBps?: number; cashback?: boolean; supply?: number } = {},
  ) {
    const feeBps = opts.feeBps ?? 300;
    const cashback = opts.cashback ?? false;
    const supply = new BN(opts.supply ?? 1_000_000_000);
    const mint = PublicKey.findProgramAddressSync([enc('mint'), enc(ticker)], pid)[0];
    const a = coinAccounts(mint);

    await program.methods
      .createToken(`${ticker} coin`, ticker, `https://ston.kz/t/${ticker}`, supply, feeBps, cashback)
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
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .signers([creator])
      .rpc();

    return { mint, ...a };
  }

  /** Buy, and return the settled numbers read straight off the accounts. */
  async function buy(
    coin: { mint: PublicKey } & ReturnType<typeof coinAccounts>,
    who: Keypair,
    whoBase: PublicKey,
    whoToken: PublicKey,
    amount: bigint,
    minOut = 0n,
  ) {
    const before = {
      protocol: await bal(protocolVault()),
      ops: await bal(opsVault()),
      bucket: await bal(coin.bucketBaseVault),
      bucketToken: await bal(coin.bucketTokenVault),
      curveBase: await bal(coin.curveBaseVault),
      userBase: await bal(whoBase),
      userToken: await bal(whoToken),
    };

    await program.methods
      .buy(new BN(amount.toString()), new BN(minOut.toString()))
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
        trader: who.publicKey,
        traderBaseAccount: whoBase,
        traderTokenAccount: whoToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();

    const after = {
      protocol: await bal(protocolVault()),
      ops: await bal(opsVault()),
      bucket: await bal(coin.bucketBaseVault),
      bucketToken: await bal(coin.bucketTokenVault),
      curveBase: await bal(coin.curveBaseVault),
      userBase: await bal(whoBase),
      userToken: await bal(whoToken),
    };

    return {
      protocol: after.protocol - before.protocol,
      ops: after.ops - before.ops,
      bucket: after.bucket - before.bucket,
      bucketToken: after.bucketToken - before.bucketToken,
      curveBase: after.curveBase - before.curveBase,
      spent: before.userBase - after.userBase,
      received: after.userToken - before.userToken,
    };
  }

  async function sell(
    coin: { mint: PublicKey } & ReturnType<typeof coinAccounts>,
    who: Keypair,
    whoBase: PublicKey,
    whoToken: PublicKey,
    amount: bigint,
    minOut = 0n,
  ) {
    const before = {
      protocol: await bal(protocolVault()),
      ops: await bal(opsVault()),
      bucket: await bal(coin.bucketBaseVault),
      userBase: await bal(whoBase),
    };

    await program.methods
      .sell(new BN(amount.toString()), new BN(minOut.toString()))
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
        trader: who.publicKey,
        traderBaseAccount: whoBase,
        traderTokenAccount: whoToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();

    return {
      protocol: (await bal(protocolVault())) - before.protocol,
      ops: (await bal(opsVault())) - before.ops,
      bucket: (await bal(coin.bucketBaseVault)) - before.bucket,
      received: (await bal(whoBase)) - before.userBase,
    };
  }

  let creatorBase: PublicKey;
  let traderBase: PublicKey;
  let stakerBase: PublicKey;

  before(async () => {
    for (const kp of [admin, creator, trader, staker, oracleAuth, migrationAuth]) {
      await fund(kp);
    }

    baseMint = await createMint(
      conn,
      admin,
      admin.publicKey,
      null,
      BASE_DECIMALS,
      undefined,
      { commitment: 'confirmed' },
      TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initialize(
        admin.publicKey,
        protocolCold.publicKey,
        opsCold.publicKey,
        oracleAuth.publicKey,
        migrationAuth.publicKey,
      )
      .accountsPartial({ global: globalPda, payer: admin.publicKey, systemProgram: SystemProgram.programId })
      .signers([admin])
      .rpc();

    await program.methods
      .pushPrice(BASE_PRICE, new BN(100))
      .accountsPartial({
        global: globalPda,
        oracle: oraclePdaFor(baseMint),
        baseMint,
        oracleAuthority: oracleAuth.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracleAuth])
      .rpc();

    await program.methods
      .initTreasury()
      .accountsPartial({
        global: globalPda,
        baseMint,
        protocolVault: protocolVault(),
        opsVault: opsVault(),
        payer: admin.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    creatorBase = await createAssociatedTokenAccount(conn, creator, baseMint, creator.publicKey);
    traderBase = await createAssociatedTokenAccount(conn, trader, baseMint, trader.publicKey);
    stakerBase = await createAssociatedTokenAccount(conn, staker, baseMint, staker.publicKey);
    for (const acct of [creatorBase, traderBase, stakerBase]) {
      // 5,000,000 base tokens — enough to graduate a curve several times over.
      await mintTo(conn, admin, baseMint, acct, admin, 5_000_000n * 1_000_000n);
    }
  });

  /* ------------------------------------------------------------- 2.A launch */

  describe('create_token', () => {
    it('mints a fixed supply, revokes both authorities and seeds the curve', async () => {
      const coin = await launch('WOJAK');
      const mintInfo = await getMint(conn, coin.mint);

      assert.isNull(mintInfo.mintAuthority, 'mint authority must be revoked');
      assert.isNull(mintInfo.freezeAuthority, 'freeze authority must be revoked');

      const supplyAtoms = 1_000_000_000n * 1_000_000n;
      assert.equal(mintInfo.supply, supplyAtoms, 'entire supply minted up front');
      assert.equal(await bal(coin.curveTokenVault), (supplyAtoms / 5n) * 4n, '80% sellable');
      assert.equal(await bal(coin.lpVault), supplyAtoms / 5n, '20% escrowed for the pool');

      const c = await program.account.curve.fetch(coin.curve);
      assert.equal(c.creator.toBase58(), creator.publicKey.toBase58());
      assert.equal(c.feeBps, 300);
      // curve.json: VT0 = 16/15 of supply, VB0 = grad_mcap_base / 15.
      assert.equal(c.virtualToken.toString(), ((supplyAtoms * 16n) / 15n).toString());
      assert.equal(c.gradMcapBase.toString(), '69000000000');
      assert.equal(c.virtualBase.toString(), '4600000000');
      assert.equal(c.realToken.toString(), ((supplyAtoms / 5n) * 4n).toString());
    });

    it('rejects a duplicate ticker, a bad fee and an unlisted supply', async () => {
      await rejects(
launch('WOJAK'), /already in use|custom program error/i);
      await rejects(
launch('BADFEE', { feeBps: 501 }), /FeeOutOfRange/);
      await rejects(
launch('BADFE2', { feeBps: 99 }), /FeeOutOfRange/);
      await rejects(
launch('BADSUP', { supply: 12345 }), /UnsupportedSupply/);
      await rejects(
launch('lower'), /InvalidTicker|Seeds/);
    });
  });

  /* --------------------------------------------- 2.A gate: the split settles */

  describe('fee split settles 20 / 10 / 70 to the atom', () => {
    it('holds across random fill sizes and every fee in 100-500 bps', async () => {
      // Deterministic sizes, spread over four orders of magnitude.
      const sizes = [1_000n, 7_919n, 250_001n, 3_333_333n, 40_000_000n, 999_999_999n];
      const feeBpsCases = [100, 137, 250, 419, 500];

      for (const feeBps of feeBpsCases) {
        const coin = await launch(`FEE${feeBps}`, { feeBps });
        const traderToken = await createAssociatedTokenAccount(
          conn,
          trader,
          coin.mint,
          trader.publicKey,
        );

        for (const size of sizes) {
          const d = await buy(coin, trader, traderBase, traderToken, size);

          const fee = d.spent - d.curveBase;
          const want = splitFee(fee);
          assert.equal(d.protocol, want.protocol, `protocol, ${feeBps}bps size ${size}`);
          assert.equal(d.ops, want.ops, `ops, ${feeBps}bps size ${size}`);
          assert.equal(d.bucket, want.creatorBucket, `bucket, ${feeBps}bps size ${size}`);
          assert.equal(
            d.protocol + d.ops + d.bucket,
            fee,
            `the three vaults must reconstruct the fee exactly`,
          );
          // And the fee itself is the floor of the nominal rate.
          assert.equal(fee, (d.spent * BigInt(feeBps)) / 10000n, 'fee is floor(gross*bps/1e4)');
          assert.isTrue(d.received > 0n);
        }

        // Now unwind, and prove sells split identically.
        const held = await bal(traderToken);
        for (const frac of [7n, 5n, 3n]) {
          const amt = held / frac;
          const s = await sell(coin, trader, traderBase, traderToken, amt);
          const fee = s.protocol + s.ops + s.bucket;
          const want = splitFee(fee);
          assert.equal(s.protocol, want.protocol, `sell protocol @ ${feeBps}`);
          assert.equal(s.ops, want.ops, `sell ops @ ${feeBps}`);
          assert.equal(s.bucket, want.creatorBucket, `sell bucket @ ${feeBps}`);
        }
      }
    });

    it('enforces min_out on the curve hop alone', async () => {
      const coin = await launch('SLIP');
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      const probe = await buy(coin, trader, traderBase, tt, 1_000_000n);
      // Ask for more than the same size just delivered at a now-worse price.
      await rejects(
buy(coin, trader, traderBase, tt, 1_000_000n, probe.received + 1n),
        /SlippageExceeded/,
      );
      await rejects(
sell(coin, trader, traderBase, tt, probe.received, 10n ** 18n),
        /SlippageExceeded/,
      );
    });
  });

  /* ------------------------------------------------------ 2.A creator claim */

  describe('claim_creator_fees', () => {
    it('drains only the creator ledger and leaves both treasuries untouched', async () => {
      const coin = await launch('CLAIM');
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      const ct = await createAssociatedTokenAccount(conn, creator, coin.mint, creator.publicKey);
      await buy(coin, trader, traderBase, tt, 50_000_000n);

      const c = await program.account.curve.fetch(coin.curve);
      const claimable = BigInt(c.creatorClaimableBase.toString());
      assert.isTrue(claimable > 0n);

      const protoBefore = await bal(protocolVault());
      const opsBefore = await bal(opsVault());
      const creatorBefore = await bal(creatorBase);

      await program.methods
        .claimCreatorFees()
        .accountsPartial({
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          bucketBaseVault: coin.bucketBaseVault,
          bucketTokenVault: coin.bucketTokenVault,
          creator: creator.publicKey,
          creatorBaseAccount: creatorBase,
          creatorTokenAccount: ct,
          tokenProgram: TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();

      assert.equal((await bal(creatorBase)) - creatorBefore, claimable);
      assert.equal(await bal(protocolVault()), protoBefore, 'protocol vault must not move');
      assert.equal(await bal(opsVault()), opsBefore, 'ops vault must not move');
      await rejects(
program.methods
          .claimCreatorFees()
          .accountsPartial({
            curve: coin.curve,
            mint: coin.mint,
            baseMint,
            bucketBaseVault: coin.bucketBaseVault,
            bucketTokenVault: coin.bucketTokenVault,
            creator: creator.publicKey,
            creatorBaseAccount: creatorBase,
            creatorTokenAccount: ct,
            tokenProgram: TOKEN_PROGRAM_ID,
            baseTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([creator])
          .rpc(),
        /NothingToClaim/,
      );
    });

    it('refuses a non-creator', async () => {
      const coin = await launch('NOTME');
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      await buy(coin, trader, traderBase, tt, 10_000_000n);
      await rejects(
program.methods
          .claimCreatorFees()
          .accountsPartial({
            curve: coin.curve,
            mint: coin.mint,
            baseMint,
            bucketBaseVault: coin.bucketBaseVault,
            bucketTokenVault: coin.bucketTokenVault,
            creator: trader.publicKey,
            creatorBaseAccount: traderBase,
            creatorTokenAccount: tt,
            tokenProgram: TOKEN_PROGRAM_ID,
            baseTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([trader])
          .rpc(),
        /NotCreator/,
      );
    });
  });

  /* --------------------------------------------------------- 4.A  cashback */

  describe('cashback window', () => {
    it('charges ~50% at t=0 and converts only the creator bucket to the token', async () => {
      const coin = await launch('CASH', { feeBps: 200, cashback: true });
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);

      const d = await buy(coin, trader, traderBase, tt, 100_000_000n);

      // The bucket went back through the curve, not into the bucket-base vault.
      assert.equal(d.bucket, 0n, 'no base accrued to the bucket during cashback');
      assert.isTrue(d.bucketToken > 0n, 'the bucket was converted to the token');

      // During cashback the bucket also enters the pool, so `spent - curveBase`
      // no longer isolates the fee. Read the ledger instead.
      const c = await program.account.curve.fetch(coin.curve);
      const protocolAccrued = BigInt(c.protocolAccrued.toString());
      const opsAccrued = BigInt(c.opsAccrued.toString());
      const bucketAccrued = BigInt(c.creatorBucketAccrued.toString());
      const feeTotal = protocolAccrued + opsAccrued + bucketAccrued;

      assert.equal(d.protocol, protocolAccrued);
      assert.equal(d.ops, opsAccrued);
      const want = splitFee(feeTotal);
      assert.equal(protocolAccrued, want.protocol, 'protocol keeps its 20% during cashback');
      assert.equal(opsAccrued, want.ops, 'ops keeps its 10% during cashback');
      assert.equal(bucketAccrued, want.creatorBucket);

      // ~50% of the trade was fee at t≈0. Allow a couple of seconds of decay.
      const rate = (feeTotal * 10000n) / d.spent;
      assert.isTrue(rate > 4900n && rate <= 5000n, `effective rate was ${rate} bps`);

      // The creator's claimable is denominated in the token, not base.
      assert.isTrue(BigInt(c.creatorClaimableToken.toString()) > 0n);
      assert.equal(BigInt(c.creatorClaimableBase.toString()), 0n);
    });

    it('has no instruction that can move cb_start', async () => {
      const coin = await launch('NOEXT', { cashback: true });
      const c = await program.account.curve.fetch(coin.curve);
      assert.isTrue(c.cbStart.toNumber() > 0);
      const movers = Object.keys(program.methods).filter((m) => /cb|cashback|window/i.test(m));
      assert.deepEqual(movers, [], `no instruction may touch the window, found ${movers}`);
    });

    it('a non-cashback coin charges the flat creator fee', async () => {
      const coin = await launch('FLAT', { feeBps: 250 });
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      const d = await buy(coin, trader, traderBase, tt, 10_000_000n);
      const fee = d.protocol + d.ops + d.bucket;
      assert.equal(fee, (d.spent * 250n) / 10000n);
    });
  });

  /* ---------------------------------------------------------- 4.B  staking */

  describe('memecoin staking', () => {
    it('refuses unstake before lock_until, and FLEX carries no pool weight', async () => {
      const coin = await launch('STAKE');
      const st = await createAssociatedTokenAccount(conn, staker, coin.mint, staker.publicKey);
      await buy(coin, staker, stakerBase, st, 200_000_000n);

      const position = PublicKey.findProgramAddressSync(
        [enc('stake'), coin.mint.toBuffer(), staker.publicKey.toBuffer()],
        pid,
      )[0];
      const stakeAccounts = {
        curve: coin.curve,
        mint: coin.mint,
        position,
        stakeEscrow: coin.stakeEscrow,
        owner: staker.publicKey,
        ownerTokenAccount: st,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      };

      const amount = (await bal(st)) / 4n;
      await program.methods
        .stake(new BN(amount.toString()), 7)
        .accountsPartial(stakeAccounts)
        .signers([staker])
        .rpc();

      const c1 = await program.account.curve.fetch(coin.curve);
      assert.equal(BigInt(c1.eligibleStaked.toString()), amount);
      // 7D weight is 1.25x.
      assert.equal(BigInt(c1.totalWeight.toString()), (amount * 12500n) / 10000n);

      await rejects(
program.methods
          .unstake(new BN(amount.toString()))
          .accountsPartial(stakeAccounts)
          .signers([staker])
          .rpc(),
        /StillLocked/,
      );

      await rejects(
program.methods.stake(new BN(1), 3).accountsPartial(stakeAccounts).signers([staker]).rpc(),
        /InvalidLockTerm/,
      );
      await rejects(
program.methods.stake(new BN(1), 30).accountsPartial(stakeAccounts).signers([staker]).rpc(),
        /LockTermMismatch/,
      );

      // A FLEX position on a second coin escrows but earns nothing.
      const flexCoin = await launch('FLEX');
      const ft = await createAssociatedTokenAccount(conn, staker, flexCoin.mint, staker.publicKey);
      await buy(flexCoin, staker, stakerBase, ft, 50_000_000n);
      const flexPos = PublicKey.findProgramAddressSync(
        [enc('stake'), flexCoin.mint.toBuffer(), staker.publicKey.toBuffer()],
        pid,
      )[0];
      const flexAmount = (await bal(ft)) / 2n;
      await program.methods
        .stake(new BN(flexAmount.toString()), 0)
        .accountsPartial({
          curve: flexCoin.curve,
          mint: flexCoin.mint,
          position: flexPos,
          stakeEscrow: flexCoin.stakeEscrow,
          owner: staker.publicKey,
          ownerTokenAccount: ft,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      const fc = await program.account.curve.fetch(flexCoin.curve);
      assert.equal(BigInt(fc.totalWeight.toString()), 0n, 'FLEX must carry zero pool weight');
      assert.equal(BigInt(fc.eligibleStaked.toString()), 0n, 'FLEX is excluded from poolFrac');
      assert.equal(BigInt(fc.flexStaked.toString()), flexAmount, 'but it is still escrowed');

      // Volume on the FLEX coin therefore routes the whole bucket to the creator.
      const before = BigInt(fc.creatorClaimableBase.toString());
      const flexTraderToken = await createAssociatedTokenAccount(
        conn,
        trader,
        flexCoin.mint,
        trader.publicKey,
      );
      await buy(flexCoin, trader, traderBase, flexTraderToken, 10_000_000n);
      const fc2 = await program.account.curve.fetch(flexCoin.curve);
      assert.equal(
        BigInt(fc2.stakerAccruedBase.toString()),
        0n,
        'a FLEX-only pool must accrue nothing',
      );
      assert.isTrue(BigInt(fc2.creatorClaimableBase.toString()) > before);
      // FLEX is unlocked immediately, so it can leave whenever.
      await program.methods
        .unstake(new BN(flexAmount.toString()))
        .accountsPartial({
          curve: flexCoin.curve,
          mint: flexCoin.mint,
          position: flexPos,
          stakeEscrow: flexCoin.stakeEscrow,
          owner: staker.publicKey,
          ownerTokenAccount: ft,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();
    });

    it('pays stakers out of the creator bucket only, capped at half of it', async () => {
      const coin = await launch('POOL');
      const st = await createAssociatedTokenAccount(conn, staker, coin.mint, staker.publicKey);
      await buy(coin, staker, stakerBase, st, 400_000_000n);

      const position = PublicKey.findProgramAddressSync(
        [enc('stake'), coin.mint.toBuffer(), staker.publicKey.toBuffer()],
        pid,
      )[0];
      // Stake everything the staker holds — the whole circulating supply, so
      // poolFrac pins at its 0.5 cap.
      const all = await bal(st);
      await program.methods
        .stake(new BN(all.toString()), 30)
        .accountsPartial({
          curve: coin.curve,
          mint: coin.mint,
          position,
          stakeEscrow: coin.stakeEscrow,
          owner: staker.publicKey,
          ownerTokenAccount: st,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      const before = await program.account.curve.fetch(coin.curve);
      const d = await buy(coin, trader, traderBase, tt, 80_000_000n);
      const after = await program.account.curve.fetch(coin.curve);

      const fee = d.protocol + d.ops + d.bucket;
      const want = splitFee(fee);
      const stakerDelta =
        BigInt(after.stakerAccruedBase.toString()) - BigInt(before.stakerAccruedBase.toString());
      const creatorDelta =
        BigInt(after.creatorClaimableBase.toString()) -
        BigInt(before.creatorClaimableBase.toString());

      // `circ` is read after the reserves move, and `eligible_staked` cannot
      // change on a buy, so the split is fully determined — assert the exact
      // atoms rather than a band.
      const circ = BigInt(after.tokensForSale.toString()) - BigInt(after.realToken.toString());
      const exact = splitBucket(
        want.creatorBucket,
        BigInt(before.eligibleStaked.toString()),
        circ === 0n ? 1n : circ,
      );
      assert.equal(stakerDelta, exact.stakers, 'staker share is exact');
      assert.equal(creatorDelta, exact.creator, 'creator share is exact');

      assert.equal(stakerDelta + creatorDelta, want.creatorBucket, 'the bucket is conserved');
      assert.isTrue(stakerDelta <= want.creatorBucket / 2n, 'stakers capped at half the bucket');
      // At the cap that is 35% of the fee, and never more.
      assert.isTrue(stakerDelta * 100n <= fee * 35n + 100n);
      assert.isTrue(creatorDelta * 100n + 100n >= fee * 35n);
      assert.equal(d.protocol, want.protocol, 'protocol untouched by the peel');
      assert.equal(d.ops, want.ops, 'ops untouched by the peel');

      // And the staker can actually take it out of the bucket vault.
      const beforeBase = await bal(stakerBase);
      await program.methods
        .claimStake()
        .accountsPartial({
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          position,
          bucketBaseVault: coin.bucketBaseVault,
          bucketTokenVault: coin.bucketTokenVault,
          owner: staker.publicKey,
          ownerBaseAccount: stakerBase,
          ownerTokenAccount: st,
          tokenProgram: TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([staker])
        .rpc();
      const paid = (await bal(stakerBase)) - beforeBase;
      assert.isTrue(paid > 0n && paid <= stakerDelta, `claimed ${paid} of ${stakerDelta}`);
    });

    it('keeps two coins pools separate', async () => {
      const a = await launch('COINA');
      const b = await launch('COINB');
      const at = await createAssociatedTokenAccount(conn, staker, a.mint, staker.publicKey);
      const bt = await createAssociatedTokenAccount(conn, staker, b.mint, staker.publicKey);
      await buy(a, staker, stakerBase, at, 60_000_000n);
      await buy(b, staker, stakerBase, bt, 60_000_000n);

      const posA = PublicKey.findProgramAddressSync(
        [enc('stake'), a.mint.toBuffer(), staker.publicKey.toBuffer()],
        pid,
      )[0];
      await program.methods
        .stake(new BN((await bal(at)).toString()), 30)
        .accountsPartial({
          curve: a.curve,
          mint: a.mint,
          position: posA,
          stakeEscrow: a.stakeEscrow,
          owner: staker.publicKey,
          ownerTokenAccount: at,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      // All the volume lands on B, which has no stakers.
      const tb = await createAssociatedTokenAccount(conn, trader, b.mint, trader.publicKey);
      await buy(b, trader, traderBase, tb, 90_000_000n);

      const ca = await program.account.curve.fetch(a.curve);
      const cb = await program.account.curve.fetch(b.curve);
      assert.equal(BigInt(ca.stakerAccruedBase.toString()), 0n, "B's volume must not pay A");
      assert.equal(BigInt(cb.stakerAccruedBase.toString()), 0n, 'B has no eligible stakers');
      assert.equal(BigInt(cb.totalWeight.toString()), 0n);
      assert.isTrue(BigInt(ca.totalWeight.toString()) > 0n);
    });
  });

  /* ------------------------------------------------------- 4.C  treasuries */

  describe('treasuries', () => {
    it('has no user-facing claim path to protocol or ops', () => {
      const names = Object.keys(program.methods);
      const claims = names.filter((n) => /claim/i.test(n));
      assert.deepEqual(
        claims.sort(),
        ['claimCreatorFees', 'claimStake'],
        `only creator and staker claims may exist, found ${claims}`,
      );
      assert.include(names, 'withdrawTreasury');
    });

    it('only the matching cold key may withdraw, and only when unpaused', async () => {
      const dest = await createAssociatedTokenAccount(conn, admin, baseMint, admin.publicKey);
      const held = await bal(protocolVault());
      assert.isTrue(held > 0n, 'fills should have funded the protocol vault');

      // Anchor renders a fieldless Rust enum as a one-key object.
      type Which = { protocol: Record<string, never> } | { ops: Record<string, never> };
      const call = (which: Which, signer: Keypair, v: PublicKey, amount: bigint) =>
        program.methods
          .withdrawTreasury(which, new BN(amount.toString()))
          .accountsPartial({
            global: globalPda,
            baseMint,
            vault: v,
            destination: dest,
            authority: signer.publicKey,
            baseTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([signer])
          .rpc();

      // The admin can pause but cannot spend.
      await rejects(
call({ protocol: {} }, admin, protocolVault(), 1n), /Unauthorized/);
      // The ops key cannot reach protocol money, or point itself at the other vault.
      await rejects(
call({ protocol: {} }, opsCold, protocolVault(), 1n), /Unauthorized/);
      await rejects(
call({ ops: {} }, opsCold, protocolVault(), 1n), /Unauthorized/);

      await fund(protocolCold, 1);
      await fund(opsCold, 1);
      const before = await bal(dest);
      await call({ protocol: {} }, protocolCold, protocolVault(), 1000n);
      assert.equal((await bal(dest)) - before, 1000n);

      // Pausing ops withdrawals stops ops money leaving...
      await program.methods
        .setPause(null, null, null, true)
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      await rejects(
call({ ops: {} }, opsCold, opsVault(), 1n), /WithdrawalsPaused/);

      // ...but trading and accrual carry on. That is the step-141 runbook.
      const coin = await launch('OPSPAUSE');
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      const d = await buy(coin, trader, traderBase, tt, 20_000_000n);
      assert.isTrue(d.ops > 0n, 'ops must keep accruing while withdrawals are paused');

      await program.methods
        .setPause(null, null, null, false)
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      await call({ ops: {} }, opsCold, opsVault(), 500n);
    });

    it('trading pause halts fills without touching claims', async () => {
      const coin = await launch('PAUSED');
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      await buy(coin, trader, traderBase, tt, 5_000_000n);

      await program.methods
        .setPause(true, null, null, null)
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      await rejects(
buy(coin, trader, traderBase, tt, 1_000_000n), /TradingPaused/);

      const ct = await createAssociatedTokenAccount(conn, creator, coin.mint, creator.publicKey);
      await program.methods
        .claimCreatorFees()
        .accountsPartial({
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          bucketBaseVault: coin.bucketBaseVault,
          bucketTokenVault: coin.bucketTokenVault,
          creator: creator.publicKey,
          creatorBaseAccount: creatorBase,
          creatorTokenAccount: ct,
          tokenProgram: TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();

      await program.methods
        .setPause(false, null, null, null)
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });
  });

  /* ------------------------------------------------------- 2.A  graduation */

  describe('graduation', () => {
    it('caps the final buy, closes at $69K and burns nothing when exhausted', async () => {
      const coin = await launch('GRAD', { feeBps: 100 });
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);

      // Far more than the ~13,800 base the curve can absorb.
      const offered = 100_000n * 1_000_000n;
      const d = await buy(coin, trader, traderBase, tt, offered);
      assert.isTrue(d.spent < offered, 'the capped buy must not pull the whole offer');

      const c = await program.account.curve.fetch(coin.curve);
      assert.equal(BigInt(c.realToken.toString()), 0n, 'allocation exhausted');
      assert.isTrue(c.complete);

      // ~20% of the $69K cap was raised.
      const raised = BigInt(c.realBase.toString());
      const expect = 69_000_000_000n / 5n;
      const drift = raised > expect ? raised - expect : expect - raised;
      assert.isTrue(drift * 1_000_000n <= expect, `raised ${raised}, expected ~${expect}`);

      await rejects(
buy(coin, trader, traderBase, tt, 1_000_000n), /CurveComplete/);

      await program.methods
        .graduate()
        .accountsPartial({
          global: globalPda,
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          oracle: oraclePdaFor(baseMint),
          curveTokenVault: coin.curveTokenVault,
          caller: trader.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();

      const g = await program.account.curve.fetch(coin.curve);
      assert.isTrue(g.graduated);
      assert.deepEqual(g.graduationReason, { curveComplete: {} });
      await rejects(
buy(coin, trader, traderBase, tt, 1_000_000n), /AlreadyGraduated/);
    });

    it('refuses to graduate a curve that has not met a trigger', async () => {
      const coin = await launch('YOUNG');
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      await buy(coin, trader, traderBase, tt, 1_000_000n);
      await rejects(
program.methods
          .graduate()
          .accountsPartial({
            global: globalPda,
            curve: coin.curve,
            mint: coin.mint,
            baseMint,
            oracle: oraclePdaFor(baseMint),
            curveTokenVault: coin.curveTokenVault,
            caller: trader.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([trader])
          .rpc(),
        /NotGraduable/,
      );
    });

    it('a stale oracle cannot wedge a token: exhaustion still graduates', async () => {
      // Two coins, launched while the oracle is still fresh. One gets bought
      // out, one stays young.
      const done = await launch('STALE', { feeBps: 100 });
      const young = await launch('STALE2', { feeBps: 100 });
      const dt = await createAssociatedTokenAccount(conn, trader, done.mint, trader.publicKey);
      const yt = await createAssociatedTokenAccount(conn, trader, young.mint, trader.publicKey);
      await buy(done, trader, traderBase, dt, 100_000n * 1_000_000n);
      await buy(young, trader, traderBase, yt, 1_000_000n);

      // Now let the oracle go stale.
      await program.methods
        .setMaxOracleStaleness(new BN(1))
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      await new Promise((r) => setTimeout(r, 2500));

      const grad = (coin: typeof done, oracle: PublicKey | null) =>
        program.methods
          .graduate()
          .accountsPartial({
            global: globalPda,
            curve: coin.curve,
            mint: coin.mint,
            baseMint,
            oracle,
            curveTokenVault: coin.curveTokenVault,
            caller: trader.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([trader])
          .rpc();

      // The exhaustion trigger never consults the oracle, so it still works.
      await grad(done, null);
      assert.isTrue((await program.account.curve.fetch(done.curve)).graduated);

      // The oracle trigger is the only thing staleness takes away, and taking
      // it away can only delay an early graduation, never block a real one.
      await rejects(grad(young, oraclePdaFor(baseMint)), /OracleStale/);
      await rejects(grad(young, null), /NotGraduable/);

      await program.methods
        .setMaxOracleStaleness(new BN(90))
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    it('refuses to launch against a stale oracle', async () => {
      await program.methods
        .setMaxOracleStaleness(new BN(1))
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      await new Promise((r) => setTimeout(r, 2000));
      await rejects(launch('STALE3'), /OracleStale/);

      await program.methods
        .setMaxOracleStaleness(new BN(90))
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });
  });

  /* ------------------------------------------- 2.A graduation: LP migration */

  describe('graduation liquidity migration (Raydium CPMM)', () => {
    // Devnet deployment + the default, permissionless fee-tier config and its
    // hardcoded fee receiver. Cloned onto the local validator by
    // `[test.validator.clone]` in Anchor.toml so this suite exercises the
    // real Raydium program's own account validation, not a mock.
    const RAYDIUM_PROGRAM = new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb');
    const RAYDIUM_AMM_CONFIG = new PublicKey('5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy');
    const CREATE_POOL_FEE_RECEIVER = new PublicKey('3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy');

    const RAYDIUM_AUTH_SEED = enc('vault_and_lp_mint_auth_seed');
    const POOL_LP_MINT_SEED = enc('pool_lp_mint');
    const POOL_VAULT_SEED = enc('pool_vault');
    const OBSERVATION_SEED = enc('observation');

    before(async () => {
      await program.methods
        .setRaydiumConfig(RAYDIUM_PROGRAM, RAYDIUM_AMM_CONFIG)
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });

    /** Buy out the whole curve allocation and graduate it. */
    async function graduateFully(ticker: string) {
      const coin = await launch(ticker, { feeBps: 100 });
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      await buy(coin, trader, traderBase, tt, 100_000n * 1_000_000n);

      const c = await program.account.curve.fetch(coin.curve);
      assert.isTrue(c.complete, 'curve must be exhausted before graduate()');

      await program.methods
        .graduate()
        .accountsPartial({
          global: globalPda,
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          oracle: oraclePdaFor(baseMint),
          curveTokenVault: coin.curveTokenVault,
          caller: trader.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();

      return coin;
    }

    /** Every Raydium + escrow account `migrate_liquidity` needs, derived the
     * same way the program derives them. */
    function raydiumAccountsFor(coin: { mint: PublicKey } & ReturnType<typeof coinAccounts>) {
      const mint = coin.mint;
      const escrow = vault('raydium_escrow', mint);
      const poolState = vault('raydium_pool', mint);
      const raydiumAuthority = PublicKey.findProgramAddressSync(
        [RAYDIUM_AUTH_SEED],
        RAYDIUM_PROGRAM,
      )[0];
      const lpMint = PublicKey.findProgramAddressSync(
        [POOL_LP_MINT_SEED, poolState.toBuffer()],
        RAYDIUM_PROGRAM,
      )[0];
      const poolVaultBase = PublicKey.findProgramAddressSync(
        [POOL_VAULT_SEED, poolState.toBuffer(), baseMint.toBuffer()],
        RAYDIUM_PROGRAM,
      )[0];
      const poolVaultToken = PublicKey.findProgramAddressSync(
        [POOL_VAULT_SEED, poolState.toBuffer(), mint.toBuffer()],
        RAYDIUM_PROGRAM,
      )[0];
      const observationState = PublicKey.findProgramAddressSync(
        [OBSERVATION_SEED, poolState.toBuffer()],
        RAYDIUM_PROGRAM,
      )[0];
      const escrowBase = getAssociatedTokenAddressSync(baseMint, escrow, true);
      const escrowToken = getAssociatedTokenAddressSync(mint, escrow, true);
      const escrowLpToken = getAssociatedTokenAddressSync(lpMint, escrow, true);
      return {
        escrow,
        poolState,
        raydiumAuthority,
        lpMint,
        poolVaultBase,
        poolVaultToken,
        observationState,
        escrowBase,
        escrowToken,
        escrowLpToken,
      };
    }

    async function migrate(coin: { mint: PublicKey } & ReturnType<typeof coinAccounts>) {
      const r = raydiumAccountsFor(coin);
      await program.methods
        .migrateLiquidity()
        .accountsPartial({
          global: globalPda,
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          curveBaseVault: coin.curveBaseVault,
          lpVault: coin.lpVault,
          escrow: r.escrow,
          escrowBase: r.escrowBase,
          escrowToken: r.escrowToken,
          raydiumProgram: RAYDIUM_PROGRAM,
          ammConfig: RAYDIUM_AMM_CONFIG,
          raydiumAuthority: r.raydiumAuthority,
          poolState: r.poolState,
          lpMint: r.lpMint,
          poolVaultBase: r.poolVaultBase,
          poolVaultToken: r.poolVaultToken,
          observationState: r.observationState,
          createPoolFee: CREATE_POOL_FEE_RECEIVER,
          escrowLpToken: r.escrowLpToken,
          migrationAuthority: migrationAuth.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          baseTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 })])
        .signers([migrationAuth])
        .rpc();
      return r;
    }

    it('seeds a real Raydium CPMM pool and burns 100% of the LP it mints', async () => {
      const coin = await graduateFully('RAYMIG1');
      const graduated = await program.account.curve.fetch(coin.curve);
      const baseToMigrate = BigInt(graduated.realBase.toString());
      const tokensToMigrate = BigInt(graduated.lpReserve.toString());
      assert.isTrue(baseToMigrate > 0n && tokensToMigrate > 0n);

      const r = await migrate(coin);

      const after = await program.account.curve.fetch(coin.curve);
      assert.isTrue(after.migrated, 'curve must be marked migrated');
      assert.equal(after.raydiumPool.toBase58(), r.poolState.toBase58());
      assert.equal(BigInt(after.realBase.toString()), 0n, 'base reserve zeroed');
      assert.equal(BigInt(after.lpReserve.toString()), 0n, 'token reserve zeroed');
      const lpBurned = BigInt(after.raydiumLpBurned.toString());
      assert.isTrue(lpBurned > 0n);

      // The pool is real, owned by Raydium, and verifiable independent of
      // this program -- a user or an indexer can confirm all of this straight
      // off a block explorer.
      const poolInfo = await conn.getAccountInfo(r.poolState);
      assert.isNotNull(poolInfo, 'pool_state must exist');
      assert.equal(poolInfo!.owner.toBase58(), RAYDIUM_PROGRAM.toBase58());
      const vault0Info = await conn.getAccountInfo(r.poolVaultBase);
      const vault1Info = await conn.getAccountInfo(r.poolVaultToken);
      assert.isNotNull(vault0Info);
      assert.isNotNull(vault1Info);

      // The LP mint's *total supply* is reduced, not merely sent to an address
      // nobody uses -- there is no SPL analogue of "still counted in supply
      // but stuck at 0xdead". This is the on-chain-verifiable claim.
      const lpMintInfo = await getMint(conn, r.lpMint);
      assert.equal(lpMintInfo.supply, 0n, 'all minted LP burned, supply is exactly zero');
      const escrowLp = await getAccount(conn, r.escrowLpToken);
      assert.equal(escrowLp.amount, 0n, 'the escrow holds nothing after the burn');
    });

    it('refuses a second migration for the same coin', async () => {
      const coin = await graduateFully('RAYMIG2');
      await migrate(coin);
      await rejects(migrate(coin), /AlreadyMigrated/);
    });

    it('rejects a pre-existing pool_state account (pre-seeded-pool defence)', async () => {
      const coin = await graduateFully('RAYMIG3');
      const r = raydiumAccountsFor(coin);
      // In production nobody but this program can ever produce a signature
      // for `pool_state`, so it cannot really be pre-seeded -- that is the
      // whole point of using this program's own PDA rather than Raydium's
      // canonical, guessable one. This test only proves the defence-in-depth
      // assertion itself fires, by forcing the "already exists" precondition
      // directly.
      await conn.confirmTransaction(
        await conn.requestAirdrop(r.poolState, 1_000_000),
        'confirmed',
      );
      await rejects(migrate(coin), /PoolAlreadyExists/);
    });

    it('leaves migration_authority with no path to name an arbitrary destination', async () => {
      // The old `MigrateLiquidity` shape (`destination_base`/
      // `destination_token`, caller-supplied token accounts) no longer
      // exists anywhere in the IDL.
      const idl = program.idl as unknown as {
        instructions: { name: string; accounts: { name: string }[] }[];
      };
      const ix = idl.instructions.find((i) => i.name === 'migrateLiquidity');
      assert.isDefined(ix, 'migrateLiquidity must still exist');
      const names = ix!.accounts.map((a) => a.name);
      assert.notInclude(names, 'destinationBase');
      assert.notInclude(names, 'destinationToken');
      // And the only signer able to influence this instruction at all is
      // `migrationAuthority`, funding rent -- never a token-account owner.
      assert.include(names, 'migrationAuthority');
    });
  });
});
