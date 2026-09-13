import { expect, type Page } from '@playwright/test';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';

/**
 * Mock wallets for the browser, injected before any app code runs.
 *
 * A real Phantom or Robinhood Wallet cannot be driven from CI: one is a
 * browser extension Playwright cannot install and authorise, the other is an
 * iOS/Android app reachable only over a WalletConnect relay. What *can* be
 * driven is the interface between them and this app, and that interface is a
 * published standard on both chains — the Wallet Standard registry on Solana,
 * EIP-1193 plus EIP-6963 on Robinhood Chain.
 *
 * So these implement the standards rather than stub the app. Everything from
 * `wallet/solana.ts`'s feature detection and base58 signature encoding
 * through `wallet/evm.ts`'s EIP-6963 discovery, chain-4663 enforcement,
 * `eth_sendTransaction` and receipt wait runs for real against them; only the
 * key material and the chain behind it are fake. That is a categorically
 * different thing from the signer this phase deleted, which faked the app's
 * own internals and therefore tested nothing.
 *
 * What is deliberately *not* covered: whether a real wallet honours these
 * methods the way the standard says. `docs/robinhood-chain.md` row 34 already
 * flags `personal_sign` support in Robinhood Wallet as unconfirmed, and no
 * amount of mocking can settle that — only a real device can.
 */

