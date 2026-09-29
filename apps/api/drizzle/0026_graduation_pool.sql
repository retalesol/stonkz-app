-- Where a graduated token's liquidity went. `LiquidityMigrated` carries the
-- pool (and, on Solana, the locked DLMM position); until now the indexer
-- dropped it on EVM and never persisted it on either chain, so the token page
-- could not deep-link the DEX pool. Nullable: `Graduated` and
-- `LiquidityMigrated` are separate transactions on EVM.
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "pool_address" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "position_address" text;
