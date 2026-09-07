import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 1.D live-mode journeys (plan steps 62-70).
 *
 * Everything in `journeys.spec.ts` runs against `api/sim.ts` and stays
 * meaningful after the live swap, which is the point of that file. This file
 * instead asserts the one thing sim mode cannot: that the board, the token
 * page and a net switch are backed by the real API and WS, not `COINS`'
 * hardcoded seed. `net switch changes the visible board set` in particular
 * has no sim equivalent — the sim's `RAW` coins carry no `net` at all.
 *
 * Not part of the default `pnpm test:e2e` run: there is no Postgres/Redis/
 * API/indexer to spin up inside that harness, so every test here is skipped
 * unless `LIVE_E2E=1` is set. To run for real:
 *
 *   docker compose up -d postgres redis   # or point DATABASE_URL/REDIS_URL elsewhere
 *   pnpm --filter @stonkz/api migrate
 *   DATABASE_URL=postgres://stonkz:stonkz@localhost:5432/stonkz \
 *     REDIS_URL=redis://localhost:6379 pnpm --filter @stonkz/api start &
 *   DATABASE_URL=postgres://stonkz:stonkz@localhost:5432/stonkz \
 *     REDIS_URL=redis://localhost:6379 pnpm --filter @stonkz/indexer start &
 *   VITE_API_MODE=live VITE_API_URL=http://localhost:8787 VITE_WS_URL=ws://localhost:8787 \
 *     pnpm --filter @stonkz/web dev &
 *   LIVE_E2E=1 PW_BASE_URL=http://127.0.0.1:5173 pnpm test:e2e e2e/live.spec.ts
 *
 * The fixture scenario (`apps/indexer/src/fixtures/producer.ts`) is small —
 * a couple of tokens per net — so these assert shape and wiring, not scale.
 */

test.skip(
  process.env['LIVE_E2E'] !== '1',
  "live-mode journeys need LIVE_E2E=1 and a running live-mode stack — see this file's header",
);

test.describe.configure({ mode: 'serial' });

// Two local-only-testing wrinkles, neither of which is a production concern:
//
// 1. `index.html`'s CSP is `connect-src 'self' ws: wss: https:` — right for a
//    real deployment (`VITE_API_URL` is `https://api.ston.kz`), but this
//    harness's API runs over plain `http://localhost` with no cert to give
//    it. Patch the meta tag on the served document only.
// 2. Chrome's Private/Local Network Access checks treat `127.0.0.1:5173`
//    fetching `localhost:8787` as a cross-address-space request and block it
//    without a permission prompt Playwright cannot answer. Disabling the
//    feature flags is the documented workaround for automated testing.
test.use({
  launchOptions: {
    args: [
      '--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessForWorkers',
    ],
  },
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    const body = await res.text();
    const patched = body.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src *; base-uri 'self'; form-action 'self'; object-src 'none'\">",
    );
    await route.fulfill({ response: res, body: patched });
  });

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
});

test('land on the board and see real fixture coins with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  await expect(page.locator('.coin').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('opening a shareable /t/:sym URL cold loads real candles, trades and holders', async ({
  page,
}) => {
  const card = page.locator('.coin').first();
  const sym = (await card.getAttribute('data-sym')) as string;

  // A fresh navigation, not a client-side route change: this is what a
  // pasted link actually does.
  await page.goto(`/t/${sym}`);
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page.locator('.tk-id h1')).toContainText(sym);
  await expect(page.locator('#tabbody')).toBeVisible();

  await page.click('[data-tab="holders"]');
  await expect(page.locator('#tabbody tr').first()).toBeVisible();
});

