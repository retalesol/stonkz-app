-- Review gate 3.A — second half of the index advisor pass.
--
-- 0003 added an index per hot query on reasoning alone. Reading the actual
-- plans back (`db/index-advisor.test.ts`) showed the planner refuses two of
-- them, so they were pure write amplification on `tape`, which is the most
-- append-heavy table in the schema. Forward-only rather than an edit to 0003,
-- because the runner tracks applied migrations by tag and would not re-run it.

-- Redundant with "tape_pkey": `ORDER BY id DESC` is a backward scan of the
-- primary key's btree, which Postgres does natively and costs nothing extra.
DROP INDEX IF EXISTS "tape_recent_idx";
--> statement-breakpoint
-- `net` has exactly two values for the life of this product, so
-- `WHERE net = $1 ORDER BY id DESC LIMIT 40` reads at most ~80 primary-key
-- entries before it fills the page. The planner prices that below a second
-- index and picks tape_pkey every time, at every table size.
DROP INDEX IF EXISTS "tape_net_recent_idx";
--> statement-breakpoint
ANALYZE "tape";
