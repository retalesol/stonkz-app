import { expect, test, type Page } from '@playwright/test';
import { acceptConfirmDialogs } from './accept-dialogs.js';
import {
  MOCK_EVM_ADDRESS,
  MOCK_SOL_ADDRESS,
  connectWithMockWallet,
  installMockWallets,
  stubChainRpc,
  walletRecord,
} from './mock-wallets.js';

/**
 * Phase B — real connect and real broadcast, in a live-mode build.
 *
 * The other half of `e2e/wallet.spec.ts`, separated only because
 * `test.use({ launchOptions })` has to be top-level in a file. Read that
 * file's header for why these mock wallets are the honest way to test this,
 * and `live.spec.ts`'s for how to bring up the stack these need.
 *
 * The wallet picker only opens in a live-mode build (`app/wallet.ts`'s
 * `connectWallet` short-circuits in sim mode, because a sandbox with no
 * server has nothing for a real wallet to authenticate against), so a live
 * API is a hard requirement here rather than a convenience.
 */

test.skip(
  process.env['LIVE_E2E'] !== '1',
  "the wallet picker only opens in a live-mode build \u2014 see this file's header and live.spec.ts",
);

test.describe.configure({ mode: 'serial' });

// Same two local-only workarounds live.spec.ts documents: a CSP with no
// `http://localhost` in `connect-src`, and Chrome's local-network blocking.
test.use({
  launchOptions: {
    args: [
      '--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessForWorkers',
    ],
  },
});

/**
 * `index.html`'s CSP has no `http://localhost` in `connect-src` — see live.spec.ts.
 *
 * Non-document requests `fallback()` rather than `continue()`: this handler
 * matches everything, and Playwright runs the most recently registered
 * handler first, so `continue()` here would send the chain RPC calls
 * `stubChainRpc` is meant to answer straight out to the real network.
 */
async function relaxCsp(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({
      response: res,
      body: body.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src *; base-uri 'self'; form-action 'self'; object-src 'none'\">",
      ),
    });
  });
}

test('the picker lists the detected Solana wallet and connects it with a real SIWS signature', async ({
  page,
}) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await page.click('#connectBtn');
  await page.click('[data-net="SOL"]');

  // Discovered over the Wallet Standard registry, named by the wallet
  // itself — nothing about "Mock Phantom" is known to the app.
  await expect(page.locator('#walletScrim')).toBeVisible();
  await expect(page.locator('#walletBody')).toContainText('Mock Phantom');
  await expect(page.locator('#walletBody')).toContainText('SOLANA');

  await page.click('[data-wallet="Mock Phantom"]');
  await expect(page.locator('#wchip')).toBeVisible({ timeout: 15_000 });

  // The challenge the wallet was asked to sign is the server's own nonce
  // message, verbatim — `apps/api/src/auth/siws.ts` verifies it byte for
  // byte, so a rewritten or re-encoded message would fail there.
  const signed = await walletRecord<string>(page, '__signedSiws');
  expect(signed).toContain('wants you to sign in');
  expect(signed).toContain(MOCK_SOL_ADDRESS);
  // The wallet's address, not a locally generated one.
  await expect(page.locator('#wchip')).toContainText(MOCK_SOL_ADDRESS.slice(0, 4));
  await expect(page.locator('#practiceBadge')).toBeHidden();
});

test('declining in the wallet keeps the picker open with the reason, and connects nothing', async ({
  page,
}) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page, { reject: true });
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await page.click('#connectBtn');
  await page.click('[data-net="SOL"]');
  await page.click('[data-wallet="Mock Phantom"]');

  // A decline is a user decision, so it reads as one and offers a way back
  // — not a red generic failure, and not a connected session.
  await expect(page.locator('#walletBody')).toContainText('REJECTED IN WALLET');
  await expect(page.locator('#wp-retry')).toBeVisible();
  await expect(page.locator('#wchip')).toBeHidden();

  await page.click('#wp-retry');
  await expect(page.locator('#walletBody')).toContainText('Mock Phantom');
  await page.click('#wp-cancel');
  await expect(page.locator('#walletScrim')).toBeHidden();
  await expect(page.locator('.mm-bubble', { hasText: 'CONNECT CANCELLED' })).toBeVisible();
});

