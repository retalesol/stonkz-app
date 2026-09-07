import { defineConfig, loadEnv } from 'vite';

/**
 * The practice-wallet build gate.
 *
 * `wallet/practice.ts` signs with a browser-local keypair and settles
 * nothing. It is genuinely useful in development and a lie in production, so
 * a production build carrying it has to be a deliberate act: setting
 * `VITE_PRACTICE_WALLET=1` without `VITE_PRACTICE_WALLET_ACK=1` fails the
 * build instead of quietly shipping a fake signer as "live".
 */
function assertPracticeWalletGate(mode: string, env: Record<string, string>): void {
  if (mode !== 'production') return;
  if (env['VITE_PRACTICE_WALLET'] !== '1') return;
  if (env['VITE_PRACTICE_WALLET_ACK'] === '1') {
    // A production build with a fake signer must say so loudly.
    console.warn(
      '\n  !! Building with VITE_PRACTICE_WALLET=1. This bundle signs with a browser-local\n' +
        '     practice key and settles nothing on chain. Do not deploy it as live.\n',
    );
    return;
  }
  throw new Error(
    'VITE_PRACTICE_WALLET=1 in a production build. The practice keypair settles nothing and must never ' +
      'ship as live. Set VITE_PRACTICE_WALLET_ACK=1 as well if this is a deliberate test build.',
  );
}

export default defineConfig(({ mode }) => {
  assertPracticeWalletGate(mode, loadEnv(mode, process.cwd(), 'VITE_'));
  return {
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
    },
    preview: {
      // Bind the v4 loopback explicitly: on macOS `localhost` can resolve to ::1
      // only, which the Playwright harness cannot reach.
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: true,
      // The terminal is one document; keep the CSS in one file so the CSP
      // style-src stays a single hash-able entry later.
      cssCodeSplit: false,
    },
  };
});