export interface MockWalletOptions {
  /** Base58 pubkey the mock Solana wallet reports. */
  solAddress?: string;
  /** Checksummed address the mock EVM wallet reports. */
  evmAddress?: string;
  /** Chain the mock EVM wallet starts on, so a switch can be exercised. Hex. */
  evmChainId?: string;
  /** Refuse `wallet_switchEthereumChain` with 4902, forcing the add-chain path. */
  evmUnknownChain?: boolean;
  /** Reject every prompt with EIP-1193 `4001`, as a declining user would. */
  reject?: boolean;
  /** Omit the Solana wallet entirely, e.g. to assert the empty-picker copy. */
  noSolana?: boolean;
  /** Omit `window.ethereum`, leaving WalletConnect as the only Robinhood route. */
  noEvm?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Real keys, held outside the page                                            */
/* -------------------------------------------------------------------------- */

/**
 * The mock wallets sign with **real keypairs**, and they have to.
 *
 * `apps/api`'s auth does real cryptographic verification — `auth/siws.ts` is
 * ed25519 over the exact nonce message, `auth/siwe.ts` is secp256k1 with an
 * EIP-191 prefix — with no fixture bypass anywhere. A canned signature is
 * rejected with `signature does not verify`, which is the server behaving
 * correctly, so a mock that returns one tests the sign-in handshake not at
 * all.
 *
 * The keys live in the Node process and are reached over
 * `page.exposeFunction`, rather than being bundled into the page: a signer
 * inside `addInitScript` would mean shipping an ed25519 implementation as an
 * inline string. The wallet the app sees is still a plain Wallet Standard /
 * EIP-1193 object whose signing method happens to be async — which it is in
 * every real wallet too, because a real one is talking to an extension
 * process or a phone.
 *
 * Fixed private keys, so addresses are stable and assertable across runs.
 * These are test keys with no funds and no purpose beyond this harness.
 */
const SOL_PRIVATE_KEY = new Uint8Array(32).fill(7);
const EVM_PRIVATE_KEY = new Uint8Array(32).fill(11);

function toChecksumAddress(lower: string): string {
  const body = lower.replace(/^0x/, '').toLowerCase();
  const hash = Buffer.from(keccak_256(body)).toString('hex');
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** Base58 pubkey the mock Solana wallet reports, derived from its real key. */
export const MOCK_SOL_ADDRESS = bs58.encode(ed25519.getPublicKey(SOL_PRIVATE_KEY));

/** EIP-55 address the mock Robinhood wallet reports, derived from its real key. */
export const MOCK_EVM_ADDRESS = toChecksumAddress(
  '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(EVM_PRIVATE_KEY, false).slice(1))).toString('hex').slice(24),
);

/** ed25519 over the raw message bytes — what `auth/siws.ts` verifies. */
function signSiws(messageHex: string): string {
  const bytes = Uint8Array.from(Buffer.from(messageHex, 'hex'));
  return bs58.encode(ed25519.sign(bytes, SOL_PRIVATE_KEY));
}

/** EIP-191 personal_sign over the message — what `auth/siwe.ts` recovers from. */
function signSiwe(messageHex: string): string {
  const bytes = Uint8Array.from(Buffer.from(messageHex, 'hex'));
  const prefix = new TextEncoder().encode('\u0019Ethereum Signed Message:\n' + bytes.length);
  const digest = keccak_256(Uint8Array.from([...prefix, ...bytes]));
  const sig = secp256k1.sign(digest, EVM_PRIVATE_KEY);
  const v = (27 + sig.recovery).toString(16).padStart(2, '0');
  return '0x' + sig.toCompactHex() + v;
}

/**
 * Where a mock transaction "landed".
 *
 * These *are* canned, and unlike the sign-in signatures nothing verifies
 * them: there is no chain in this harness to accept a transaction, so a
 * transaction signature is only ever a handle the app carries around. What is
 * asserted instead is that the wallet was handed the bytes the API prepared —
 * see `walletRecord`.
 */
export const MOCK_SOL_SIGNATURE = '4NPvhqRP2r3vGrfvUvUAsUJoNvzYALJUmR2VuPFULsSJqacDdyMoREfEV9x9FSVEFVxUXZWs4hLdWCC1Bn9Ynz9Y';
export const MOCK_EVM_TX_HASH = '0x9d8f7c6b5a4938271605f4e3d2c1b0a998877665544332211ffeeddccbbaa9988';

/**
 * Install the mocks. Must run before `page.goto()` — EIP-6963 and Wallet
 * Standard registration are both announcement protocols, and a wallet that
 * announces after the app has stopped listening is a wallet that does not
 * exist, which is exactly the behaviour being relied on here.
 */
export async function installMockWallets(page: Page, options: MockWalletOptions = {}): Promise<void> {
  // Real signing, done in Node with the keys above. Registered before the
  // init script so the wallet objects can await them.
  await page.exposeFunction('__mockSignSiws', (messageHex: string) => signSiws(messageHex));
  await page.exposeFunction('__mockSignSiwe', (messageHex: string) => signSiwe(messageHex));

  await page.addInitScript(
    (opts: MockWalletOptions & { solSig: string; evmHash: string; solAddr: string; evmAddr: string }) => {
      const REJECTION = { code: 4001, message: 'User rejected the request.' };
      const win = window as unknown as Record<string, unknown>;
      const toHex = (bytes: Uint8Array): string => {
        let out = '';
        for (const b of bytes) out += b.toString(16).padStart(2, '0');
        return out;
      };
      const signSiws = (bytes: Uint8Array): Promise<string> =>
        (win['__mockSignSiws'] as (h: string) => Promise<string>)(toHex(bytes));
      const signSiwe = (hexOrText: string): Promise<string> => {
        const hex = hexOrText.startsWith('0x') ? hexOrText.slice(2) : toHex(new TextEncoder().encode(hexOrText));
        return (win['__mockSignSiwe'] as (h: string) => Promise<string>)(hex);
      };

      /* ---------------------------------------------------------------- */
      /* Solana: Wallet Standard                                          */
      /* ---------------------------------------------------------------- */

      const bs58 = (() => {
        const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        return {
          decode(str: string): Uint8Array {
            let n = 0n;
            for (const ch of str) {
              const i = A.indexOf(ch);
              if (i < 0) throw new Error('bad base58');
              n = n * 58n + BigInt(i);
            }
            const bytes: number[] = [];
            while (n > 0n) {
              bytes.unshift(Number(n % 256n));
              n /= 256n;
            }
            for (const ch of str) {
              if (ch !== '1') break;
              bytes.unshift(0);
            }
            return new Uint8Array(bytes);
          },
        };
      })();

      if (!opts.noSolana) {
        const address = opts.solAddress ?? opts.solAddr;
        const publicKey = bs58.decode(address);
        // Only the *transaction* signature is canned — see the note on
        // MOCK_SOL_SIGNATURE. The sign-in signature is real.
        const txSignature = bs58.decode(opts.solSig);
        const account = {
          address,
          publicKey,
          chains: ['solana:devnet'],
          features: ['solana:signMessage', 'solana:signAndSendTransaction'],
          label: undefined,
          icon: undefined,
        };

        const wallet = {
          version: '1.0.0',
          name: 'Mock Phantom',
          icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
          chains: ['solana:devnet'],
          accounts: [account],
          features: {
            'standard:connect': {
              version: '1.0.0',
              connect: async () => {
                if (opts.reject) throw REJECTION;
                return { accounts: [account] };
              },
            },
            'standard:disconnect': { version: '1.0.0', disconnect: async () => undefined },
            'standard:events': { version: '1.0.0', on: () => () => undefined },
            'solana:signMessage': {
              version: '1.0.0',
              signMessage: async (input: { message: Uint8Array }) => {
                if (opts.reject) throw REJECTION;
                win['__signedSiws'] = new TextDecoder().decode(input.message);
                // A genuine ed25519 signature over exactly these bytes, so
                // `apps/api`'s `auth/siws.ts` verifier accepts it.
                const sig = await signSiws(input.message);
                return [{ signedMessage: input.message, signature: bs58.decode(sig) }];
              },
            },
            'solana:signAndSendTransaction': {
              version: '1.0.0',
              signAndSendTransaction: async (input: { transaction: Uint8Array }) => {
                if (opts.reject) throw REJECTION;
                win['__sentSolBytes'] = input.transaction.length;
                return [{ signature: txSignature }];
              },
            },
          },
        };

        // Both halves of the Wallet Standard handshake, because either side
        // may load first: announce now for an app that is already listening,
        // and answer `app-ready` for an app that starts listening later.
        const register = (api: { register: (w: unknown) => void }): void => {
          api.register(wallet);
        };
        window.addEventListener('wallet-standard:app-ready', ((ev: CustomEvent<{ register: (w: unknown) => void }>) =>
          register(ev.detail)) as EventListener);
        window.dispatchEvent(
          new CustomEvent('wallet-standard:register-wallet', { detail: register }),
        );
      }

      /* ---------------------------------------------------------------- */
      /* Robinhood Chain: EIP-1193 + EIP-6963                             */
      /* ---------------------------------------------------------------- */

      if (!opts.noEvm) {
        const address = opts.evmAddress ?? opts.evmAddr;
        let chainId = opts.evmChainId ?? '0x1237';
        let chainKnown = !opts.evmUnknownChain;
        const record = (key: string, value: unknown): void => {
          win[key] = value;
        };
        record('__rpcCalls', []);

        const provider = {
          isMetaMask: true,
          async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
            (win['__rpcCalls'] as string[]).push(args.method);
            switch (args.method) {
              case 'eth_requestAccounts':
              case 'eth_accounts':
                if (opts.reject) throw REJECTION;
                return [address.toLowerCase()];
              case 'eth_chainId':
                return chainId;
              case 'wallet_switchEthereumChain': {
                if (!chainKnown) throw { code: 4902, message: 'Unrecognized chain ID.' };
                if (opts.reject) throw REJECTION;
                chainId = (args.params?.[0] as { chainId: string }).chainId;
                return null;
              }
              case 'wallet_addEthereumChain': {
                if (opts.reject) throw REJECTION;
                record('__addedChain', args.params?.[0]);
                chainKnown = true;
                return null;
              }
              case 'personal_sign': {
                if (opts.reject) throw REJECTION;
                const message = args.params?.[0] as string;
                record('__signedSiwe', message);
                // A genuine secp256k1 signature with the EIP-191 prefix, so
                // `apps/api`'s `auth/siwe.ts` recovers this address from it.
                return await signSiwe(message);
              }
              case 'eth_signTypedData_v4': {
                if (opts.reject) throw REJECTION;
                record('__signedTypedData', args.params?.[1]);
                return '0x' + 'cd'.repeat(64) + '1c';
              }
              case 'eth_sendTransaction': {
                if (opts.reject) throw REJECTION;
                record('__sentTx', args.params?.[0]);
                return opts.evmHash;
              }
              default:
                throw { code: 4200, message: 'Unsupported method: ' + args.method };
            }
          },
          on: () => undefined,
          removeListener: () => undefined,
        };

        win['ethereum'] = provider;

        // Announce as MetaMask: the RH picker only offers MetaMask + WalletConnect
        // (`listEvmWallets`), so a fake "Robinhood Wallet" rdns never appears.
        const detail = {
          info: {
            uuid: '11111111-2222-3333-4444-555555555555',
            name: 'MetaMask',
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
            rdns: 'io.metamask',
          },
          provider,
        };
        const announce = (): void => {
          window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze(detail) }));
        };
        window.addEventListener('eip6963:requestProvider', announce);
        announce();
      }
    },
    {
      ...options,
      solSig: MOCK_SOL_SIGNATURE,
      evmHash: MOCK_EVM_TX_HASH,
      solAddr: MOCK_SOL_ADDRESS,
      evmAddr: MOCK_EVM_ADDRESS,
    },
  );
}