test('Escape closes the picker without connecting', async ({ page }) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await page.click('#connectBtn');
  await page.click('[data-net="SOL"]');
  await expect(page.locator('#walletScrim')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#walletScrim')).toBeHidden();
  await expect(page.locator('#wchip')).toBeHidden();
});

test('with no Solana wallet installed the picker says so instead of connecting something', async ({
  page,
}) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page, { noSolana: true });
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await page.click('#connectBtn');
  await page.click('[data-net="SOL"]');
  // The old build would have signed in with a `localStorage` keypair here.
  await expect(page.locator('#walletBody')).toContainText('NO SOLANA WALLET DETECTED');
  await expect(page.locator('#wchip')).toBeHidden();
});

test('WalletConnect is offered for Robinhood Chain, disabled with its reason when unconfigured', async ({
  page,
}) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await page.click('#connectBtn');
  await page.click('[data-net="RH"]');
  await expect(page.locator('#walletBody')).toContainText('MetaMask');
  // Staging builds pin RH testnet (46630); mainnet builds still show 4663.
  await expect(page.locator('#walletBody')).toContainText(/4663/);

  // Robinhood Wallet is mobile-only, so a desktop user with no extension
  // has no route in but WalletConnect. The row is always present; with no
  // project id configured it is disabled *and explains itself*, rather
  // than vanishing or silently falling back to a fake signer.
  const wc = page.locator('[data-wallet="walletconnect"]');
  await expect(wc).toBeVisible();
  if (!process.env['VITE_WALLETCONNECT_PROJECT_ID']) {
    await expect(wc).toBeDisabled();
    await expect(page.locator('#walletBody')).toContainText('VITE_WALLETCONNECT_PROJECT_ID');
  }
});

test('a Robinhood wallet on the wrong chain is switched to 4663 before anything is signed', async ({
  page,
}) => {
  // Starts on Ethereum mainnet and does not know 4663, so this exercises
  // the whole ladder: switch -> 4902 -> add -> switch -> verify.
  acceptConfirmDialogs(page);
  await installMockWallets(page, { evmChainId: '0x1', evmUnknownChain: true });
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.route('**/trade/prepare', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        net: 'RH',
        atomic: true,
        to: '0x1111111111111111111111111111111111111111',
        data: '0xdeadbeef',
        value: '200000000000000000',
        quote: {
          sym: 'COPIUM',
          net: 'RH',
          side: 'buy',
          nativeUnit: 'ETH',
          amountIn: 0.2,
          amountOut: 200_000,
          minOut: 197_000,
          // `apps/api`'s `router/compose.ts` pushes the CURVE hop
          // unconditionally on every path, so a quote never has an empty
          // `hops` — and `api/live.ts` reads `hops[0]` on the sell side.
          hops: [
            {
              venue: 'CURVE',
              inSymbol: 'ETH',
              outSymbol: 'COPIUM',
              inAmount: 0.2,
              outAmount: 200_000,
              impactPct: 1,
              feeBps: 250,
              feeAmount: 0.005,
            },
          ],
          routeLabel: 'CURVE',
          effFeePct: 2.5,
          impactPct: 1,
          expiresAt: Date.now() + 8000,
        },
        expiresAt: Date.now() + 30_000,
      }),
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await connectWithMockWallet(page, 'RH');
  // Sign-in must not require a chain switch: `personal_sign` is
  // chain-agnostic and mobile wallets often cannot switch at all
  // (`docs/robinhood-chain.md` §6.1).
  expect(await walletRecord<string[]>(page, '__rpcCalls')).not.toContain('wallet_switchEthereumChain');
  expect(await walletRecord<string>(page, '__signedSiwe')).toBeTruthy();

  const card = page.locator('.coin[data-sym="COPIUM"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await page.click('#t-go');
  await expect(page.locator('.mm-bubble', { hasText: /FILLED|was successful/ })).toBeVisible({ timeout: 20_000 });

  const calls = await walletRecord<string[]>(page, '__rpcCalls');
  expect(calls).toContain('wallet_switchEthereumChain');
  expect(calls).toContain('wallet_addEthereumChain');
  expect(calls).toContain('eth_sendTransaction');
  // Added from the documented parameters, not guessed.
  const added = await walletRecord<{ chainId: string; rpcUrls: string[] }>(page, '__addedChain');
  expect(added.chainId).toBe('0x1237');

  // The transaction sent is the one the API prepared, with the wei value
  // hex-encoded — 0.2 ETH.
  const sent = await walletRecord<{ to: string; data: string; value: string }>(page, '__sentTx');
  expect(sent.to).toBe('0x1111111111111111111111111111111111111111');
  expect(sent.data).toBe('0xdeadbeef');
  expect(sent.value).toBe('0x2c68af0bb140000');
});

