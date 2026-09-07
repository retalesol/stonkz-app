import { expect, test, type Page } from '@playwright/test';

/**
 * The Phase 0.E sim journeys.
 *
 * These describe what a person can do, not what a function returns, so they
 * survive the Phase 1 swap from `api/sim.ts` to the live adapter: none of them
 * knows the simulation exists. `plan step 38`
 */

const connect = async (page: Page, net: 'SOL' | 'RH'): Promise<void> => {
  // `#connectBtn` toggles the picker, so only press it if it is not already up.
  if (await page.locator('#netMenu').isHidden()) await page.click('#connectBtn');
  await page.click(`[data-net="${net}"]`);
  await expect(page.locator('#wchip')).toBeVisible();
};

/** Open whichever coin the board seeded first. */
const openFirstCoin = async (page: Page): Promise<string> => {
  const card = page.locator('#lane-new .coin').first();
  const sym = (await card.getAttribute('data-sym')) as string;
  await card.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  return sym;
};

const trade = async (page: Page, side: 'BUY' | 'SELL', amount: string): Promise<void> => {
  await page.click(`#t-side [data-s="${side}"]`);
  await page.fill('#t-amt', amount);
  await page.click('#t-go');
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
});

test('landing runs the wizard and dismisses the hello card for good', async ({ page }) => {
  const hello = page.locator('#hello');
  await expect(hello).toBeVisible();

  await page.click('#helloWiz');
  await expect(page.locator('#wizScrim')).toHaveClass(/open/);
  await expect(page.locator('#wiz-count')).toHaveText('STEP 1 OF 3');
  await expect(hello).toBeHidden();

  await page.click('#wiz-next');
  await expect(page.locator('#wiz-count')).toHaveText('STEP 2 OF 3');
  await page.click('#wiz-next');
  await expect(page.locator('#wiz-count')).toHaveText('STEP 3 OF 3');
  await page.click('#wiz-next');
  await expect(page.locator('#wiz-count')).toHaveText('VERY NICE');
  await page.click('#wiz-done');
  await expect(page.locator('#wizScrim')).not.toHaveClass(/open/);

  // The dismissal is remembered, which is the whole point of the card.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  await expect(page.locator('#hello')).toBeHidden();
});

test('connecting either network wakes the launch CTA', async ({ page }) => {
  const cta = page.locator('#createBtn');
  await expect(cta).toHaveAttribute('aria-disabled', 'true');

  // Clicking it while disconnected offers the network picker instead. The
  // button stays clickable on purpose — `aria-disabled` announces that it will
  // not launch anything yet, and the click explains why. Playwright refuses to
  // click an aria-disabled control on its own, hence `force`.
  await cta.click({ force: true });
  await expect(page.locator('#netMenu')).toBeVisible();
  await expect(page.locator('#newScrim')).not.toHaveClass(/open/);

  await connect(page, 'SOL');
  await expect(cta).toHaveAttribute('aria-disabled', 'false');
  await expect(cta).toHaveClass(/on/);
  await expect(page.locator('#wNetName')).toHaveText('SOLANA');
  await expect(page.locator('#wBal')).toContainText('SOL');

  await page.click('#wchip');
  await page.click('[data-w="disconnect"]');
  await expect(cta).toHaveAttribute('aria-disabled', 'true');

  await connect(page, 'RH');
  await expect(page.locator('#wNetName')).toHaveText('ROBINHOOD');
  await expect(page.locator('#wBal')).toContainText('ETH');
  await expect(cta).toHaveAttribute('aria-disabled', 'false');
});

test('buying then selling pays XP and moves the position', async ({ page }) => {
  await connect(page, 'SOL');
  const sym = await openFirstCoin(page);

  const xpBefore = await page.locator('#rk-xp').textContent();
  await trade(page, 'BUY', '1.5');

  await expect(page.locator('#toasts')).toContainText('XP');
  await expect(page.locator('#t-pos')).toBeVisible();
  await expect(page.locator('#t-pos')).toContainText(sym);
  await expect(page.locator('#rk-xp')).not.toHaveText(xpBefore ?? '');

  // The fill lands on the recent-trades tab under this wallet, not anonymously.
  await expect(page.locator('#tabbody tbody tr').first()).toContainText('YOU..7xKQ');

  await trade(page, 'SELL', '0.5');
  await expect(page.locator('#toasts')).toContainText('REALIZED');
});

test('an opened crate stays on cooldown across a reload', async ({ page }) => {
  await connect(page, 'SOL');
  await page.click('#rankBtn');
  await expect(page.locator('#rewardsView')).toBeVisible();

  const bronze = page.locator('#crateGrid [data-k="BRONZE"]');
  await bronze.click();
  await expect(page.locator('#openBtn')).toBeEnabled();
  await page.click('#openBtn');

  // The drop lands in the log and the crate locks behind its cooldown.
  await expect(page.locator('#dropLog')).toContainText('BRONZE');
  await expect(bronze).toHaveClass(/locked/);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  await page.goto('/rewards');
  await expect(page.locator('#crateGrid [data-k="BRONZE"]')).toHaveClass(/locked/);
  await expect(page.locator('#crateGrid [data-cd="BRONZE"]')).not.toHaveText('READY');
});

