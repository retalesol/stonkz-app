import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  EIP1271_MAGIC,
  EIP1271_SELECTOR,
  encodeIsValidSignature,
  isChecksumValid,
  isEip1271Success,
  isEvmAddress,
  personalSignHash,
  recoverSiweAddress,
  toChecksumAddress,
  verifySiwe,
  verifySiweFull,
  type EthCaller,
} from './siwe.js';
import { contractWallet, evmWallet } from '../test/wallets.js';

const MESSAGE = 'ston.kz wants you to sign in with your Ethereum account:\n0xabc\n\nSign in.';

describe('address handling', () => {
  it('accepts well-formed addresses and rejects the rest', () => {
    expect(isEvmAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(isEvmAddress('0x' + 'a'.repeat(39))).toBe(false);
    expect(isEvmAddress('a'.repeat(42))).toBe(false);
    expect(isEvmAddress('0x' + 'g'.repeat(40))).toBe(false);
  });

  it('computes the EIP-55 checksum', () => {
    // The canonical vector from EIP-55 itself.
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    );
  });

  it('treats single-case addresses as unchecksummed rather than invalid', () => {
    expect(isChecksumValid('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(true);
    expect(isChecksumValid('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED')).toBe(true);
  });

  it('rejects a mixed-case address whose checksum fails', () => {
    // One nibble flipped from the canonical form: a typo, not an address.
    expect(isChecksumValid('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false);
  });
});

describe('ECDSA (EOA) verification', () => {
  const wallet = evmWallet('siwe-unit');

  it('round-trips a personal_sign signature', () => {
    expect(verifySiwe({ message: MESSAGE, signature: wallet.sign(MESSAGE), address: wallet.address })).toBe(true);
  });

  it('recovers the signer address', () => {
    expect(recoverSiweAddress(MESSAGE, wallet.sign(MESSAGE))).toBe(wallet.address);
  });

  it('is case-insensitive on the claimed address', () => {
    expect(
      verifySiwe({
        message: MESSAGE,
        signature: wallet.sign(MESSAGE),
        address: wallet.address.toLowerCase(),
      }),
    ).toBe(true);
  });

  it('rejects a signature over a different message', () => {
    expect(
      verifySiwe({ message: `${MESSAGE} tampered`, signature: wallet.sign(MESSAGE), address: wallet.address }),
    ).toBe(false);
  });

  it('rejects another wallet claiming the signature', () => {
    const other = evmWallet('siwe-unit-other');
    expect(verifySiwe({ message: MESSAGE, signature: wallet.sign(MESSAGE), address: other.address })).toBe(false);
  });

  it('accepts the 0/1 recovery-id form as well as 27/28', () => {
    const sig = wallet.sign(MESSAGE);
    const legacy = sig.slice(0, -2) + (Number.parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0');
    expect(verifySiwe({ message: MESSAGE, signature: legacy, address: wallet.address })).toBe(true);
  });

  it('refuses malformed signatures instead of throwing', () => {
    for (const bad of ['', '0x', '0xdeadbeef', '0x' + 'f'.repeat(130), '0x' + 'z'.repeat(130)]) {
      expect(verifySiwe({ message: MESSAGE, signature: bad, address: wallet.address })).toBe(false);
    }
  });

  it('hashes with the EIP-191 prefix over the byte length, not the character count', () => {
    // A multi-byte message: prefixing with `.length` would be wrong here.
    const message = 'héllo';
    const bytes = new TextEncoder().encode(message);
    expect(bytes.length).toBe(6);
    const expected = keccak_256(
      new Uint8Array([
        ...new TextEncoder().encode(`\u0019Ethereum Signed Message:\n6`),
        ...bytes,
      ]),
    );
    expect(Buffer.from(personalSignHash(message))).toEqual(Buffer.from(expected));
  });
});

describe('ERC-1271 ABI encoding', () => {
  it('uses the magic value as the selector', () => {
    const selector = Buffer.from(
      keccak_256(new TextEncoder().encode('isValidSignature(bytes32,bytes)')),
    )
      .subarray(0, 4)
      .toString('hex');
    expect(selector).toBe(EIP1271_SELECTOR);
    expect(EIP1271_MAGIC).toBe(`0x${EIP1271_SELECTOR}`);
  });

  it('lays out selector, hash, offset, length and a word-padded tail', () => {
    const hash = personalSignHash(MESSAGE);
    const signature = '0x' + 'ab'.repeat(65);
    const data = encodeIsValidSignature(hash, signature).replace(/^0x/, '');

    expect(data.slice(0, 8)).toBe(EIP1271_SELECTOR);
    expect(data.slice(8, 72)).toBe(Buffer.from(hash).toString('hex'));
    expect(Number.parseInt(data.slice(72, 136), 16)).toBe(0x40);
    expect(Number.parseInt(data.slice(136, 200), 16)).toBe(65);
    expect(data.slice(200, 330)).toBe('ab'.repeat(65));
    // 65 bytes pads up to three whole words; a short tail is a decode revert.
    expect((data.length - 200) / 2).toBe(96);
  });

  it('encodes an oversized 4337-style signature without truncating it', () => {
    const signature = '0x' + 'cd'.repeat(400);
    const data = encodeIsValidSignature(personalSignHash(MESSAGE), signature).replace(/^0x/, '');
    expect(Number.parseInt(data.slice(136, 200), 16)).toBe(400);
    expect(data).toContain('cd'.repeat(400));
  });

  it('reads the magic value out of a return word', () => {
    expect(isEip1271Success(`0x${EIP1271_SELECTOR}${'0'.repeat(56)}`)).toBe(true);
    expect(isEip1271Success(`0x${'0'.repeat(64)}`)).toBe(false);
    expect(isEip1271Success('0x')).toBe(false);
    expect(isEip1271Success('')).toBe(false);
  });
});

describe('contract-account verification', () => {
  const account = contractWallet('siwe-1271');

  it('admits a smart account whose signature does not recover to itself', async () => {
    const signature = account.sign(MESSAGE);
    // This is the case ecrecover alone gets wrong.
    expect(verifySiwe({ message: MESSAGE, signature, address: account.address })).toBe(false);
    expect(recoverSiweAddress(MESSAGE, signature)).toBe(account.ownerAddress);

    await expect(
      verifySiweFull({ message: MESSAGE, signature, address: account.address }, account),
    ).resolves.toBe(true);
  });

  it('refuses the same account when the owner did not sign', async () => {
    const impostor = evmWallet('siwe-1271-impostor');
    await expect(
      verifySiweFull(
        { message: MESSAGE, signature: impostor.sign(MESSAGE), address: account.address },
        account,
      ),
    ).resolves.toBe(false);
  });

  it('refuses a signature over a different message', async () => {
    await expect(
      verifySiweFull(
        { message: `${MESSAGE} tampered`, signature: account.sign(MESSAGE), address: account.address },
        account,
      ),
    ).resolves.toBe(false);
  });

  it('refuses the contract account when no caller is configured', async () => {
    // Degrades to the pre-fallback behaviour rather than failing open.
    await expect(
      verifySiweFull({ message: MESSAGE, signature: account.sign(MESSAGE), address: account.address }),
    ).resolves.toBe(false);
  });

  it('treats a reverting call as a refusal, not a crash', async () => {
    const reverting: EthCaller = {
      ethCall: async () => {
        throw new Error('execution reverted');
      },
    };
    await expect(
      verifySiweFull({ message: MESSAGE, signature: account.sign(MESSAGE), address: account.address }, reverting),
    ).resolves.toBe(false);
  });

  it('treats empty return data from a codeless address as a refusal', async () => {
    const eoaLike: EthCaller = { ethCall: async () => '0x' };
    await expect(
      verifySiweFull({ message: MESSAGE, signature: account.sign(MESSAGE), address: account.address }, eoaLike),
    ).resolves.toBe(false);
  });

  it('never calls out for a valid EOA signature', async () => {
    const wallet = evmWallet('siwe-eoa-nocall');
    let calls = 0;
    const counting: EthCaller = {
      ethCall: async () => {
        calls++;
        return '0x';
      },
    };
    await expect(
      verifySiweFull({ message: MESSAGE, signature: wallet.sign(MESSAGE), address: wallet.address }, counting),
    ).resolves.toBe(true);
    // The common path must stay a local computation.
    expect(calls).toBe(0);
  });

  it('still rejects a malformed address before touching the chain', async () => {
    let calls = 0;
    const counting: EthCaller = {
      ethCall: async () => {
        calls++;
        return `0x${EIP1271_SELECTOR}${'0'.repeat(56)}`;
      },
    };
    await expect(
      verifySiweFull({ message: MESSAGE, signature: '0x00', address: 'not-an-address' }, counting),
    ).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it('accepts a signature far longer than 65 bytes if the account vouches for it', async () => {
    // ERC-4337 validation logic can accept arbitrary blobs, so the fallback
    // must not inherit the ECDSA length gate.
    const vouching: EthCaller = { ethCall: async () => `0x${EIP1271_SELECTOR}${'0'.repeat(56)}` };
    await expect(
      verifySiweFull(
        { message: MESSAGE, signature: '0x' + 'ab'.repeat(300), address: account.address },
        vouching,
      ),
    ).resolves.toBe(true);
  });
});
