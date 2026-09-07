import { afterEach, describe, expect, it } from 'vitest';
import type { Wallet } from '@wallet-standard/base';
import { RH_CHAIN_ID, RH_CHAIN_ID_HEX, chainLabel, solanaWalletStandardChain } from './chain.js';
import { WalletError, describeWalletError, isRejection, mapWalletError, walletErrorHeadline } from './errors.js';
import { enforceRhChain, listEvmWallets, toHexWei, type ChainRequest, type Eip1193Provider } from './evm.js';
import { availableWallets, connectWalletFor, disconnectActive, preferRealWallet, requireWallet, sortChoices } from './manager.js';
import { PRACTICE_WALLET_ID, connectPracticeWallet, practiceWalletChoice, practiceWalletEnabled } from './practice.js';
import { openSolanaWallet, solanaWalletChoice } from './solana.js';
import type { WalletChoice } from './types.js';
import { walletConnectUnavailableReason } from './walletconnect.js';

/**
 * The wallet layer's unit tests.
 *
 * These run under vitest's `node` environment (see `vitest.config.ts`), which
 * is a deliberate constraint rather than an accident: everything asserted
 * here is reachable without a DOM, an extension or a network, which is the
 * same property that makes it reachable in CI. The parts that genuinely need
 * a browser — the picker modal, EIP-6963 announcement handling, the badge —
 * are covered by `e2e/wallet.spec.ts` against injected mock wallets instead.
 *
 * What is under test, in order:
 *
 * 1. Error mapping. The single most load-bearing behaviour change of this
 *    phase: the simulated signer had exactly one failure mode, and a real one
 *    has a dozen that a trader must be able to tell apart.
 * 2. Chain-ID enforcement for chain 4663, including the switch/add/manual
 *    ladder and the wallet that answers a switch with a silent no-op.
 * 3. Practice-mode gating — specifically that it *cannot* activate with the
 *    build flag off, and that a real wallet outranks it when both exist.
 * 4. Wallet selection: which detected wallets are offered, and which are
 *    offered as disabled with a reason instead of hidden.
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

/** The same, for a function that throws synchronously. */
function caught(fn: () => unknown): WalletError {
  try {
    fn();
  } catch (e) {
    return e as WalletError;
  }
  throw new Error('expected a throw');
}

/* -------------------------------------------------------------------------- */
/* 1. Error mapping                                                           */
/* -------------------------------------------------------------------------- */

describe('mapWalletError: EIP-1193 codes', () => {
  it('reads 4001 as the user declining, not as a fault', () => {
    const err = mapWalletError({ code: 4001, message: 'User rejected the request.' });
    expect(err.kind).toBe('rejected');
    expect(isRejection(err)).toBe(true);
  });

  it('maps the rest of the 4xxx range to distinct kinds', () => {
    expect(mapWalletError({ code: 4100 }).kind).toBe('not_connected');
    expect(mapWalletError({ code: 4200 }).kind).toBe('unsupported_method');
    expect(mapWalletError({ code: 4900 }).kind).toBe('network');
    expect(mapWalletError({ code: 4901 }).kind).toBe('wrong_chain');
    expect(mapWalletError({ code: 4902 }).kind).toBe('chain_unsupported');
  });

  it('accepts a stringified code, which some relays send', () => {
    expect(mapWalletError({ code: '4001', message: 'nope' }).kind).toBe('rejected');
  });

  it('turns -32002 into advice rather than a retry loop', () => {
    const err = mapWalletError({ code: -32002, message: 'Already processing eth_requestAccounts.' });
    expect(err.kind).toBe('rejected');
    expect(err.message).toContain('already waiting');
  });
});

