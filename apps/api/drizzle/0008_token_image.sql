-- Token launch image (IPFS gateway URL from Pinata).
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "image_url" text;