test('a slippage revert is reported as slippage, before the wallet is ever prompted', async ({ page }) => {
  // `wallet/evm.ts` pre-simulates with `eth_call`; a revert found there
  // costs the trader nothing and still carries its reason string, which is
  // the only way "SLIPPAGE EXCEEDED" can be distinguished from a bare
  // failed receipt after the fact.
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page, { revert: true });
  await relaxCsp(page);
  await page.route('**/trade/prepare', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        net: 'RH',
        atomic: true,
        to: '0x1111111111111111111111111111111111111111',
        data: '0xdeadbeef',
        value: '0',
        quote: {
          sym: 'COPIUM',
          net: 'RH',
          side: 'buy',
          nativeUnit: 'ETH',
          amountIn: 0.2,
          amountOut: 200_000,
          minOut: 197_000,
          // `apps/api`'s `router/compose.ts` pushes the CURVE hop
          // unconditionally on every path, so a quote never has an empty
          // `hops` — and `api/live.ts` reads `hops[0]` on the sell side.
          hops: [
            {
              venue: 'CURVE',
              inSymbol: 'ETH',
              outSymbol: 'COPIUM',
              inAmount: 0.2,
              outAmount: 200_000,
              impactPct: 1,
              feeBps: 250,
              feeAmount: 0.005,
            },
          ],
          routeLabel: 'CURVE',
          effFeePct: 2.5,
          impactPct: 1,
          expiresAt: Date.now() + 8000,
        },
        expiresAt: Date.now() + 30_000,
      }),
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await connectWithMockWallet(page, 'RH');
  const card = page.locator('.coin[data-sym="COPIUM"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await page.click('#t-go');

  await expect(page.locator('.mm-bubble', { hasText: 'SLIPPAGE EXCEEDED' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.mm-bubble', { hasText: /FILLED|was successful/ })).toBeHidden();
  // Nothing was signed, which is the point of simulating first.
  expect(await walletRecord<string[]>(page, '__rpcCalls')).not.toContain('eth_sendTransaction');
  // The trade button is usable again, not stuck mid-sign.
  await expect(page.locator('#t-go')).toBeEnabled();
});

test('the wallet menu disconnect ends the wallet session, not just the chip', async ({ page }) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await connectWithMockWallet(page, 'SOL');
  await page.click('#wchip');
  await page.click('[data-w="disconnect"]');
  await expect(page.locator('#connectBtn')).toBeVisible();
  await expect(page.locator('.mm-bubble', { hasText: 'WALLET DISCONNECTED' })).toBeVisible();

  // Reconnecting goes back through the picker and signs again — the old
  // JWT was cleared with the session it was bound to.
  await connectWithMockWallet(page, 'SOL');
  await expect(page.locator('#wchip')).toContainText(MOCK_SOL_ADDRESS.slice(0, 4));
});

test('a Solana trade broadcasts through the wallet and reports the real signature', async ({ page }) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.route('**/trade/prepare', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        net: 'SOL',
        atomic: true,
        transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        lastValidBlockHeight: 999_999,
        quote: {
          sym: 'DEVCOIN',
          net: 'SOL',
          side: 'buy',
          nativeUnit: 'SOL',
          amountIn: 0.5,
          amountOut: 500_000,
          minOut: 492_500,
          hops: [
            {
              venue: 'CURVE',
              inSymbol: 'SOL',
              outSymbol: 'DEVCOIN',
              inAmount: 0.5,
              outAmount: 120_000,
              impactPct: 1,
              feeBps: 250,
              feeAmount: 0.0125,
            },
          ],
          routeLabel: 'CURVE',
          effFeePct: 2.5,
          impactPct: 1,
          expiresAt: Date.now() + 8000,
        },
        expiresAt: Date.now() + 30_000,
      }),
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  // Connect first, then navigate client-side: a cold `goto('/t/DEVCOIN')`
  // would boot with the wallet disconnected again, and a real trade now
  // genuinely requires a connected signer — which is the change.
  await connectWithMockWallet(page, 'SOL');
  const card = page.locator('.coin[data-sym="DEVCOIN"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await page.click('#t-go');
  await expect(page.locator('.mm-bubble', { hasText: /FILLED|was successful/ })).toBeVisible({ timeout: 20_000 });

  // The wallet really received the API's serialised transaction bytes.
  expect(await walletRecord<number>(page, '__sentSolBytes')).toBeGreaterThan(0);
});

