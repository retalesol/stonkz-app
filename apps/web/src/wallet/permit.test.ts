import { describe, expect, it } from 'vitest';
import { WalletError } from './errors.js';
import {
  assertPermitShape,
  buildPermitPayload,
  signSellPermit,
  splitSignature,
  type ServerPermitTypedData,
} from './permit.js';
import type { ConnectedWallet } from './types.js';

/**
 * The `StonkzRouter` sell permit, as far as it can be tested without a chain.
 *
 * `readPermitNonce()` is an on-chain read and is deliberately not stubbed
 * here — everything around it is pure, and the guards that matter most (owner
 * mismatch, a wallet with no `eth_signTypedData_v4`, a malformed response)
 * all run *before* the read, so they are reachable with no network at all.
 */

/**
 * Await a promise that must reject, and hand back the error typed.
 *
 * `p.catch((e) => e)` widens to `T | WalletError`, which then needs a cast at
 * every property access; this keeps the assertions readable.
 */
async function rejection(p: Promise<unknown>): Promise<WalletError> {
  const resolved = Symbol('resolved');
  const out = await p.then(
    () => resolved,
    (e: unknown) => e,
  );
  if (out === resolved) throw new Error('expected a rejection, got a resolved promise');
  return out as WalletError;
}

/** A `POST /trade/prepare` `permitTypedData`, verbatim from `evm-router.ts`. */
function serverTypedData(over: { owner?: string } = {}): ServerPermitTypedData {
  return {
    domain: {
      name: 'STONK',
      version: '1',
      chainId: 4663,
      verifyingContract: '0x1111111111111111111111111111111111111111',
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: over.owner ?? '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      value: '1000000000000000000',
      nonce: null,
      deadline: 1893456000,
    },
    // The API ships this alongside the payload; a wallet rejects typed data
    // carrying a member that is not in `types`, so it must not survive.
    note: 'nonce is not pre-fetched: read nonces(owner) …',
  } as ServerPermitTypedData;
}

function stubWallet(over: Partial<ConnectedWallet> = {}): ConnectedWallet {
  return {
    net: 'RH',
    kind: 'evm-injected',
    label: 'METAMASK',
    address: '0x2222222222222222222222222222222222222222',
    practice: false,
    signInMessage: async () => '0x',
    signAndSend: async () => ({ signature: '0x' }),
    signTypedData: async () => '0x' + 'ab'.repeat(64) + '1b',
    nativeBalance: async () => 1,
    disconnect: async () => undefined,
    onAccountChange: () => () => undefined,
    ...over,
  };
}

describe('assertPermitShape', () => {
  it('accepts the API\u2019s own response shape', () => {
    expect(assertPermitShape(serverTypedData()).primaryType).toBe('Permit');
  });

  it('rejects anything it cannot sign, rather than sending a wallet junk', () => {
    for (const bad of [null, undefined, 42, {}, { primaryType: 'Permit' }]) {
      expect(() => assertPermitShape(bad)).toThrow(WalletError);
    }
  });

  it('rejects a payload whose primaryType has no matching type list', () => {
    const td = serverTypedData() as unknown as { primaryType: string };
    td.primaryType = 'Sell';
    expect(() => assertPermitShape(td)).toThrow(/does not recognise/);
  });
});

describe('buildPermitPayload', () => {
  const payload = buildPermitPayload(serverTypedData(), 7n);

  it('substitutes the freshly-read nonce for the API\u2019s null', () => {
    // The API returns `nonce: null` on purpose; signing that would produce a
    // permit the router rejects.
    expect(payload.message['nonce']).toBe('7');
  });

  it('adds the EIP712Domain type entry wallets require', () => {
    expect(payload.types['EIP712Domain']?.map((f) => f.name)).toEqual([
      'name',
      'version',
      'chainId',
      'verifyingContract',
    ]);
    expect(payload.types['Permit']).toHaveLength(5);
  });

  it('drops the API\u2019s note, which is not a typed-data member', () => {
    expect(Object.keys(payload)).toEqual(['domain', 'types', 'primaryType', 'message']);
    expect(Object.keys(payload.message).sort()).toEqual([
      'deadline',
      'nonce',
      'owner',
      'spender',
      'value',
    ]);
  });
});

