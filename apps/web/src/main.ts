import './styles/index.css';
// Imported here, not from index.css: that file is the oracle's cascade, locked
// byte-for-byte by `css:check`. Touch affordances are additive. `plan step 37`
import './styles/touch.css';
// Phase 5 additions with no oracle equivalent (footer legal disclosure link).
import './styles/phase5.css';
// Phase B: the real wallet picker and the practice-mode badge.
import './styles/wallet-connect.css';

import { boot } from './app/shell.js';

/**
 * Entry point. Everything is in `app/shell.ts`; this file only picks the
 * moment to start it.
 */
function start(): void {
  void boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
