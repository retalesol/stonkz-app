import { defineConfig } from 'vite';

export default defineConfig({
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
});