describe('splitSignature', () => {
  it('splits a 65-byte signature into the router\u2019s PermitData fields', () => {
    const r = 'a'.repeat(64);
    const s = 'b'.repeat(64);
    expect(splitSignature('0x' + r + s + '1c')).toEqual({ v: 28, r: '0x' + r, s: '0x' + s });
  });

  it('normalises a 0/1 recovery id to 27/28 for ecrecover', () => {
    // Some wallets return the raw parity bit; `StonkzToken.permit` calls
    // `ecrecover`, which only accepts 27/28.
    expect(splitSignature('0x' + '0'.repeat(128) + '00').v).toBe(27);
    expect(splitSignature('0x' + '0'.repeat(128) + '01').v).toBe(28);
  });

  it('works without the 0x prefix', () => {
    expect(splitSignature('0'.repeat(128) + '1b').v).toBe(27);
  });

  it('refuses a signature of the wrong length or shape', () => {
    expect(() => splitSignature('0x1234')).toThrow(/wrong length/);
    expect(() => splitSignature('0x' + 'z'.repeat(130))).toThrow(/wrong length/);
  });

  it('refuses an unusable recovery id rather than passing it to the router', () => {
    expect(() => splitSignature('0x' + '0'.repeat(128) + '05')).toThrow(/recovery id/);
  });
});

describe('signSellPermit', () => {
  /** Stands in for the on-chain `nonces(owner)` read. */
  const nonceIs = (n: bigint) => async () => n;

  it('reads the nonce from the token, signs, and returns PermitData', async () => {
    let signed: unknown = null;
    let readFrom: readonly [string, string] | null = null;
    const wallet = stubWallet({
      signTypedData: async (td: unknown) => {
        signed = td;
        return '0x' + 'a'.repeat(64) + 'b'.repeat(64) + '1c';
      },
    });
    const permit = await signSellPermit(wallet, serverTypedData(), async (token, owner) => {
      readFrom = [token, owner];
      return 3n;
    });

    // The nonce is read off the token named in the permit domain, for the
    // owner the permit names — not from the API response.
    expect(readFrom).toEqual([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ]);
    expect((signed as { message: Record<string, unknown> }).message['nonce']).toBe('3');
    // `value` and `deadline` are echoed from the payload the router will
    // re-derive the digest from, so they have to match exactly.
    expect(permit).toEqual({
      value: '1000000000000000000',
      deadline: 1893456000,
      v: 28,
      r: '0x' + 'a'.repeat(64),
      s: '0x' + 'b'.repeat(64),
    });
  });

  it('surfaces a wallet rejection at the permit prompt as a rejection', async () => {
    const wallet = stubWallet({
      signTypedData: async () => {
        throw new WalletError('rejected', 'You declined the request in your wallet.');
      },
    });
    await expect(signSellPermit(wallet, serverTypedData(), nonceIs(0n))).rejects.toMatchObject({
      kind: 'rejected',
    });
  });

  it('refuses a wallet that cannot sign typed data, naming the alternative', async () => {
    // The practice wallet, and any Solana wallet, land here.
    const wallet = stubWallet();
    delete (wallet as { signTypedData?: unknown }).signTypedData;
    const err = await rejection(signSellPermit(wallet, serverTypedData(), nonceIs(0n)));
    expect(err.kind).toBe('unsupported_method');
    expect(err.message).toContain('METAMASK');
  });

  it('refuses to sign a permit that names a different owner', async () => {
    // A permit prepared for another address would be signed happily by the
    // wallet and then rejected on chain, with no useful reason attached.
    const err = await rejection(
      signSellPermit(
        stubWallet(),
        serverTypedData({ owner: '0x9999999999999999999999999999999999999999' }),
        nonceIs(0n),
      ),
    );
    expect(err.message).toContain('different owner');
  });

  it('matches the owner case-insensitively, since checksumming differs', async () => {
    // The wallet checksums its address (EIP-55); the API returns whatever it
    // stored. A case-sensitive comparison would break every real sell.
    const wallet = stubWallet({
      address: '0x2222222222222222222222222222222222222222'.toUpperCase(),
    });
    await expect(signSellPermit(wallet, serverTypedData(), nonceIs(0n))).resolves.toMatchObject({
      v: 27,
    });
  });

  it('rejects a malformed payload before touching the wallet', async () => {
    let prompted = false;
    const wallet = stubWallet({
      signTypedData: async () => {
        prompted = true;
        return '0x';
      },
    });
    await expect(signSellPermit(wallet, { nope: true }, nonceIs(0n))).rejects.toThrow(WalletError);
    expect(prompted).toBe(false);
  });
});
