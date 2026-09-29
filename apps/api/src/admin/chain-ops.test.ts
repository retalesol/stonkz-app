import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { decodeFunctionData, getAddress, toFunctionSelector } from 'viem';
import {
  LAUNCHPAD_ADMIN_ABI,
  PUSH_PRICE_SOURCE_ABI,
  buildSolanaAdminInstruction,
  composeSolanaAdminTransaction,
  decodeSolanaBaseOracle,
  decodeSolanaGlobal,
  decodeSolanaPauserConfig,
  prepareEvmAdminTx,
  readEvmLaunchpadState,
  safeTransactionBuilderJson,
  solanaGlobalPda,
  solanaPauserPda,
} from './chain-ops.js';

const LAUNCHPAD = '0xe308287C9A85E2B53F1027a1c589B5e3969928e8';
const A = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const B = getAddress('0xff88000000000000000000000000000000004879');

/** Signatures copied from `programs/evm/src/StonkzLaunchpad.sol` / `oracle/PushPriceSource.sol`. */
const SOLIDITY_SIGNATURES = [
  'setPause(bool,bool,bool,bool,bool)',
  'pause(bool,bool,bool,bool,bool)',
  'setPauser(address)',
  'setMigrator(address,address)',
  'setWithdrawAuthorities(address,address)',
  'proposeAdmin(address)',
  'acceptAdmin()',
  'setPriceSource(address)',
  'setMaxOracleStaleness(uint64)',
  'withdrawTreasury(uint8,address,uint256,address)',
  'pushPrice(address,uint256,uint256)',
];

