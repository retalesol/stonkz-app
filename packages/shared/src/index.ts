/**
 * @stonkz/shared — the pure layer.
 *
 * Everything here is deterministic, DOM-free and side-effect free so the web
 * terminal, the API and the indexer all agree on the same numbers. Ported
 * from the `<script>` IIFE in `index.html`, which stays the behavioural oracle.
 */

export * from './types.js';
export * from './constants.js';
export * from './rng.js';
export * from './fmt.js';
export * from './curve.js';
export * from './fees.js';
export * from './stake.js';
export * from './ranks.js';
export * from './crates.js';
export * from './sp-levels.js';
export * from './referrals.js';
export * from './validate.js';
