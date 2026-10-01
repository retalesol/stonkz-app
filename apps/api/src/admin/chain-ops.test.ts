import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { decodeFunctionData, getAddress, toFunctionSelector } from 'viem';
import {
  DEFAULT_CURVE_PARAMS,
  DEFAULT_PARAMS_WORD,
  packParamsWord,
  unpackParamsWord,
} from '@stonkz/shared';
import {
  LAUNCHPAD_ADMIN_ABI,
  PUSH_PRICE_SOURCE_ABI,
  ROUTER_ADMIN_ABI,
  checkParamsWord,
  readEvmRouterConfig,
  buildSolanaAdminInstruction,
  composeSolanaAdminTransaction,
  SOLANA_PARAMS_DEFAULTS,
  decodeSolanaBaseOracle,
  decodeSolanaGlobal,
  decodeSolanaParams,
  decodeSolanaPauserConfig,
  encodeSetParamsData,
  prepareEvmAdminTx,
  readEvmLaunchpadState,
  safeTransactionBuilderJson,
  solanaGlobalPda,
  solanaParamsPda,
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
      [{ kind: 'set_params', params: { ...SOLANA_PARAMS_DEFAULTS } }, 'set_params'],
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

describe('Solana runtime params', () => {
  const CUSTOM = {
    feeProtocolBps: 2000,
    feeOpsBps: 1500,
    feeBurnBps: 500,
    minFeeBps: 50,
    maxFeeBps: 800,
    cbStartFeeBps: 6000,
    cbWindowSecs: 120,
    gradMcapUsd1e6: '100000000000',
  };

  it('set_params takes global, the params PDA (writable), the admin and the system program', () => {
    const { ix, signer, summary } = buildSolanaAdminInstruction(PROGRAM, admin, {
      kind: 'set_params',
      params: CUSTOM,
    });
    expect(signer).toBe('admin');
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0]!.pubkey.equals(solanaGlobalPda(PROGRAM))).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(solanaParamsPda(PROGRAM))).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(true);
    expect(ix.keys[2]!.isSigner && ix.keys[2]!.isWritable).toBe(true);
    expect(summary).toContain('grad=$100000');
  });

  it('encodes ParamsArgs as Borsh: six u16, a u32 and a u64, little-endian', () => {
    const data = encodeSetParamsData(CUSTOM);
    expect(Buffer.from(data.subarray(0, 8)).equals(disc('set_params'))).toBe(true);
    expect([...data.subarray(8)]).toEqual([
      0xd0,
      0x07, // 2000
      0xdc,
      0x05, // 1500
      0xf4,
      0x01, // 500
      0x32,
      0x00, // 50
      0x20,
      0x03, // 800
      0x70,
      0x17, // 6000
      0x78,
      0x00,
      0x00,
      0x00, // 120
      0x00,
      0xe8,
      0x76,
      0x48,
      0x17,
      0x00,
      0x00,
      0x00, // 100_000_000_000
    ]);
  });

  it("refuses what the program's validate_params refuses", () => {
    const bad = (patch: Partial<typeof CUSTOM>, re: RegExp): void =>
      expect(() => encodeSetParamsData({ ...CUSTOM, ...patch })).toThrow(re);
    bad({ feeProtocolBps: 5000, feeOpsBps: 4000, feeBurnBps: 1001 }, /<= 10000/);
    bad({ minFeeBps: 801 }, /minFeeBps/);
    bad({ cbStartFeeBps: 799 }, /cbStartFeeBps/);
    bad({ cbStartFeeBps: 10_001 }, /0\.\.=10000/);
    bad({ cbWindowSecs: 0 }, /cbWindowSecs/);
    bad({ gradMcapUsd1e6: '0' }, /gradMcapUsd1e6/);
    bad({ feeProtocolBps: 1.5 }, /integer/);
    // Inclusive boundaries pass.
    expect(() =>
      encodeSetParamsData({ ...CUSTOM, feeProtocolBps: 5000, feeOpsBps: 4000, feeBurnBps: 1000 }),
    ).not.toThrow();
    expect(() => encodeSetParamsData({ ...CUSTOM, cbStartFeeBps: 10_000 })).not.toThrow();
    expect(() => encodeSetParamsData(SOLANA_PARAMS_DEFAULTS)).not.toThrow();
  });

  it('decodes the Params account, and an absent one as the uninitialised defaults', () => {
    expect(decodeSolanaParams(null)).toEqual({ initialised: false, ...SOLANA_PARAMS_DEFAULTS });
    expect(decodeSolanaParams('')).toEqual({ initialised: false, ...SOLANA_PARAMS_DEFAULTS });

    const body = Buffer.alloc(1 + 12 + 4 + 8 + 64);
    body[0] = 253; // bump
    let o = 1;
    for (const v of [2000, 1500, 500, 50, 800, 6000]) {
      body.writeUInt16LE(v, o);
      o += 2;
    }
    body.writeUInt32LE(120, o);
    o += 4;
    body.writeBigUInt64LE(100_000_000_000n, o);
    const account = Buffer.concat([Buffer.alloc(8, 9), body]);
    expect(decodeSolanaParams(account.toString('base64'))).toEqual({
      initialised: true,
      ...CUSTOM,
    });
    // The set_params payload round-trips through the account layout.
    const data = encodeSetParamsData(CUSTOM);
    expect(Buffer.from(data.subarray(8)).equals(body.subarray(1, 1 + 24))).toBe(true);
    expect(() => decodeSolanaParams(Buffer.alloc(12).toString('base64'))).toThrow(/too short/);
  });
});