test('back returns to the board from a live token page', async ({ page }) => {
  const card = page.locator('.coin').first();
  const sym = (await card.getAttribute('data-sym')) as string;
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));

  await page.click('#tk-back');
  await expect(page.locator('#boardView')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('the tape opens a token on click', async ({ page }) => {
  const print = page.locator('#tape .tx').last();
  await expect(print).toBeVisible({ timeout: 10_000 });
  const sym = (await print.getAttribute('data-sym')) as string;
  // Hovering (part of Playwright's default click sequence) pins a frozen
  // clone on top of the original print, which then never un-pins on a live
  // (mostly static) tape — Playwright's actionability check sees that clone
  // covering the target and refuses to click through it. `force: true` is
  // safe here: clone and original carry the same `data-sym` and both sit
  // under the tape's one delegated click listener.
  await print.click({ force: true });
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
});

test('sort chips reorder the live board', async ({ page }) => {
  await page.click('.filters .chip[data-sort="mc"]');
  await expect(page.locator('.filters .chip[data-sort="mc"]')).toHaveClass(/on/);
  await expect(page.locator('.coin').first()).toBeVisible();
});

test('the KOTH crown opens its coin on click', async ({ page }) => {
  const koth = page.locator('#koth');
  const sym = (await koth.getAttribute('data-sym')) as string;
  await koth.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
});

test('a net switch reloads the board from the other chain', async ({ page }) => {
  const solSyms = await page
    .locator('.coin')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-sym')));
  expect(solSyms.length).toBeGreaterThan(0);

  await page.click('#connectBtn');
  await page.click('[data-net="RH"]');
  await expect(page.locator('#wchip')).toBeVisible();
  await expect(page.locator('#wNetName')).toHaveText('ROBINHOOD');

  // `GET /tokens?net=RH` replaced `COINS` — a different set than SOL's, not
  // just a relabelled copy of the same one.
  await expect(page.locator('.coin').first()).toBeVisible();
  const rhSyms = await page
    .locator('.coin')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-sym')));
  expect(rhSyms.length).toBeGreaterThan(0);
  expect(rhSyms).not.toEqual(solSyms);
  for (const sym of rhSyms) expect(solSyms).not.toContain(sym);
});

/**
 * Phase 2.C write-path journeys (plan steps 95-99).
 *
 * `POST /trade/prepare`, `/launch/prepare`, `/launch/confirm` and
 * `/fees/claim/prepare` all need a wallet with real balance and, on
 * Robinhood, a deployed `StonkzRouter` to exercise for real — neither exists
 * in this harness (`apps/api/src/chain/fake.ts`'s practice wallets start at
 * zero native balance). Rather than skip the write path entirely, these
 * mock just those endpoints with `page.route()`, in the exact shape a real
 * response takes (`apps/api/src/routes/trade.ts` et al — read from disk, not
 * assumed), while everything else — the board, the token page, `GET
 * .../quote`, and the real SIWS/SIWE handshake `ensureSession()` runs before
 * every one of these calls — stays wired to the real fixture stack above.
 * That keeps these deterministic without faking the one thing actually
 * being tested: that the UI walks a real response shape correctly.
 */
test.describe('trade box, launch and claim — live adapter wiring', () => {
  interface MockHop {
    venue: 'CURVE' | 'JUPITER' | 'UNISWAP';
    inSymbol: string;
    outSymbol: string;
    inAmount: number;
    outAmount: number;
    impactPct: number;
    feeBps: number;
    feeAmount: number;
  }

  interface MockQuote {
    sym: string;
    net: 'SOL' | 'RH';
    side: 'buy' | 'sell';
    nativeUnit: string;
    amountIn: number;
    amountOut: number;
    minOut: number;
    hops: MockHop[];
    routeLabel: string;
    effFeePct: number;
    impactPct: number;
    expiresAt: number;
  }

  const FAKE_SOL_TX =
    'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  function nativePairedQuote(sym: string, side: 'buy' | 'sell', amountIn: number): MockQuote {
    const amountOut = side === 'buy' ? amountIn * 1_000_000 : amountIn;
    return {
      sym,
      net: 'SOL',
      side,
      nativeUnit: 'SOL',
      amountIn,
      amountOut,
      minOut: amountOut * 0.985,
      hops: [
        {
          venue: 'CURVE',
          inSymbol: side === 'buy' ? 'SOL' : sym,
          outSymbol: side === 'buy' ? sym : 'SOL',
          inAmount: side === 'buy' ? amountIn : amountIn * 900_000,
          outAmount: amountOut,
          impactPct: 1.1,
          feeBps: 250,
          feeAmount: amountIn * 0.025,
        },
      ],
      routeLabel: 'CURVE',
      effFeePct: 2.5,
      impactPct: 1.1,
      expiresAt: Date.now() + 8000,
    };
  }

  /** A base-hop quote — no fixture token is paired against anything but the native unit, so this is fabricated end to end (`hopRow` only renders when `hops.length > 1`). */
  function baseHopBuyQuote(sym: string, amountIn: number): MockQuote {
    const baseOut = amountIn * 150;
    const amountOut = baseOut * 1000;
    return {
      sym,
      net: 'SOL',
      side: 'buy',
      nativeUnit: 'SOL',
      amountIn,
      amountOut,
      minOut: amountOut * 0.985,
      hops: [
        {
          venue: 'JUPITER',
          inSymbol: 'SOL',
          outSymbol: 'USDC',
          inAmount: amountIn,
          outAmount: baseOut,
          impactPct: 0.05,
          feeBps: 0,
          feeAmount: 0,
        },
        {
          venue: 'CURVE',
          inSymbol: 'USDC',
          outSymbol: sym,
          inAmount: baseOut,
          outAmount: amountOut,
          impactPct: 1.0,
          feeBps: 250,
          feeAmount: baseOut * 0.025,
        },
      ],
      routeLabel: 'JUPITER \u203A CURVE',
      effFeePct: 2.5,
      impactPct: 1.05,
      expiresAt: Date.now() + 8000,
    };
  }

  /** Intercepts `GET .../quote` for one symbol+side with a fabricated response — only the base-hop case needs this; every other test lets the real fixture curve answer. */
  async function mockQuote(page: Page, sym: string, side: 'buy' | 'sell', quote: MockQuote): Promise<void> {
    await page.route(`**/tokens/${sym}/quote*`, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.searchParams.get('side') !== side) return route.fallback();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quote) });
    });
  }

  async function mockTradePrepareAtomicSol(page: Page, quote: MockQuote): Promise<void> {
    await page.route('**/trade/prepare', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          net: 'SOL',
          atomic: true,
          transaction: FAKE_SOL_TX,
          lastValidBlockHeight: 999_999,
          quote,
          expiresAt: Date.now() + 30_000,
        }),
      });
    });
  }

  /** The `docs/rh-trade-atomicity-gap.md` fallback — no `StonkzRouter` for this base asset, an ordered `EvmStep[]`. */
  async function mockTradePrepareSteps(
    page: Page,
    quote: MockQuote,
    descriptions: string[],
    warning: string,
  ): Promise<void> {
    await page.route('**/trade/prepare', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          net: 'RH',
          atomic: false,
          steps: descriptions.map((description) => ({
            to: '0x2222222222222222222222222222222222222222',
            data: '0x',
            value: '0',
            description,
          })),
          warning,
          quote,
          expiresAt: Date.now() + 30_000,
        }),
      });
    });
  }

  test('SOL buy — native-paired quote is a single curve hop, and the fill only renders after the signed prepare response resolves', async ({
    page,
  }) => {
    const sym = 'DOGGO';
    const quote = nativePairedQuote(sym, 'buy', 0.5);
    await mockTradePrepareAtomicSol(page, quote);

    await page.goto(`/t/${sym}`);
    await expect(page.locator('#tokenView')).toBeVisible();
    // The real `GET .../quote` answers this — a native-paired coin is one
    // curve hop, so the aggregator hop row never renders.
    await expect(page.locator('#t-quote')).toContainText('PRICE IMPACT');
    await expect(page.locator('#t-quote')).not.toContainText('HOP 1');

    const go = page.locator('#t-go');
    await go.click();
    await expect(go).toBeDisabled();
    await expect(page.locator('.toast', { hasText: 'FILLED' })).toBeVisible({ timeout: 15_000 });
    await expect(go).toBeEnabled();
  });

  test('SOL buy — a base-hop quote shows the aggregator leg and still fills atomically', async ({ page }) => {
    const sym = 'DOGGO';
    const amount = 0.5;
    const quote = baseHopBuyQuote(sym, amount);
    await mockQuote(page, sym, 'buy', quote);
    await mockTradePrepareAtomicSol(page, quote);

    await page.goto(`/t/${sym}`);
    await expect(page.locator('#tokenView')).toBeVisible();
    await expect(page.locator('#t-quote')).toContainText('HOP 1');
    await expect(page.locator('#t-quote')).toContainText('HOP 2');
    await expect(page.locator('#t-quote')).toContainText('JUP');

    await page.click('#t-go');
    await expect(page.locator('.toast', { hasText: 'FILLED' })).toBeVisible({ timeout: 15_000 });
  });

  test('SOL sell fills after the signed prepare response resolves', async ({ page }) => {
    const sym = 'DOGGO';
    const quote = nativePairedQuote(sym, 'sell', 0.5);
    await mockTradePrepareAtomicSol(page, quote);

    await page.goto(`/t/${sym}`);
    await expect(page.locator('#tokenView')).toBeVisible();
    await page.click('#t-side [data-s="SELL"]');
    await expect(page.locator('#t-quote')).toContainText('YOU SELL');

    await page.click('#t-go');
    await expect(page.locator('.toast', { hasText: 'FILLED' })).toBeVisible({ timeout: 15_000 });
  });

  test('Robinhood non-atomic EvmStep[] plan walks every step in order with the multi-signature notice visible', async ({
    page,
  }) => {
    const sym = 'RHDOG';
    const amount = 0.2;
    const quote = nativePairedQuote(sym, 'buy', amount);
    quote.net = 'RH';
    quote.nativeUnit = 'ETH';
    const warning =
      'ROBINHOOD CHAIN HAS NO ATOMIC ROUTER CONFIGURED FOR THIS BASE ASSET YET. THIS TRADE REQUIRES 3 SEPARATE ' +
      'SIGNATURES. STOPPING PARTWAY LEAVES YOU HOLDING AN INTERMEDIATE ASSET, NOT ETH.';
    const descriptions = ['Wrap ETH', 'Approve WETH spend', 'Buy RHDOG on StonkzLaunchpad'];
    await mockTradePrepareSteps(page, quote, descriptions, warning);

    // RHDOG only exists on the Robinhood board — `GET /tokens?net=SOL` (the
    // default) never has it, and `bySym()` only ever searches whatever `net`
    // is currently loaded into `COINS`. A client-side net switch reloads
    // that in place; a cold `page.goto('/t/RHDOG')` would instead boot fresh
    // on the default SOL net and 404. Click into it the same way a trader
    // actually would: switch chains, then click the card.
    await page.click('#connectBtn');
    await page.click('[data-net="RH"]');
    await expect(page.locator('#wNetName')).toHaveText('ROBINHOOD');
    const card = page.locator(`.coin[data-sym="${sym}"]`).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('#tokenView')).toBeVisible();

    await page.click('#t-go');
    // Never collapsed into the one-signature Solana path: the modal opens,
    // the warning is pinned and visible, and the header counts signatures,
    // not "confirm".
    await expect(page.locator('#txScrim')).toBeVisible();
    await expect(page.locator('#txBody')).toContainText('3 SEPARATE');
    await expect(page.locator('#txBody')).toContainText('intermediate asset'.toUpperCase());

    for (let i = 1; i <= descriptions.length; i++) {
      await expect(page.locator('#steps-go')).toHaveText(`SIGN STEP ${i} OF ${descriptions.length}`);
      await expect(page.locator('#txBody')).toContainText(`STEP ${i} OF ${descriptions.length}`);
      await expect(page.locator('#txBody')).toContainText(descriptions[i - 1] as string);
      await page.click('#steps-go');
    }

    await expect(page.locator('#txScrim')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.toast', { hasText: 'FILLED' })).toBeVisible();
  });

  /** The `StonkzRouter` path — `docs/rh-trade-atomicity-gap.md`'s "closed" case: one `to`/`data`/`value` call, no `EvmStep[]`. */
  async function mockTradePrepareAtomicRh(page: Page, quote: MockQuote): Promise<void> {
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
          quote,
          expiresAt: Date.now() + 30_000,
        }),
      });
    });
  }

  /**
   * The first-time-sell permit edge case — `live.ts`'s `signTradePlan`
   * branch. The first `POST /trade/prepare` (no `body.permit`) comes back
   * `atomic: true` with `permitTypedData` set; the caller signs that EIP-712
   * payload off-chain and resends with `body.permit`, and the *same*
   * endpoint answers again, this time with `permitTypedData` absent — still
   * one on-chain transaction, two off-chain signatures.
   */
  async function mockTradePrepareRhSellPermit(page: Page, quote: MockQuote): Promise<void> {
    await page.route('**/trade/prepare', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as { permit?: unknown };
      const base = {
        net: 'RH',
        atomic: true,
        to: '0x1111111111111111111111111111111111111111',
        data: '0xdeadbeef',
        value: '0',
        quote,
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
                permitTypedData: { domain: { name: 'RHDOG', version: '1' }, message: {} },
                note: 'Sign the EIP-712 permit, then resend with `permit` set.',
              },
        ),
      });
    });
  }

  test('Robinhood atomic buy — one StonkzRouter call, no step walker, fills like an atomic Solana trade', async ({
    page,
  }) => {
    const sym = 'RHDOG';
    const amount = 0.2;
    const quote = nativePairedQuote(sym, 'buy', amount);
    quote.net = 'RH';
    quote.nativeUnit = 'ETH';
    await mockTradePrepareAtomicRh(page, quote);

    await page.click('#connectBtn');
    await page.click('[data-net="RH"]');
    await expect(page.locator('#wNetName')).toHaveText('ROBINHOOD');
    const card = page.locator(`.coin[data-sym="${sym}"]`).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('#tokenView')).toBeVisible();

    const go = page.locator('#t-go');
    await go.click();
    // Atomic on RH means exactly what it means on SOL: no step modal, one
    // wallet-adapter signature.
    await expect(page.locator('#txScrim')).toBeHidden();
    await expect(page.locator('.toast', { hasText: 'FILLED' })).toBeVisible({ timeout: 15_000 });
    await expect(go).toBeEnabled();
  });

  test('Robinhood atomic sell with no standing permit walks the two off-chain signatures, then fills in one on-chain transaction', async ({
    page,
  }) => {
    const sym = 'RHDOG';
    const amount = 0.2;
    const quote = nativePairedQuote(sym, 'sell', amount);
    quote.net = 'RH';
    quote.nativeUnit = 'ETH';
    await mockTradePrepareRhSellPermit(page, quote);

    await page.click('#connectBtn');
    await page.click('[data-net="RH"]');
    await expect(page.locator('#wNetName')).toHaveText('ROBINHOOD');
    const card = page.locator(`.coin[data-sym="${sym}"]`).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('#tokenView')).toBeVisible();
    await page.click('#t-side [data-s="SELL"]');
    await expect(page.locator('#t-quote')).toContainText('YOU SELL');

    await page.click('#t-go');
    // Two off-chain signatures, walked explicitly — but this is still the
    // atomic path, so the copy must not read like the non-atomic warning.
    await expect(page.locator('#txScrim')).toBeVisible();
    await expect(page.locator('#txBody')).toContainText('one on-chain transaction');
    await expect(page.locator('#txBody')).not.toContainText('SEPARATE SIGNATURES');
    await expect(page.locator('#steps-go')).toHaveText('SIGN STEP 1 OF 2');
    await expect(page.locator('#txBody')).toContainText('permit signature');
    await page.click('#steps-go');

    await expect(page.locator('#steps-go')).toHaveText('SIGN STEP 2 OF 2');
    await expect(page.locator('#txBody')).toContainText('Sell on Robinhood Chain');
    await page.click('#steps-go');

    await expect(page.locator('#txScrim')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.toast', { hasText: 'FILLED' })).toBeVisible();
  });

  test('launching a coin with a dev buy runs the prepare -> sign -> confirm stepper and lands on the new token', async ({
    page,
  }) => {
    const sym = 'ZZZE2E';
    const mint = 'MintE2ELaunch11111111111111111111111111111';

    await page.route('**/launch/prepare', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as { ticker?: string; devBuyNative?: number };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          net: 'SOL',
          intentId: 'intent-e2e-launch',
          ticker: body.ticker ?? sym,
          predictedMint: mint,
          transaction: FAKE_SOL_TX,
          lastValidBlockHeight: 999_999,
          devBuy: (body.devBuyNative ?? 0) > 0 ? { native: body.devBuyNative, atomic: true } : null,
          expiresAt: Date.now() + 30_000,
        }),
      });
    });
    await page.route('**/launch/confirm', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ net: 'SOL', sym, mint, mc: 4_200 }),
      });
    });

    await page.click('#connectBtn');
    await page.click('[data-net="SOL"]');
    await expect(page.locator('#wchip')).toBeVisible();

    await page.click('#createBtn');
    await expect(page.locator('#newScrim')).toBeVisible();
    await page.fill('#f-tick', sym);
    await page.click('#nc-next'); // step 1 -> 2
    await page.click('#nc-next'); // step 2 -> 3 (defaults: native base, default supply/fee)
    await page.fill('#f-buy', '0.50');
    await page.click('#nc-next'); // launch

    await expect(page.locator('.toast', { hasText: 'DEPLOYED ' + sym })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
    await expect(page.locator('.tk-id h1')).toContainText(sym);
  });

  test('claiming creator fees fetches GET /fees, signs the prepared claim, and reports the claimed amount', async ({
    page,
  }) => {
    await page.route('**/fees', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          net: 'SOL',
          nativeUnit: 'SOL',
          vaults: [
            {
              sym: 'DOGGO',
              unclaimedNative: 0.42,
              unclaimedTokens: 0,
              stakerPoolNative: 0.1,
              lifetimeNative: 1.2,
              claimedNative: 0.3,
            },
          ],
        }),
      });
    });
    await page.route('**/fees/claim/prepare', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ net: 'SOL', sym: 'DOGGO', transaction: FAKE_SOL_TX, lastValidBlockHeight: 999_999 }),
      });
    });

    await page.click('#connectBtn');
    await page.click('[data-net="SOL"]');
    await expect(page.locator('#wchip')).toBeVisible();

    // A cold `page.goto('/me')` would boot fresh with the wallet
    // disconnected again (`openProfile()` requires `WALLET.on`) — get there
    // the way a connected trader actually would, through the wallet menu.
    await page.click('#wchip');
    await page.click('[data-w="profile"]');
    await expect(page.locator('#profileView')).toBeVisible();
    await page.click('#claimBtn');
    await expect(page.locator('#claimScrim')).toBeVisible();
    await expect(page.locator('#claimBody')).toContainText('DOGGO');
    await expect(page.locator('#claimBody')).toContainText('0.420 SOL');

    await page.click('#claim-go');
    await expect(page.locator('.toast', { hasText: 'CLAIMED 0.420 SOL' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#claimScrim')).toBeHidden();
  });
});

