-- The fee split is now 20% protocol / 10% Stonkz Game buyback (`stonkz_ops`,
-- historical name) / 10% buyback-and-burn / 60% creator bucket. Add the `burn`
-- treasury kind and seed a burn vault per net so ingest's UPDATE has a row to
-- credit (see 0014 for why a missing vault row silently drops fees).

ALTER TABLE "treasuries" DROP CONSTRAINT IF EXISTS "treasuries_kind_ck";
--> statement-breakpoint
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_kind_ck" CHECK ("kind" IN ('protocol', 'stonkz_ops', 'burn'));
--> statement-breakpoint
ALTER TABLE "treasury_credits" DROP CONSTRAINT IF EXISTS "treasury_credits_kind_ck";
--> statement-breakpoint
ALTER TABLE "treasury_credits" ADD CONSTRAINT "treasury_credits_kind_ck" CHECK ("kind" IN ('protocol', 'stonkz_ops', 'burn'));
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('SOL', 'burn')
ON CONFLICT ("net", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('RH', 'burn')
ON CONFLICT ("net", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('BASE', 'burn')
ON CONFLICT ("net", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('ARC', 'burn')
ON CONFLICT ("net", "kind") DO NOTHING;
