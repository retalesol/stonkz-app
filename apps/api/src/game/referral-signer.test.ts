import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { verifyTypedData } from 'viem';
import {
  REFERRAL_CLAIM_TYPES,
  REFERRAL_EVM_DOMAIN,
  REFERRAL_SOL_MESSAGE_LEN,
  ReferralSigner,
  evmSignerFromKey,
  referralMessageSol,
  referralSignerFromEnv,
  solClusterTag,
  solSignerFromKey,
  verifyEd25519,
} from './referral-signer.js';

const EVM_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('referral signer keys', () => {
  it('is off when nothing is configured and refuses malformed keys', () => {
    const off = referralSignerFromEnv({
      referralSignerKeyEvm: undefined,
      referralSignerKeySol: '',
    });
    expect(off.evmAddress).toBeNull();
    expect(off.solPublicKey).toBeNull();
    expect(() => evmSignerFromKey('0x1234')).toThrow(/32-byte/);
    expect(() => solSignerFromKey('zz')).toThrow(/seed/);
    expect(() => solSignerFromKey('[1,2,3]')).toThrow(/array/);
  });

  it('accepts a hex seed, a hex secret key and solana-keygen JSON for the same key', () => {
    const kp = Keypair.generate();
    const seedHex = Buffer.from(kp.secretKey.subarray(0, 32)).toString('hex');
    const secretHex = Buffer.from(kp.secretKey).toString('hex');
    const jsonArr = JSON.stringify(Array.from(kp.secretKey));
    for (const raw of [seedHex, `0x${seedHex}`, secretHex, jsonArr]) {
      expect(solSignerFromKey(raw)!.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    }
  });
});

describe('Solana voucher message', () => {
  const vault = new PublicKey('11111111111111111111111111111112');
  const recipient = new PublicKey('So11111111111111111111111111111111111111112');
  const baseMint = new PublicKey('So11111111111111111111111111111111111111112');

  it('is 138 bytes: prefix, tag, three keys, u64 LE, i64 LE', () => {
    const tag = solClusterTag('devnet');
    expect(tag).toEqual(Buffer.from('devnet\0\0'));
    expect(solClusterTag('mainnet-beta')).toEqual(Buffer.from('mainnet\0'));
    expect(solClusterTag('localnet')).toEqual(Buffer.from('localnet'));
    const m = referralMessageSol({
      clusterTag: tag,
      vault,
      recipient,
      baseMint,
      cumulativeAmount: 0x0102030405060708n,
      deadline: -2n,
    });
    expect(m.length).toBe(REFERRAL_SOL_MESSAGE_LEN);
    expect(m.subarray(0, 18).toString()).toBe('STONKZ_REFERRAL_V1');
    expect(m.subarray(18, 26)).toEqual(tag);
    expect(m.subarray(26, 58)).toEqual(vault.toBuffer());
    expect(m.subarray(58, 90)).toEqual(recipient.toBuffer());
    expect(m.subarray(90, 122)).toEqual(baseMint.toBuffer());
    expect([...m.subarray(122, 130)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(m.readBigInt64LE(130)).toBe(-2n);
  });

  it('signs with the configured key and any changed byte fails verification', () => {
    const kp = Keypair.generate();
    const signer = new ReferralSigner(
      null,
      solSignerFromKey(Buffer.from(kp.secretKey.subarray(0, 32)).toString('hex')),
    );
    const { message, signature } = signer.signSol({
      clusterTag: solClusterTag('devnet'),
      vault,
      recipient,
      baseMint,
      cumulativeAmount: 5n,
      deadline: 10n,
    });
    expect(signature.length).toBe(64);
    expect(verifyEd25519(kp.publicKey, message, signature)).toBe(true);
    const tampered = Buffer.from(message);
    tampered[122] ^= 1; // cumulative
    expect(verifyEd25519(kp.publicKey, tampered, signature)).toBe(false);
    expect(verifyEd25519(Keypair.generate().publicKey, message, signature)).toBe(false);
    expect(() => new ReferralSigner(null, null).signSol({} as never)).toThrow(/not configured/);
  });
});

describe('EVM voucher', () => {
  it('is an EIP-712 ReferralClaim under the vault domain', async () => {
    const signer = new ReferralSigner(evmSignerFromKey(EVM_KEY), null);
    const vault = '0x1111111111111111111111111111111111111111';
    const sig = await signer.signEvm({
      chainId: 84532,
      vault,
      recipient: '0x2222222222222222222222222222222222222222',
      asset: '0x4200000000000000000000000000000000000006',
      cumulativeAmount: 150000000000000000n,
      deadline: 1_800_000_000n,
    });
    const check = (chainId: number, verifyingContract: `0x${string}`, cumulativeAmount: bigint) =>
      verifyTypedData({
        address: signer.evmAddress!,
        domain: { ...REFERRAL_EVM_DOMAIN, chainId, verifyingContract },
        types: REFERRAL_CLAIM_TYPES,
        primaryType: 'ReferralClaim',
        message: {
          recipient: '0x2222222222222222222222222222222222222222',
          asset: '0x4200000000000000000000000000000000000006',
          cumulativeAmount,
          deadline: 1_800_000_000n,
        },
        signature: sig,
      });
    expect(await check(84532, vault, 150000000000000000n)).toBe(true);
    expect(await check(8453, vault, 150000000000000000n)).toBe(false);
    expect(
      await check(84532, '0x3333333333333333333333333333333333333333', 150000000000000000n),
    ).toBe(false);
    expect(await check(84532, vault, 150000000000000001n)).toBe(false);
    await expect(new ReferralSigner(null, null).signEvm({} as never)).rejects.toThrow(
      /not configured/,
    );
  });
});
