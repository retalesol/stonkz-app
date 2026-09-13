import type { Page } from '@playwright/test';

/**
 * Playwright dismisses `window.confirm` / `alert` by default (returns false).
 * Settings default `confirm: true`, so every trade would toast ORDER CANCELLED
 * unless the harness accepts the dialog.
 */
export function acceptConfirmDialogs(page: Page): void {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
}
