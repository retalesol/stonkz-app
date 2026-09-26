-- Seed treasury vaults for Coinbase Base. 0001 seeded SOL + RH and 0013 added
-- the BASE indexer cursor, but no vault rows: ingest credits treasuries with a
-- plain UPDATE, so every Base protocol / ops fee was silently dropped.

INSERT INTO "treasuries" ("net", "kind") VALUES ('BASE', 'protocol')
ON CONFLICT ("net", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('BASE', 'stonkz_ops')
ON CONFLICT ("net", "kind") DO NOTHING;