/**
 * Phase 5 — social layer (plan steps 143-152). Follow and chat run against
 * the real fixture stack end to end — a real SIWS handshake
 * (`ensureSession`), a real `POST`/`DELETE /follow/:net/:addr`, a real
 * `POST /chat/:net/:room` echoed back over the real WS `chat:` channel.
 *
 * The wall's tip is the one exception: `verifyTip` only ever accepts a real,
 * confirmed on-chain transfer, and this harness's practice key
 * (`app/keys.ts`) is never funded — there is no way to make a *real* tip
 * land without a real, funded Solana wallet, live or otherwise. What is
 * tested instead is `app/tip.ts`'s honest failure path: a genuine
 * `@solana/web3.js` broadcast attempt against a (mocked, for determinism)
 * RPC, rejected the way an unfunded wallet's would be, surfaced as a clear
 * toast rather than a fabricated success.
 */
test.describe('Phase 5 — social layer', () => {
  test.beforeEach(async ({ page }) => {
    await page.click('#connectBtn');
    await page.click('[data-net="SOL"]');
    await expect(page.locator('#wchip')).toBeVisible();
    await page.click('#wchip');
    await page.click('[data-w="profile"]');
    await expect(page.locator('#profileView')).toBeVisible();
  });

  test('following and unfollowing a member from their profile calls the real API and flips the button', async ({
    page,
  }) => {
    const friend = page.locator('#pfFriends .friend[data-addr]').first();
    await expect(friend).toBeVisible();
    const addr = (await friend.getAttribute('data-addr')) as string;
    await friend.click();
    await expect(page.locator('#profileView .addr')).toHaveText(addr);

    const followBtn = page.locator('#pfFollow');
    await expect(followBtn).toHaveText('FOLLOW');

    const followed = page.waitForResponse(
      (res) => res.url().includes(`/follow/SOL/${addr}`) && res.request().method() === 'POST',
    );
    await followBtn.click();
    expect((await followed).ok()).toBe(true);
    await expect(followBtn).toHaveText('FOLLOWING');
    await expect(page.locator('.toast', { hasText: 'FOLLOWING' })).toBeVisible();

    const unfollowed = page.waitForResponse(
      (res) => res.url().includes(`/follow/SOL/${addr}`) && res.request().method() === 'DELETE',
    );
    await followBtn.click();
    expect((await unfollowed).ok()).toBe(true);
    await expect(followBtn).toHaveText('FOLLOW');
    await expect(page.locator('.toast', { hasText: 'UNFOLLOWED' })).toBeVisible();
  });

  test('tipping on a wall attempts a real broadcast and reports the honest failure when it cannot land', async ({
    page,
  }) => {
    // Deterministic stand-in for "this RPC really has never heard of our
    // unfunded practice key" — a real mainnet RPC would refuse this same
    // transfer for the same underlying reason (no balance), just slower and
    // over a real network call this suite should not depend on.
    await page.route('https://api.mainnet-beta.solana.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'blockhash not found' } }),
      });
    });

    // A syntactically real Solana pubkey (the System Program's), not one of
    // `state/social.ts`'s `fakeAddr()` friends — those are display-only
    // `XXXX..YYYY` shorthand, not valid base58 pubkeys, and `app/tip.ts`'s
    // `new PublicKey(...)` would (correctly) refuse one before ever reaching
    // the RPC this test means to exercise.
    const target = '11111111111111111111111111111112';
    await page.goto(`/u/${target}`);
    await expect(page.locator('#profileView')).toBeVisible();
    await expect(page.locator('#shoutForm')).toBeVisible();

    await page.fill('#shout-txt', 'gm from the e2e suite');
    await page.click('#shoutForm button[type="submit"]');

    await expect(page.locator('.toast', { hasText: 'no real SOL' })).toBeVisible({ timeout: 10_000 });
    // The honest failure must not also claim success.
    await expect(page.locator('.toast', { hasText: 'TIPPED' })).toBeHidden();
  });

  test('sending a chat message posts over REST and echoes back over the live WS channel', async ({ page }) => {
    await page.click('#chatTab');
    await expect(page.locator('#drawer')).toHaveClass(/open/);

    const text = 'e2e says gm ' + Date.now();
    const sent = page.waitForResponse(
      (res) => res.url().includes('/chat/SOL/GLOBAL') && res.request().method() === 'POST',
    );
    await page.fill('#chatInput', text);
    await page.click('#chatForm .send');
    expect((await sent).ok()).toBe(true);

    // Round-tripped through the real server and the real WS `chat:` channel,
    // not appended locally — see `views/chat.ts`'s submit handler.
    await expect(page.locator('#chatLog .cm.mine', { hasText: text })).toBeVisible({ timeout: 10_000 });
  });
});