describe('EVM admin calldata', () => {
  it('every prepared call starts with the selector of the Solidity signature', () => {
    const cases: [Parameters<typeof prepareEvmAdminTx>[3], string][] = [
      [
        {
          kind: 'setPause',
          trading: true,
          launch: false,
          protocolWithdrawals: false,
          opsWithdrawals: true,
          oracleGraduation: false,
        },
        'setPause(bool,bool,bool,bool,bool)',
      ],
      [
        {
          kind: 'pause',
          trading: true,
          launch: true,
          protocolWithdrawals: false,
          opsWithdrawals: false,
          oracleGraduation: false,
        },
        'pause(bool,bool,bool,bool,bool)',
      ],
      [{ kind: 'setPauser', pauser: A }, 'setPauser(address)'],
      [{ kind: 'setMigrator', migrator: A, authority: B }, 'setMigrator(address,address)'],
      [
        { kind: 'setWithdrawAuthorities', protocol: A, ops: B },
        'setWithdrawAuthorities(address,address)',
      ],
      [{ kind: 'proposeAdmin', admin: A }, 'proposeAdmin(address)'],
      [{ kind: 'acceptAdmin' }, 'acceptAdmin()'],
      [{ kind: 'setPriceSource', source: A }, 'setPriceSource(address)'],
      [{ kind: 'setMaxOracleStaleness', seconds: 120 }, 'setMaxOracleStaleness(uint64)'],
      [
        { kind: 'withdrawTreasury', which: 1, baseToken: A, amountAtoms: '1000', to: B },
        'withdrawTreasury(uint8,address,uint256,address)',
      ],
      [
        { kind: 'pushPrice', source: B, baseToken: A, price1e6: '4200000000', conf1e6: '1000' },
        'pushPrice(address,uint256,uint256)',
      ],
    ];
    for (const [action, sig] of cases) {
      const tx = prepareEvmAdminTx('RH', 46630, LAUNCHPAD, action);
      expect(tx.data.slice(0, 10), sig).toBe(toFunctionSelector(sig));
      expect(tx.value).toBe('0');
      expect(tx.to).toBe(action.kind === 'pushPrice' ? B : LAUNCHPAD);
    }
    expect(SOLIDITY_SIGNATURES).toHaveLength(cases.length);
  });

  it('round-trips arguments through the ABI', () => {
    const tx = prepareEvmAdminTx('BASE', 84532, LAUNCHPAD, {
      kind: 'withdrawTreasury',
      which: 2,
      baseToken: A.toLowerCase(),
      amountAtoms: '123456789',
      to: B,
    });
    const decoded = decodeFunctionData({
      abi: LAUNCHPAD_ADMIN_ABI,
      data: tx.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe('withdrawTreasury');
    expect(decoded.args).toEqual([2, A, 123456789n, B]);
    expect(tx.signer).toBe('withdrawAuthority');
    expect(tx.chainId).toBe(84532);

    const push = prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
      kind: 'pushPrice',
      source: B,
      baseToken: A,
      price1e6: '5',
      conf1e6: '1',
    });
    const d2 = decodeFunctionData({ abi: PUSH_PRICE_SOURCE_ABI, data: push.data as `0x${string}` });
    expect(d2.args).toEqual([A, 5n, 1n]);
  });

  it('refuses malformed addresses and amounts before encoding', () => {
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'setPauser', pauser: 'nope' }),
    ).toThrow(/pauser/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'setMaxOracleStaleness', seconds: 0 }),
    ).toThrow(/> 0/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'withdrawTreasury',
        which: 0,
        baseToken: A,
        amountAtoms: '-1',
        to: B,
      }),
    ).toThrow(/amount/);
  });

  it('reads launchpad state through eth_call', async () => {
    const word = (hex: string): string => '0x' + hex.padStart(64, '0');
    const answers: Record<string, string> = {
      [toFunctionSelector('admin()')]: word(A.slice(2)),
      [toFunctionSelector('pendingAdmin()')]: word('0'),
      [toFunctionSelector('pauser()')]: word(B.slice(2)),
      [toFunctionSelector('priceSource()')]: word(B.slice(2)),
      [toFunctionSelector('migrator()')]: word('0'),
      [toFunctionSelector('migrationAuthority()')]: word(A.slice(2)),
      [toFunctionSelector('protocolWithdrawAuthority()')]: word(A.slice(2)),
      [toFunctionSelector('opsWithdrawAuthority()')]: word(B.slice(2)),
      [toFunctionSelector('maxOracleStaleness()')]: word((120).toString(16)),
      [toFunctionSelector('tradingPaused()')]: word('1'),
      [toFunctionSelector('launchPaused()')]: word('0'),
      [toFunctionSelector('protocolWithdrawalsPaused()')]: word('0'),
      [toFunctionSelector('opsWithdrawalsPaused()')]: word('1'),
      [toFunctionSelector('oracleGraduationPaused()')]: word('0'),
      [toFunctionSelector('tokenCount()')]: word((42).toString(16)),
    };
    const state = await readEvmLaunchpadState(
      { ethCall: async (_to, data) => answers[data.slice(0, 10)] ?? word('0') },
      LAUNCHPAD,
    );
    expect(state.admin).toBe(A);
    expect(state.pauser).toBe(B);
    expect(state.maxOracleStaleness).toBe(120);
    expect(state.paused).toEqual({
      trading: true,
      launch: false,
      protocolWithdrawals: false,
      opsWithdrawals: true,
      oracleGraduation: false,
    });
    expect(state.tokenCount).toBe(42);
  });

  it('emits a Safe Transaction Builder document', () => {
    const tx = prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'acceptAdmin' });
    const doc = safeTransactionBuilderJson({
      chainId: 46630,
      name: 'x',
      description: 'y',
      createdAtMs: 1,
      txs: [tx],
    });
    expect(doc['version']).toBe('1.0');
    expect(doc['chainId']).toBe('46630');
    expect(doc['transactions']).toEqual([
      {
        to: LAUNCHPAD,
        value: '0',
        data: tx.data,
        contractMethod: null,
        contractInputsValues: null,
      },
    ]);
  });
});

/* ------------------------------------------------------------------ Solana */