test('an EIP-712 permit is signed with a nonce read from the chain, not from the API', async ({ page }) => {
  acceptConfirmDialogs(page);
  await installMockWallets(page);
  await stubChainRpc(page);
  await relaxCsp(page);
  await page.route('**/rpc.mainnet.chain.robinhood.com/**', async (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method: string };
    // `nonces(owner)` — the read `wallet/permit.ts` makes immediately
    // before signing, because the API deliberately returns `nonce: null`.
    if (body.method === 'eth_call') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + (7).toString(16).padStart(64, '0') }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route('**/trade/prepare', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { permit?: unknown };
    const base = {
      net: 'RH',
      atomic: true,
      to: '0x1111111111111111111111111111111111111111',
      data: '0xdeadbeef',
      value: '0',
      quote: {
        sym: 'COPIUM',
        net: 'RH',
        side: 'sell',
        nativeUnit: 'ETH',
        amountIn: 200_000,
        amountOut: 0.19,
        minOut: 0.187,
        hops: [
          {
            venue: 'CURVE',
            inSymbol: 'COPIUM',
            outSymbol: 'ETH',
            inAmount: 200_000,
            outAmount: 0.19,
            impactPct: 1,
            feeBps: 250,
            feeAmount: 0.00475,
          },
        ],
        routeLabel: 'CURVE',
        effFeePct: 2.5,
        impactPct: 1,
        expiresAt: Date.now() + 8000,
      },
      expiresAt: Date.now() + 30_000,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        body.permit
          ? base
          : {
              ...base,
              permitTypedData: {
                domain: {
                  name: 'COPIUM',
                  version: '1',
                  chainId: 4663,
                  verifyingContract: '0x4444444444444444444444444444444444444444',
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
                  owner: MOCK_EVM_ADDRESS,
                  spender: '0x1111111111111111111111111111111111111111',
                  value: '200000000000000000000000',
                  nonce: null,
                  deadline: 1893456000,
                },
                note: 'nonce is not pre-fetched: read nonces(owner) before signing.',
              },
            },
      ),
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');

  await connectWithMockWallet(page, 'RH');
  const card = page.locator('.coin[data-sym="COPIUM"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await page.click('#t-side [data-s="SELL"]');
  await page.click('#t-go');

  await expect(page.locator('#txScrim')).toBeVisible();
  await expect(page.locator('#steps-go')).toHaveText('SIGN STEP 1 OF 2');
  await page.click('#steps-go');
  await expect(page.locator('#steps-go')).toHaveText('SIGN STEP 2 OF 2');
  await page.click('#steps-go');
  await expect(page.locator('.mm-bubble', { hasText: /FILLED|was successful/ })).toBeVisible({ timeout: 20_000 });

  const typed = JSON.parse(await walletRecord<string>(page, '__signedTypedData')) as {
    types: Record<string, unknown>;
    message: Record<string, unknown>;
  };
  // The nonce came off the chain (7), not from the API's null.
  expect(typed.message['nonce']).toBe('7');
  // `EIP712Domain` added, and the API's `note` sibling dropped — a wallet
  // rejects typed data carrying members that are not in `types`.
  expect(typed.types['EIP712Domain']).toBeDefined();
  expect(Object.keys(typed.message).sort()).toEqual(['deadline', 'nonce', 'owner', 'spender', 'value']);
});
