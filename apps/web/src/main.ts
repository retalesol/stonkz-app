import './styles/index.css';

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
