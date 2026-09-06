import { FEE_SPLIT, GRAD } from '@stonkz/shared';

/**
 * PLACEHOLDER. Phase 1.A owns this service.
 *
 * What lands here: Hono (or Fastify) + TypeScript, short-lived JWT access
 * tokens plus refresh, CORS locked to ston.kz and localhost, `net` in the JWT
 * claims, SIWS and SIWE auth, Neon Postgres via Drizzle, Redis for rate limits
 * and the 8-second quote cache, and `GET /health` reporting api / db / redis /
 * Solana RPC lag / RH RPC lag.
 *
 * Nothing is wired yet. The export below exists so the package typechecks and
 * so the shared package is already on the dependency graph.
 */
export const API_PLACEHOLDER = {
  name: '@stonkz/api',
  phase: '1.A',
  graduationMcapUsd: GRAD,
  curveFeeSplit: FEE_SPLIT,
} as const;