const PROGRAM = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
const admin = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`)).subarray(0, 8);
}

describe('Solana admin instructions', () => {
  it("prefixes each instruction with Anchor's sighash for the Rust name", () => {
    const cases: [Parameters<typeof buildSolanaAdminInstruction>[2], string][] = [
      [{ kind: 'set_pause', trading: true }, 'set_pause'],
      [
        {
          kind: 'pause',
          trading: true,
          launch: false,
          protocolWithdrawals: false,
          opsWithdrawals: false,
        },
        'pause',
      ],
      [{ kind: 'set_pauser', pauser: other.toBase58() }, 'set_pauser'],
      [{ kind: 'set_oracle_authority', authority: other.toBase58() }, 'set_oracle_authority'],
      [{ kind: 'set_max_oracle_staleness', seconds: 90 }, 'set_max_oracle_staleness'],
      [{ kind: 'set_withdraw_authorities', ops: other.toBase58() }, 'set_withdraw_authorities'],
      [{ kind: 'propose_admin', admin: other.toBase58() }, 'propose_admin'],
      [{ kind: 'accept_admin' }, 'accept_admin'],
      [
        {
          kind: 'withdraw_treasury',
          which: 1,
          baseMint: other.toBase58(),
          amountAtoms: '5',
          to: admin.toBase58(),
        },
        'withdraw_treasury',
      ],
      [
        { kind: 'push_price', baseMint: other.toBase58(), price1e6: '214080000', conf1e6: '1000' },
        'push_price',
      ],
    ];
    for (const [action, name] of cases) {
      const { ix } = buildSolanaAdminInstruction(PROGRAM, admin, action);
      expect(ix.programId.equals(PROGRAM)).toBe(true);
      expect(Buffer.from(ix.data.subarray(0, 8)).equals(disc(name)), name).toBe(true);
      expect(
        ix.keys.some((k) => k.isSigner && k.pubkey.equals(admin)),
        `${name} signer`,
      ).toBe(true);
    }
  });

  it('encodes Option<bool> per Borsh (0 = None, 1 + byte = Some)', () => {
    const { ix } = buildSolanaAdminInstruction(PROGRAM, admin, {
      kind: 'set_pause',
      trading: true,
      opsWithdrawals: false,
    });
    expect([...ix.data.subarray(8)]).toEqual([1, 1, 0, 0, 1, 0]);
    expect(ix.keys[0]!.pubkey.equals(solanaGlobalPda(PROGRAM))).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);
  });

  it('encodes the Treasury enum as a u8 and the amount as u64 LE', () => {
    const { ix } = buildSolanaAdminInstruction(PROGRAM, admin, {
      kind: 'withdraw_treasury',
      which: 2,
      baseMint: other.toBase58(),
      amountAtoms: '258',
      to: admin.toBase58(),
    });
    expect([...ix.data.subarray(8)]).toEqual([2, 2, 1, 0, 0, 0, 0, 0, 0]);
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[4]!.isSigner).toBe(true);
  });

  it('pause() takes the pauser PDA and pauser signer; set_pauser is admin + system program', () => {
    const pause = buildSolanaAdminInstruction(PROGRAM, other, {
      kind: 'pause',
      trading: true,
      launch: true,
      protocolWithdrawals: false,
      opsWithdrawals: false,
    });
    expect(pause.ix.keys[1]!.pubkey.equals(solanaPauserPda(PROGRAM))).toBe(true);
    expect(pause.signer).toBe('pauser');
    const set = buildSolanaAdminInstruction(PROGRAM, admin, {
      kind: 'set_pauser',
      pauser: other.toBase58(),
    });
    expect(set.ix.keys).toHaveLength(4);
    expect(set.ix.keys[2]!.isSigner && set.ix.keys[2]!.isWritable).toBe(true);
  });

  it('composes an unsigned legacy transaction the wallet can sign', async () => {
    const { ix } = buildSolanaAdminInstruction(PROGRAM, admin, { kind: 'accept_admin' });
    const out = await composeSolanaAdminTransaction(
      {
        latestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 99,
        }),
      },
      admin,
      ix,
    );
    const tx = Transaction.from(Buffer.from(out.transaction, 'base64'));
    expect(tx.feePayer?.equals(admin)).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    expect(out.lastValidBlockHeight).toBe(99);
  });

  it('decodes Global / PauserConfig / BaseOracle account layouts', () => {
    const keys = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
    const global = Buffer.concat([
      Buffer.alloc(8, 7), // discriminator (ignored)
      Buffer.from([254]), // bump
      ...keys.map((k) => k.toBuffer()),
      Buffer.from([1, 0, 0, 1]),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(90n);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(17n);
        return b;
      })(),
    ]);
    const g = decodeSolanaGlobal(global.toString('base64'));
    expect(g.admin).toBe(keys[0]!.toBase58());
    expect(g.dexConfig).toBe(keys[7]!.toBase58());
    expect(g.paused).toEqual({
      trading: true,
      launch: false,
      protocolWithdrawals: false,
      opsWithdrawals: true,
    });
    expect(g.maxOracleStaleness).toBe(90);
    expect(g.tokenCount).toBe(17);

    const pauser = Buffer.concat([Buffer.alloc(8), Buffer.from([1]), other.toBuffer()]);
    expect(decodeSolanaPauserConfig(pauser.toString('base64')).pauser).toBe(other.toBase58());

    const oracle = Buffer.concat([
      Buffer.alloc(8),
      Buffer.from([1]),
      other.toBuffer(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(214_080_000n);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(1_000n);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(1_700_000_000n);
        return b;
      })(),
      Buffer.from([9]),
    ]);
    expect(decodeSolanaBaseOracle(oracle.toString('base64'))).toEqual({
      baseMint: other.toBase58(),
      price1e6: '214080000',
      conf1e6: '1000',
      publishTime: 1_700_000_000,
    });
    expect(() => decodeSolanaGlobal(Buffer.alloc(10).toString('base64'))).toThrow(/too short/);
  });
});
