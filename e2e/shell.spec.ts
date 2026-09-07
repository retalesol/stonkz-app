import { expect, test } from '@playwright/test';

/**
 * Harness smoke test only.
 *
 * Phase 0.E owns the real sim journeys (land -> wizard -> dismiss hello;
 * connect mock SOL and RH; open token -> buy -> sell -> XP toast; open crate
 * -> reload still cooling; the Escape stack). Do not grow this file into them.
 */

test('the shell boots with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  expect(errors).toEqual([]);
});

test('the shell renders the oracle element order', async ({ page }) => {
  await page.goto('/');

  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#app > *')).map((el) => el.id || el.className),
  );

  expect(order).toEqual([
    'fx',
    'top',
    'tape',
    'boardView',
    'tokenView',
    'rewardsView',
    'profileView',
    'foot',
    'chatTab',
    'chatScrim',
    'drawer',
    'newScrim',
    'setScrim',
    'wizScrim',
    'editScrim',
    'legalScrim',
    'stakeScrim',
    'claimScrim',
    // Phase B additions. The oracle had no wallet picker because it had no
    // wallets — connecting was a 460ms `setTimeout` in front of a
    // `localStorage` keypair. `practiceBadge` sits last of the overlays, just
    // above the toasts, so the strip announcing that nothing settles cannot
    // be covered by anything but a toast.
    'walletScrim',
    'txScrim',
    'practiceBadge',
    'toasts',
    'rankup',
  ]);
});

test('the CSS custom properties match :root in index.html', async ({ page }) => {
  await page.goto('/');

  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const keys = [
      'bg',
      'pnl',
      'pnl2',
      'hd',
      'line',
      'line2',
      'txt',
      'txt2',
      'dim',
      'amber',
      'amber2',
      'gold',
      'blue',
      'up',
      'down',
      'violet',
      'input',
    ];
    return Object.fromEntries(keys.map((k) => [k, s.getPropertyValue(`--${k}`).trim()]));
  });

  expect(tokens).toEqual({
    bg: '#000000',
    pnl: '#08090c',
    pnl2: '#0d1016',
    hd: '#121826',
    line: '#1e2431',
    line2: '#2c3444',
    txt: '#cac6ba',
    txt2: '#948e80',
    dim: '#6b675c',
    amber: '#ffa22b',
    amber2: '#c87c14',
    gold: '#ffd23f',
    blue: '#4d9bff',
    up: '#00d26a',
    down: '#ff4c3b',
    violet: '#a273ff',
    input: '#df8f1e',
  });
});
