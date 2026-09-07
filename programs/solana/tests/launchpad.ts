/**
 * Integration suite against a local validator.
 *
 * The host-side suite in `src/tests.rs` proves the arithmetic. This one proves
 * the *settlement*: that the atoms actually land in the accounts the split says
 * they should, that authorities are revoked, that locks hold, and that the
 * paths which must not exist really do not exist.
 */
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { assert } from 'chai';

import { Launchpad } from '../target/types/launchpad';

const enc = (s: string) => Buffer.from(s, 'utf8');

/** Assert a call fails, and fails for the reason we meant. */
async function rejects(p: Promise<unknown> | (() => Promise<unknown>), match: RegExp) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    const msg = `${(e as Error).message ?? ''}\n${JSON.stringify((e as any).logs ?? [])}`;
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
      await buy(flexCoin, trader, traderBase, ft, 10_000_000n);
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

      const call = (which: any, signer: Keypair, v: PublicKey, amount: bigint) =>
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

    it('falls back to the exhaustion trigger when the oracle is stale', async () => {
      // max_oracle_staleness of 1s makes every push stale a moment later, which
      // is the condition we care about: a dead oracle must not wedge a token.
      await program.methods
        .setMaxOracleStaleness(new BN(1))
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();

      const coin = await launch('STALE', { feeBps: 100 });
      const tt = await createAssociatedTokenAccount(conn, trader, coin.mint, trader.publicKey);
      await buy(coin, trader, traderBase, tt, 100_000n * 1_000_000n);
      await new Promise((r) => setTimeout(r, 2500));

      await program.methods
        .graduate()
        .accountsPartial({
          global: globalPda,
          curve: coin.curve,
          mint: coin.mint,
          baseMint,
          oracle: null,
          curveTokenVault: coin.curveTokenVault,
          caller: trader.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();
      assert.isTrue((await program.account.curve.fetch(coin.curve)).graduated);

      await program.methods
        .setMaxOracleStaleness(new BN(90))
        .accountsPartial({ global: globalPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    });
  });
});