/**
 * Stub the chain reads the wallet layer makes on its own.
 *
 * `wallet/solana.ts` polls `getSignatureStatuses` before it resolves, and
 * `wallet/evm.ts` pre-simulates with `eth_call` and then waits for a receipt.
 * That confirmation wait is real code doing real work, so it needs answers —
 * these are the answers a chain that accepted the transaction would give.
 */
export async function stubChainRpc(
  page: Page,
  over: { revert?: boolean; receiptStatus?: '0x0' | '0x1' } = {},
): Promise<void> {
  const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });

  await page.route('**/api.mainnet-beta.solana.com/**', async (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method: string };
    const results: Record<string, unknown> = {
      getSignatureStatuses: {
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
      },
      getBlockHeight: 1,
      getBalance: { context: { slot: 1 }, value: 2_500_000_000 },
      getLatestBlockhash: {
        context: { slot: 1 },
        value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 999_999 },
      },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reply(body.id, results[body.method] ?? null)),
    });
  });

  // Staging web builds target Solana devnet.
  await page.route('**/api.devnet.solana.com/**', async (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method: string };
    const results: Record<string, unknown> = {
      getSignatureStatuses: {
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
      },
      getBlockHeight: 1,
      getBalance: { context: { slot: 1 }, value: 2_500_000_000 },
      getLatestBlockhash: {
        context: { slot: 1 },
        value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 999_999 },
      },
      sendTransaction: MOCK_SOL_SIGNATURE,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reply(body.id, results[body.method] ?? null)),
    });
  });

  await page.route('**/rpc.mainnet.chain.robinhood.com/**', async (route) => {
    const body = route.request().postDataJSON() as {
      id: unknown;
      method: string;
      params?: [{ data?: string }, ...unknown[]];
    };
    if (body.method === 'eth_call' && over.revert) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: 3, message: 'execution reverted: Too little received' },
        }),
      });
      return;
    }
    // EIP-2612 `nonces(address)` — empty `0x` breaks viem decode in permit.ts.
    const callData = body.params?.[0]?.data ?? '';
    const ethCallResult =
      body.method === 'eth_call' && typeof callData === 'string' && callData.startsWith('0x7ecebe00')
        ? '0x' + (7).toString(16).padStart(64, '0')
        : '0x';
    const results: Record<string, unknown> = {
      eth_chainId: '0x1237',
      eth_call: ethCallResult,
      eth_getBalance: '0x1bc16d674ec80000',
      eth_blockNumber: '0x10',
      eth_getTransactionReceipt: {
        transactionHash: MOCK_EVM_TX_HASH,
        blockNumber: '0x10',
        blockHash: '0x' + '11'.repeat(32),
        transactionIndex: '0x0',
        from: MOCK_EVM_ADDRESS.toLowerCase(),
        to: '0x1111111111111111111111111111111111111111',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs: [],
        logsBloom: '0x' + '00'.repeat(256),
        status: over.receiptStatus ?? '0x1',
        type: '0x2',
      },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reply(body.id, results[body.method] ?? null)),
    });
  });

  // Staging RH testnet (46630) — same stub surface as mainnet RPC above.
  await page.route('**/rpc.testnet.chain.robinhood.com/**', async (route) => {
    const body = route.request().postDataJSON() as {
      id: unknown;
      method: string;
      params?: [{ data?: string }, ...unknown[]];
    };
    if (body.method === 'eth_call' && over.revert) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: 3, message: 'execution reverted: Too little received' },
        }),
      });
      return;
    }
    const callData = body.params?.[0]?.data ?? '';
    const ethCallResult =
      body.method === 'eth_call' && typeof callData === 'string' && callData.startsWith('0x7ecebe00')
        ? '0x' + (7).toString(16).padStart(64, '0')
        : '0x';
    const results: Record<string, unknown> = {
      eth_chainId: '0xb616', // 46630
      eth_call: ethCallResult,
      eth_getBalance: '0x1bc16d674ec80000',
      eth_blockNumber: '0x10',
      eth_getTransactionReceipt: {
        transactionHash: MOCK_EVM_TX_HASH,
        blockNumber: '0x10',
        blockHash: '0x' + '11'.repeat(32),
        transactionIndex: '0x0',
        from: MOCK_EVM_ADDRESS.toLowerCase(),
        to: '0x1111111111111111111111111111111111111111',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs: [],
        logsBloom: '0x' + '00'.repeat(256),
        status: over.receiptStatus ?? '0x1',
        type: '0x2',
      },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reply(body.id, results[body.method] ?? null)),
    });
  });
}