/**
 * Escape peels one layer per press, innermost first: the six scrims, then the
 * two header menus, then the chat drawer, then the view stack. Each layer
 * blocks pointer input to the ones under it, so the walk down is one press at
 * a time from the deepest thing a person can actually have open.
 */
test('Escape unwinds one layer at a time, innermost first', async ({ page }) => {
  await connect(page, 'SOL');
  await openFirstCoin(page);

  // A scrim outranks everything under it.
  await page.click('#tk-stake');
  await expect(page.locator('#stakeScrim')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#stakeScrim')).not.toHaveClass(/open/);
  await expect(page.locator('#tokenView')).toBeVisible();

  // Then the drawer, which sits above the view but below any dialog.
  await page.click('#chatTab');
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await expect(page.locator('#tokenView')).toBeVisible();

  // Then the view stack, back to the board — and the URL follows.
  await page.keyboard.press('Escape');
  await expect(page.locator('#boardView')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('Escape closes a header menu before anything else', async ({ page }) => {
  await connect(page, 'SOL');

  await page.click('#wchip');
  await expect(page.locator('#wmenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wmenu')).toBeHidden();

  // The net picker is a menu too, and closing it leaves the board alone.
  await page.click('#wchip');
  await page.click('[data-w="disconnect"]');
  await page.click('#connectBtn');
  await expect(page.locator('#netMenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#netMenu')).toBeHidden();
  await expect(page.locator('#boardView')).toBeVisible();
});

test('every route is linkable, titled, and survives the back button', async ({ page }) => {
  await connect(page, 'SOL');
  const sym = await openFirstCoin(page);

  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
  await expect(page).toHaveTitle(new RegExp(`\\$${sym}`));

  await page.click('#rankBtn');
  await expect(page).toHaveURL(/\/rewards$/);
  await expect(page).toHaveTitle(/REWARDS/);

  // BACK returns to the chart it was opened from, not to the board.
  await page.click('#rw-back');
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
  await expect(page.locator('#tokenView')).toBeVisible();

  // A cold load of a token URL renders that token.
  await page.goto(`/t/${sym}`);
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page.locator('.tk-id h1')).toContainText(sym);
});

test('sort chips reorder the board without changing which coins are on it', async ({ page }) => {
  const symsIn = async (laneSel: string): Promise<string[]> =>
    page.locator(`${laneSel} .coin`).evaluateAll((els) => els.map((el) => el.getAttribute('data-sym')));

  const before = new Set(await symsIn('#lane-new'));
  await page.click('.filters .chip[data-sort="mc"]');
  await expect(page.locator('.filters .chip[data-sort="mc"]')).toHaveClass(/on/);
  // Same coins, just reordered — the chip is a sort, not a filter.
  expect(new Set(await symsIn('#lane-new'))).toEqual(before);

  const byMc = await symsIn('#lane-new');
  await page.click('.filters .chip[data-sort="chg"]');
  await expect(page.locator('.filters .chip[data-sort="chg"]')).toHaveClass(/on/);
  const byChg = await symsIn('#lane-new');
  // Different sort keys, same seed data: the order actually moved.
  expect(byChg).not.toEqual(byMc);

  await page.click('.filters .chip[data-sort="new"]');
  await expect(page.locator('.filters .chip[data-sort="new"]')).toHaveClass(/on/);
});

test('the tape opens a token on click', async ({ page }) => {
  // The strip is right-anchored and grows leftward as new prints arrive, so
  // only the newest (rightmost) one is reliably inside the clipped viewport —
  // `.first()` is the oldest print and scrolls out of view almost at once.
  const print = page.locator('#tape .tx').last();
  const sym = (await print.getAttribute('data-sym')) as string;
  // Hovering (part of Playwright's default click sequence) pins a frozen
  // clone on top of the print; `force: true` skips the actionability check
  // that would otherwise balk at the clone covering the target — clone and
  // original carry the same `data-sym` and both sit under the tape's one
  // delegated click listener, so either is a correct click.
  await print.click({ force: true });
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
});

test('the KOTH crown opens its coin on click', async ({ page }) => {
  const koth = page.locator('#koth');
  const sym = (await koth.getAttribute('data-sym')) as string;
  await koth.click();
  await expect(page.locator('#tokenView')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${sym}$`));
  await expect(page.locator('.tk-id h1')).toContainText(sym);
});

test('the six dialogs trap focus and hand it back to whatever opened them', async ({ page }) => {
  await connect(page, 'SOL');

  const opener = page.locator('#howBtn');
  await opener.click();
  const dialog = page.locator('#wizScrim .win');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  // Focus starts inside and Tab cannot leave.
  await expect(page.locator('#wizScrim')).toHaveClass(/open/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('#wizScrim'));
    expect(inside).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(page.locator('#wizScrim')).not.toHaveClass(/open/);
  await expect(opener).toBeFocused();
});
