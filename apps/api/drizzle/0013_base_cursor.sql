-- Seed indexer cursor for Coinbase Base (0012 only widened CHECKs).

INSERT INTO "indexer_cursors" ("net") VALUES ('BASE')
ON CONFLICT ("net") DO NOTHING;