/** Read a value the mock wallet recorded, to assert what it was really asked. */
export async function walletRecord<T>(page: Page, key: string): Promise<T> {
  return page.evaluate((k) => (window as unknown as Record<string, unknown>)[k] as T, key) as Promise<T>;
}

/** The picker row ids the mocks register under. */
export const MOCK_SOL_WALLET_ID = 'Mock Phantom';
export const MOCK_EVM_WALLET_ID = 'injected:io.metamask';

/**
 * Connect in live mode: network, then wallet.
 *
 * Two clicks where there used to be one, and that second click is the whole
 * point of this phase — the app now asks which wallet, because there is a
 * real choice to make.
 */
export async function connectWithMockWallet(page: Page, net: 'SOL' | 'RH'): Promise<void> {
  if (await page.locator('#netMenu').isHidden()) await page.click('#connectBtn');
  await page.click(`[data-net="${net}"]`);
  await expect(page.locator('#walletScrim')).toBeVisible();
  await page.click(`[data-wallet="${net === 'SOL' ? MOCK_SOL_WALLET_ID : MOCK_EVM_WALLET_ID}"]`);
  await expect(page.locator('#walletScrim')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#wchip')).toBeVisible({ timeout: 15_000 });
  // Picker closes before `api.connect` finishes reloading the board — wait for
  // the success toast so net-scoped coins are in place before the next assert.
  // Avoid bare "CONNECTED": "WALLET DISCONNECTED" also matches that substring.
  const connected = net === 'SOL' ? 'SOLANA CONNECTED' : 'ROBINHOOD CONNECTED';
  await expect(page.locator('.mm-bubble', { hasText: connected })).toBeVisible({ timeout: 15_000 });
}