/* --------------------------------------------------- runtime parameters (EVM) */

describe('EVM runtime parameters', () => {
  const CUSTOM = {
    ...DEFAULT_CURVE_PARAMS,
    feeProtocolBps: 2000,
    feeOpsBps: 500,
    feeBurnBps: 500,
    maxFeeBps: 300,
    cbWindowSecs: 120,
    gradUsd: 100_000,
    maxSupply: 1e9,
  };

  it('setParams / setTrustedRouter / router.setConfig carry the Solidity selectors', () => {
    const word = packParamsWord(CUSTOM);
    const setParams = prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
      kind: 'setParams',
      word: word.toString(),
    });
    expect(setParams.data.slice(0, 10)).toBe(toFunctionSelector('setParams(uint256)'));
    expect(setParams.to).toBe(LAUNCHPAD);
    expect(setParams.signer).toBe('admin');
    expect(setParams.summary).toContain('grad=$100000');
    const decoded = decodeFunctionData({
      abi: LAUNCHPAD_ADMIN_ABI,
      data: setParams.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe('setParams');
    expect(decoded.args).toEqual([word]);
    expect(unpackParamsWord(decoded.args![0] as bigint)).toEqual({
      feeProtocolBps: 2000,
      feeOpsBps: 500,
      feeBurnBps: 500,
      minFeeBps: 100,
      maxFeeBps: 300,
      cbStartFeeBps: 5000,
      cbWindowSecs: 120,
      gradUsd: 100_000,
      maxSupply: 1e9,
    });
    // A 0x-hex word is accepted too (what a Safe export shows).
    expect(
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'setParams',
        word: `0x${word.toString(16)}`,
      }).data,
    ).toBe(setParams.data);

    const trusted = prepareEvmAdminTx('BASE', 84532, LAUNCHPAD, {
      kind: 'setTrustedRouter',
      router: A,
    });
    expect(trusted.data.slice(0, 10)).toBe(toFunctionSelector('setTrustedRouter(address)'));
    expect(trusted.to).toBe(LAUNCHPAD);

    const cfg = prepareEvmAdminTx(
      'BASE',
      84532,
      LAUNCHPAD,
      { kind: 'setRouterConfig', maxBuyNative: '2500000000000000000', pyth: A, attestationSink: B },
      { router: B },
    );
    expect(cfg.data.slice(0, 10)).toBe(toFunctionSelector('setConfig(uint256,address,address)'));
    expect(cfg.to).toBe(B);
    expect(cfg.signer).toBe('admin');
    const d = decodeFunctionData({ abi: ROUTER_ADMIN_ABI, data: cfg.data as `0x${string}` });
    expect(d.args).toEqual([2_500_000_000_000_000_000n, A, B]);
    expect(cfg.summary).toContain('maxBuyNative=2500000000000000000 wei');
  });

  it('refuses a word the contract would refuse, and router config without a router', () => {
    const bad = (p: Partial<typeof CUSTOM>): string =>
      packParamsWord({ ...CUSTOM, ...p }).toString();
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'setParams', word: '0' }),
    ).toThrow(/non-zero/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'setParams', word: 'abc' }),
    ).toThrow(/integer/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'setParams',
        word: bad({ feeProtocolBps: 6000, feeOpsBps: 3000, feeBurnBps: 2000 }),
      }),
    ).toThrow(/at most 10000/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'setParams',
        word: bad({ minFeeBps: 400 }),
      }),
    ).toThrow(/minFeeBps/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'setParams',
        word: bad({ cbStartFeeBps: 200 }),
      }),
    ).toThrow(/cbStartFeeBps/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'setParams',
        word: bad({ cbWindowSecs: 0 }),
      }),
    ).toThrow(/cbWindowSecs/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'setParams', word: bad({ gradUsd: 0 }) }),
    ).toThrow(/gradUsd/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, { kind: 'setParams', word: bad({ maxSupply: 0 }) }),
    ).toThrow(/maxSupply/);
    expect(() =>
      prepareEvmAdminTx('RH', 46630, LAUNCHPAD, {
        kind: 'setRouterConfig',
        maxBuyNative: '1',
        pyth: A,
        attestationSink: B,
      }),
    ).toThrow(/no StonkzRouter/);
    expect(() =>
      prepareEvmAdminTx(
        'RH',
        46630,
        LAUNCHPAD,
        { kind: 'setRouterConfig', maxBuyNative: '-1', pyth: A, attestationSink: B },
        { router: B },
      ),
    ).toThrow(/maxBuyNative/);
    expect(checkParamsWord(DEFAULT_PARAMS_WORD.toString()).fields.gradUsd).toBe(69_000);
  });

  it('reads trustedRouter / paramsWord tolerantly and the router config per field', async () => {
    const word = (hex: string): string => '0x' + hex.padStart(64, '0');
    const base: Record<string, string> = {
      [toFunctionSelector('admin()')]: word(A.slice(2)),
      [toFunctionSelector('maxOracleStaleness()')]: word('78'),
      [toFunctionSelector('tokenCount()')]: word('1'),
    };
    // A pre-params implementation: both views revert (the fake answers nothing).
    const old = await readEvmLaunchpadState(
      {
        ethCall: async (_to, data) => {
          const a = base[data.slice(0, 10)];
          if (a) return a;
          const sel = data.slice(0, 10);
          if (
            sel === toFunctionSelector('trustedRouter()') ||
            sel === toFunctionSelector('paramsWord()')
          )
            throw new Error('execution reverted');
          return word('0');
        },
      },
      LAUNCHPAD,
    );
    expect(old.trustedRouter).toBeNull();
    expect(old.paramsWord).toBeNull();
    expect(old.admin).toBe(A);

    const packed = packParamsWord(CUSTOM);
    const fresh = await readEvmLaunchpadState(
      {
        ethCall: async (_to, data) => {
          const sel = data.slice(0, 10);
          if (sel === toFunctionSelector('trustedRouter()')) return word(B.slice(2));
          if (sel === toFunctionSelector('paramsWord()')) return word(packed.toString(16));
          return base[sel] ?? word('0');
        },
      },
      LAUNCHPAD,
    );
    expect(fresh.trustedRouter).toBe(B);
    expect(fresh.paramsWord).toBe(packed.toString());

    const cfg = await readEvmRouterConfig(
      {
        ethCall: async (_to, data) => {
          const sel = data.slice(0, 10);
          if (sel === toFunctionSelector('maxBuyNative()')) return word('de0b6b3a7640000');
          if (sel === toFunctionSelector('pyth()')) return word(A.slice(2));
          throw new Error('execution reverted'); // old router: no attestationSink()
        },
      },
      B,
    );
    expect(cfg).toEqual({ maxBuyNative: '1000000000000000000', pyth: A, attestationSink: null });
  });
});