describe('mapWalletError: text patterns', () => {
  it('recognises each wallet vendor\u2019s own wording for a decline', () => {
    for (const text of [
      'User rejected the request',
      'User denied transaction signature',
      'MetaMask Tx Signature: User denied transaction signature.',
      'The user rejected the request through the wallet',
      'Transaction was rejected',
      'User disapproved requested methods',
    ]) {
      expect(mapWalletError(new Error(text)).kind).toBe('rejected');
    }
  });

  it('separates a gas shortfall from a generic failure', () => {
    expect(mapWalletError(new Error('insufficient funds for gas * price + value')).kind).toBe('insufficient_funds');
    // The Solana runtime's phrasing for an account that never held anything —
    // exactly what the unfunded practice key produces.
    expect(
      mapWalletError(new Error('Attempt to debit an account but found no record of a prior credit.')).kind,
    ).toBe('insufficient_funds');
  });

  it('reports a missed min-out as slippage, not as a bare revert', () => {
    // Both of these also contain "reverted"; slippage has to win, because
    // "REVERTED ON CHAIN" tells a trader nothing they can act on.
    expect(mapWalletError(new Error('execution reverted: Too little received')).kind).toBe('slippage');
    expect(mapWalletError(new Error('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT')).kind).toBe('slippage');
    expect(mapWalletError(new Error('custom program error: 0x1771')).kind).toBe('slippage');
  });

  it('keeps a non-slippage revert as a revert', () => {
    expect(mapWalletError(new Error('execution reverted')).kind).toBe('reverted');
    expect(mapWalletError(new Error('Program failed to complete')).kind).toBe('reverted');
  });

  it('classifies transport failures as network, not as unknown', () => {
    expect(mapWalletError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(mapWalletError(new Error('Blockhash not found')).kind).toBe('network');
    expect(mapWalletError(new Error('429 Too Many Requests')).kind).toBe('network');
  });

  it('falls back to unknown, carrying the provider\u2019s own text', () => {
    const err = mapWalletError(new Error('Something inscrutable happened'));
    expect(err.kind).toBe('unknown');
    expect(err.message).toBe('Something inscrutable happened');
  });

  it('uses the caller\u2019s fallback when the provider said nothing at all', () => {
    expect(mapWalletError({}, 'could not sign').message).toBe('could not sign');
  });
});

describe('mapWalletError: nested shapes', () => {
  it('digs the reason out of MetaMask\u2019s data.originalError', () => {
    const err = mapWalletError({
      code: -32603,
      message: 'Internal JSON-RPC error.',
      data: { originalError: { message: 'insufficient funds for transfer' } },
    });
    expect(err.kind).toBe('insufficient_funds');
  });

  it('walks viem\u2019s cause chain, for both text and code', () => {
    expect(mapWalletError(new Error('outer', { cause: new Error('User rejected the request') })).kind).toBe('rejected');
    expect(mapWalletError({ message: 'outer', cause: { code: 4902 } }).kind).toBe('chain_unsupported');
  });

  it('survives a self-referential cause instead of recursing forever', () => {
    const err: { message: string; cause?: unknown } = { message: 'loop' };
    err.cause = err;
    expect(mapWalletError(err).kind).toBe('unknown');
  });

  it('passes an already-mapped error through without flattening its kind', () => {
    const original = new WalletError('slippage', 'price moved');
    expect(mapWalletError(original)).toBe(original);
  });
});

describe('user-facing copy', () => {
  it('gives each kind its own headline', () => {
    expect(walletErrorHeadline(new WalletError('slippage', 'x'))).toBe('SLIPPAGE EXCEEDED');
    expect(walletErrorHeadline(new WalletError('insufficient_funds', 'x'))).toBe('INSUFFICIENT FUNDS');
    expect(walletErrorHeadline(new WalletError('rejected', 'x'))).toBe('REJECTED IN WALLET');
    expect(walletErrorHeadline(new WalletError('wrong_chain', 'x'))).toBe('WRONG CHAIN');
  });

  it('appends the provider\u2019s reason to the headline', () => {
    expect(describeWalletError(new WalletError('slippage', 'Too little received'))).toBe(
      'SLIPPAGE EXCEEDED \u00b7 TOO LITTLE RECEIVED',
    );
  });

  it('does not label a non-wallet failure as a wallet error', () => {
    // An API validation failure routed through the same toast must not claim
    // to have come from the wallet.
    expect(describeWalletError(new Error('quote expired'))).toBe('QUOTE EXPIRED');
  });

  it('never renders an empty toast', () => {
    expect(describeWalletError(new WalletError('reverted', ''))).toBe('REVERTED ON CHAIN');
    expect(describeWalletError(new Error(''))).toBe('WALLET ERROR');
  });

  it('treats only a rejection as a rejection', () => {
    expect(isRejection(new WalletError('reverted', 'x'))).toBe(false);
    expect(isRejection(new Error('User rejected'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Chain-ID enforcement                                                    */
/* -------------------------------------------------------------------------- */

/** A scripted EIP-1193 endpoint that records what it was asked. */
function scriptedChain(script: Record<string, unknown | (() => unknown)>): {
  request: ChainRequest;
  calls: string[];
} {
  const calls: string[] = [];
  const request: ChainRequest = async (method) => {
    calls.push(method);
    const entry = script[method];
    if (entry === undefined) throw { code: 4200, message: 'Unsupported method: ' + method };
    const value = typeof entry === 'function' ? (entry as () => unknown)() : entry;
    if (value instanceof Error || (value && typeof value === 'object' && 'code' in value)) throw value;
    return value;
  };
  return { request, calls };
}

describe('enforceRhChain', () => {
  it('prompts for nothing when the wallet is already on 4663', async () => {
    const { request, calls } = scriptedChain({ eth_chainId: RH_CHAIN_ID_HEX });
    await expect(enforceRhChain(request)).resolves.toBeUndefined();
    // One read and no switch: a needless prompt on every trade is how people
    // are trained to click through prompts.
    expect(calls).toEqual(['eth_chainId']);
  });

  it('accepts a decimal chain id, which some mobile wallets return', async () => {
    const { request } = scriptedChain({ eth_chainId: String(RH_CHAIN_ID) });
    await expect(enforceRhChain(request)).resolves.toBeUndefined();
  });

  it('switches a wallet that is on the wrong chain', async () => {
    let chain = '0x1';
    const { request, calls } = scriptedChain({
      eth_chainId: () => chain,
      wallet_switchEthereumChain: () => {
        chain = RH_CHAIN_ID_HEX;
        return null;
      },
    });
    await enforceRhChain(request);
    expect(calls).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  });

  it('adds chain 4663 when the wallet has never seen it, then switches', async () => {
    let chain = '0x1';
    let added = false;
    const { request, calls } = scriptedChain({
      eth_chainId: () => chain,
      wallet_switchEthereumChain: () => {
        if (!added) throw { code: 4902, message: 'Unrecognized chain ID.' };
        chain = RH_CHAIN_ID_HEX;
        return null;
      },
      wallet_addEthereumChain: () => {
        added = true;
        return null;
      },
    });
    await enforceRhChain(request);
    expect(calls).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_chainId',
    ]);
  });

  it('surfaces a declined switch as a rejection', async () => {
    const { request } = scriptedChain({
      eth_chainId: '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: 4001, message: 'User rejected the request.' };
      },
    });
    await expect(enforceRhChain(request)).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('surfaces a declined add-chain as a rejection, not as chain_unsupported', async () => {
    const { request } = scriptedChain({
      eth_chainId: '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: 4902, message: 'Unrecognized chain ID.' };
      },
      wallet_addEthereumChain: () => {
        throw { code: 4001, message: 'User rejected the request.' };
      },
    });
    await expect(enforceRhChain(request)).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('tells the user to switch manually when the wallet has no switch method', async () => {
    // Many mobile wallets, Robinhood Wallet included, expose no
    // `wallet_switchEthereumChain` at all. Retrying cannot help, so the copy
    // has to name the manual action.
    const { request } = scriptedChain({ eth_chainId: '0x1' });
    const err = await rejection(enforceRhChain(request));
    expect(err).toBeInstanceOf(WalletError);
    expect(err.kind).toBe('wrong_chain');
    expect(err.message).toContain('in the wallet itself');
    expect(err.message).toContain(String(RH_CHAIN_ID));
  });

  it('refuses to continue when a switch silently no-ops', async () => {
    // The dangerous case: the wallet resolves the switch and stays put.
    // Signing after this would broadcast to the wrong chain.
    const { request } = scriptedChain({ eth_chainId: '0x1', wallet_switchEthereumChain: null });
    const err = await rejection(enforceRhChain(request));
    expect(err.kind).toBe('wrong_chain');
    expect(err.message).toContain('still on chain 1');
  });

  it('reports an unreadable chain id rather than assuming 4663', async () => {
    const { request } = scriptedChain({
      eth_chainId: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(enforceRhChain(request)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('toHexWei', () => {
  it('encodes the decimal wei strings the API returns', () => {
    expect(toHexWei('0')).toBe('0x0');
    expect(toHexWei('')).toBe('0x0');
    expect(toHexWei('1000000000000000000')).toBe('0xde0b6b3a7640000');
    // Beyond Number.MAX_SAFE_INTEGER, so this has to go through BigInt.
    expect(toHexWei('123456789012345678901234567890')).toBe('0x18ee90ff6c373e0ee4e3f0ad2');
  });

  it('passes hex through untouched', () => {
    expect(toHexWei('0x2a')).toBe('0x2a');
  });

  it('refuses a value it cannot encode instead of sending 0', () => {
    // Silently coercing a malformed value to zero would send a transaction
    // that pays nothing and reverts, with no clue why.
    expect(() => toHexWei('1.5')).toThrow(WalletError);
    expect(() => toHexWei('abc')).toThrow(/cannot encode/);
  });
});

describe('chain config', () => {
  it('pins Robinhood Chain to 4663 / 0x1237', () => {
    expect(RH_CHAIN_ID).toBe(4663);
    expect(RH_CHAIN_ID_HEX).toBe('0x1237');
  });

  it('maps every cluster to its Wallet Standard chain id', () => {
    expect(solanaWalletStandardChain('mainnet-beta')).toBe('solana:mainnet');
    expect(solanaWalletStandardChain('devnet')).toBe('solana:devnet');
    expect(solanaWalletStandardChain('testnet')).toBe('solana:testnet');
    expect(solanaWalletStandardChain('localnet')).toBe('solana:localnet');
  });

  it('labels the chain a net settles on', () => {
    expect(chainLabel('RH')).toContain('4663');
    expect(chainLabel('SOL')).toContain('SOLANA');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Practice-mode gating                                                    */
/* -------------------------------------------------------------------------- */

describe('practice-mode gating', () => {
  it('is off unless the flag is exactly 1', () => {
    expect(practiceWalletEnabled({})).toBe(false);
    expect(practiceWalletEnabled({ VITE_PRACTICE_WALLET: '' })).toBe(false);
    expect(practiceWalletEnabled({ VITE_PRACTICE_WALLET: '0' })).toBe(false);
    expect(practiceWalletEnabled({ VITE_PRACTICE_WALLET: 'false' })).toBe(false);
    // Not even a truthy-looking string opts in, so a stray `=true` in a
    // deploy config cannot switch a production build to a fake signer.
    expect(practiceWalletEnabled({ VITE_PRACTICE_WALLET: 'true' })).toBe(false);
    expect(practiceWalletEnabled({ VITE_PRACTICE_WALLET: '1' })).toBe(true);
  });

  it('is off in this test environment, i.e. by default', () => {
    expect(practiceWalletEnabled()).toBe(false);
  });

  it('offers no picker row when the flag is off', () => {
    expect(practiceWalletChoice('SOL', {})).toBeNull();
    expect(practiceWalletChoice('RH', { VITE_PRACTICE_WALLET: '0' })).toBeNull();
  });

  it('cannot be constructed when the flag is off', () => {
    // The property the whole gate exists for: no code path, however it is
    // reached, yields a practice signer in a production build.
    const err = caught(() => connectPracticeWallet('SOL', {}));
    expect(err).toBeInstanceOf(WalletError);
    expect(err.kind).toBe('no_wallet');
    expect(err.message).toContain('VITE_PRACTICE_WALLET=1');
  });

  it('names itself honestly in the picker when the flag is on', () => {
    const choice = practiceWalletChoice('RH', { VITE_PRACTICE_WALLET: '1' });
    expect(choice).toMatchObject({ id: PRACTICE_WALLET_ID, kind: 'practice', net: 'RH' });
    expect(choice?.name).toContain('nothing settles');
  });

  it('flags every broadcast as simulated and holds no balance', async () => {
    const wallet = connectPracticeWallet('SOL', { VITE_PRACTICE_WALLET: '1' });
    expect(wallet.practice).toBe(true);
    const result = await wallet.signAndSend({ net: 'SOL', transaction: 'AA==' });
    // The flag the UI reads to keep from reporting a settlement that did not
    // happen; the signature is prefixed so it cannot be mistaken for real.
    expect(result.simulated).toBe(true);
    expect(result.signature.startsWith('SIMULATED-')).toBe(true);
    expect(await wallet.nativeBalance()).toBe(0);
  });

  it('refuses an EIP-712 permit rather than forging one', async () => {
    // A permit signature is verified on chain against a real nonce. A fake
    // one would fail at the router with no explanation, so say so up front.
    const wallet = connectPracticeWallet('RH', { VITE_PRACTICE_WALLET: '1' });
    await expect(wallet.signTypedData?.({})).rejects.toMatchObject({ kind: 'unsupported_method' });
  });

  it('will not sign for the other chain', async () => {
    const wallet = connectPracticeWallet('SOL', { VITE_PRACTICE_WALLET: '1' });
    await expect(wallet.signAndSend({ net: 'RH', to: '0x0', data: '0x', value: '0' })).rejects.toMatchObject({
      kind: 'unsupported_method',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Wallet selection                                                        */
/* -------------------------------------------------------------------------- */

function choice(over: Partial<WalletChoice> & { id: string }): WalletChoice {
  return { net: 'RH', kind: 'evm-injected', name: over.id, ...over };
}

describe('selection order: a real wallet always wins', () => {
  it('sorts practice last, behind even an unavailable real wallet', () => {
    const order = sortChoices([
      choice({ id: 'practice', kind: 'practice' }),
      choice({ id: 'walletconnect', kind: 'evm-walletconnect', unavailable: 'no project id' }),
      choice({ id: 'metamask' }),
    ]).map((c) => c.id);
    expect(order).toEqual(['metamask', 'walletconnect', 'practice']);
  });

  it('is stable among equals, so the picker does not reshuffle on re-render', () => {
    const ids = sortChoices([choice({ id: 'a' }), choice({ id: 'b' }), choice({ id: 'c' })]).map((c) => c.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('never auto-selects practice while any real wallet is usable', () => {
    const picked = preferRealWallet([
      choice({ id: 'practice', kind: 'practice' }),
      choice({ id: 'phantom', kind: 'solana-standard', net: 'SOL' }),
    ]);
    expect(picked?.id).toBe('phantom');
  });

  it('skips a real wallet that is unavailable rather than picking it and failing', () => {
    const picked = preferRealWallet([
      choice({ id: 'walletconnect', kind: 'evm-walletconnect', unavailable: 'no project id' }),
      choice({ id: 'practice', kind: 'practice' }),
    ]);
    expect(picked?.id).toBe('practice');
  });

  it('picks nothing when nothing is usable', () => {
    expect(preferRealWallet([])).toBeNull();
    expect(preferRealWallet([choice({ id: 'wc', unavailable: 'nope' })])).toBeNull();
  });
});

describe('WalletConnect availability', () => {
  it('reports the missing project id instead of hiding the row', () => {
    const reason = walletConnectUnavailableReason('');
    expect(reason).toContain('VITE_WALLETCONNECT_PROJECT_ID');
    // Names *why* it matters, since a desktop user has no other route in.
    expect(reason).toContain('mobile-only');
  });

  it('is available once a project id is configured', () => {
    expect(walletConnectUnavailableReason('abc123')).toBeNull();
  });

  it('still lists WalletConnect as a disabled row with the reason', () => {
    // No project id is set in the test environment, which is the deployment
    // mistake this row exists to explain.
    const wc = listEvmWallets().find((c) => c.id === 'walletconnect');
    expect(wc).toBeDefined();
    expect(wc?.unavailable).toContain('VITE_WALLETCONNECT_PROJECT_ID');
  });
});

describe('injected EVM discovery', () => {
  afterEach(async () => {
    delete (globalThis as { ethereum?: unknown }).ethereum;
    await disconnectActive();
  });

  it('finds a legacy window.ethereum with no EIP-6963 announcement', () => {
    (globalThis as { ethereum?: unknown }).ethereum = { request: async () => [], isMetaMask: true };
    expect(listEvmWallets().map((c) => c.id)).toContain('injected:window.ethereum');
    expect(listEvmWallets().find((c) => c.id === 'injected:window.ethereum')?.name).toBe('MetaMask');
  });

  it('ignores an `ethereum` global that is not a provider', () => {
    (globalThis as { ethereum?: unknown }).ethereum = { notAProvider: true };
    expect(listEvmWallets().map((c) => c.id)).not.toContain('injected:window.ethereum');
  });

  it('connects it, checksums the account, and reports it as real', async () => {
    const provider: Eip1193Provider = {
      request: async ({ method }) =>
        method === 'eth_requestAccounts' ? ['0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'] : null,
    };
    (globalThis as { ethereum?: unknown }).ethereum = provider;
    const wallet = await connectWalletFor('RH', { id: 'injected:window.ethereum' });
    // EIP-55, because the SIWE message the API echoes back is checksummed.
    expect(wallet.address).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(wallet.practice).toBe(false);
    expect(wallet.net).toBe('RH');
    expect(requireWallet('RH')).toBe(wallet);
  });

  it('reports a declined authorisation as a rejection', async () => {
    (globalThis as { ethereum?: unknown }).ethereum = {
      request: async () => {
        throw { code: 4001, message: 'User rejected the request.' };
      },
    };
    await expect(connectWalletFor('RH', { id: 'injected:window.ethereum' })).rejects.toMatchObject({
      kind: 'rejected',
    });
  });

  it('reports an empty account list as a rejection rather than connecting to nothing', async () => {
    (globalThis as { ethereum?: unknown }).ethereum = { request: async () => [] };
    await expect(connectWalletFor('RH', { id: 'injected:window.ethereum' })).rejects.toMatchObject({
      kind: 'rejected',
    });
  });

  it('refuses to connect an unavailable choice, with its reason', async () => {
    await expect(connectWalletFor('RH', { id: 'walletconnect' })).rejects.toMatchObject({ kind: 'unconfigured' });
  });
});

describe('the connected-wallet requirement', () => {
  afterEach(() => disconnectActive());

  it('asks for a connection instead of throwing something opaque', () => {
    const err = caught(() => requireWallet('SOL'));
    expect(err.kind).toBe('not_connected');
    expect(err.message).toContain('Connect a wallet');
  });

  it('will not sign a Solana action with a Robinhood wallet connected', async () => {
    (globalThis as { ethereum?: unknown }).ethereum = {
      request: async () => ['0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'],
    };
    await connectWalletFor('RH', { id: 'injected:window.ethereum' });
    const err = caught(() => requireWallet('SOL'));
    expect(err.kind).toBe('not_connected');
    expect(err.message).toContain('Switch networks');
    delete (globalThis as { ethereum?: unknown }).ethereum;
  });

  it('explains that Robinhood Wallet is mobile-only when nothing is detected', async () => {
    const err = await rejection(connectWalletFor('RH', { id: 'nope:missing' }));
    expect(err.kind).toBe('no_wallet');
  });

  it('names the wallets to install when Solana has none, without offering practice', async () => {
    expect(availableWallets('SOL')).toEqual([]);
    const err = await rejection(connectWalletFor('SOL'));
    expect(err.kind).toBe('no_wallet');
    expect(err.message).toContain('Phantom');
    // The flag is off here, so the copy must not dangle a practice option.
    expect(err.message).not.toContain('practice');
  });
});

/* -------------------------------------------------------------------------- */
/* Solana Wallet Standard selection                                           */
/* -------------------------------------------------------------------------- */

/** A Wallet Standard wallet with exactly the features named. */
function standardWallet(over: {
  name?: string;
  chains?: string[];
  connect?: boolean;
  signMessage?: boolean;
  signAndSend?: boolean;
  signTransaction?: boolean;
  account?: { address: string };
}): Wallet {
  const account = { address: over.account?.address ?? 'So11111111111111111111111111111111111111112', publicKey: new Uint8Array(32), chains: [], features: [] };
  const features: Record<string, unknown> = {};
  if (over.connect !== false) features['standard:connect'] = { version: '1.0.0', connect: async () => ({ accounts: [account] }) };
  if (over.signMessage !== false) {
    features['solana:signMessage'] = { version: '1.0.0', signMessage: async () => [{ signedMessage: new Uint8Array(), signature: new Uint8Array(64) }] };
  }
  if (over.signAndSend) {
    features['solana:signAndSendTransaction'] = { version: '1.0.0', signAndSendTransaction: async () => [{ signature: new Uint8Array(64) }] };
  }
  if (over.signTransaction) {
    features['solana:signTransaction'] = { version: '1.0.0', signTransaction: async () => [{ signedTransaction: new Uint8Array() }] };
  }
  return {
    version: '1.0.0',
    name: over.name ?? 'Phantom',
    icon: 'data:image/svg+xml;base64,AA==',
    chains: (over.chains ?? ['solana:mainnet']) as `${string}:${string}`[],
    features,
    accounts: [account],
  } as unknown as Wallet;
}

describe('solanaWalletChoice', () => {
  it('offers a wallet that can connect, sign a message and broadcast', () => {
    const c = solanaWalletChoice(standardWallet({ signAndSend: true }));
    expect(c).toMatchObject({ id: 'Phantom', kind: 'solana-standard', net: 'SOL' });
    // Wallet Standard icons are `data:` URIs by spec, so the picker makes no
    // third-party request.
    expect(c?.icon?.startsWith('data:')).toBe(true);
  });

  it('accepts a sign-only wallet, which we broadcast for', () => {
    expect(solanaWalletChoice(standardWallet({ signTransaction: true }))).not.toBeNull();
  });

  it('hides a wallet on the wrong cluster rather than failing on click', () => {
    expect(solanaWalletChoice(standardWallet({ signAndSend: true, chains: ['solana:devnet'] }))).toBeNull();
  });

  it('hides a wallet that cannot sign a message, since SIWS would be impossible', () => {
    expect(solanaWalletChoice(standardWallet({ signAndSend: true, signMessage: false }))).toBeNull();
  });

  it('hides a wallet that can neither send nor sign a transaction', () => {
    expect(solanaWalletChoice(standardWallet({}))).toBeNull();
  });

  it('hides a wallet with no connect feature', () => {
    expect(solanaWalletChoice(standardWallet({ signAndSend: true, connect: false }))).toBeNull();
  });
});

describe('openSolanaWallet', () => {
  it('authorises an account and base58-encodes the SIWS signature', async () => {
    const wallet = await openSolanaWallet(standardWallet({ signAndSend: true }));
    expect(wallet.net).toBe('SOL');
    expect(wallet.label).toBe('PHANTOM');
    expect(wallet.practice).toBe(false);
    // `auth/siws.ts` decodes base58 — a hex or base64 signature is rejected.
    const sig = await wallet.signInMessage('ston.kz wants you to sign in');
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('refuses a wallet whose cluster does not match ours', async () => {
    await expect(openSolanaWallet(standardWallet({ signAndSend: true, chains: ['solana:devnet'] }))).rejects.toMatchObject(
      { kind: 'unsupported_method' },
    );
  });

  it('will not sign a Robinhood transaction', async () => {
    const wallet = await openSolanaWallet(standardWallet({ signAndSend: true }));
    await expect(wallet.signAndSend({ net: 'RH', to: '0x0', data: '0x', value: '0' })).rejects.toMatchObject({
      kind: 'unsupported_method',
    });
  });

  it('reports a declined connect as a rejection', async () => {
    const w = standardWallet({ signAndSend: true });
    (w.features as Record<string, unknown>)['standard:connect'] = {
      version: '1.0.0',
      connect: async () => {
        throw { code: 4001, message: 'User rejected the request.' };
      },
    };
    await expect(openSolanaWallet(w)).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('reports an empty authorisation rather than connecting to nothing', async () => {
    const w = standardWallet({ signAndSend: true });
    (w.features as Record<string, unknown>)['standard:connect'] = {
      version: '1.0.0',
      connect: async () => ({ accounts: [] }),
    };
    await expect(openSolanaWallet(w)).rejects.toMatchObject({ kind: 'rejected' });
  });
});
