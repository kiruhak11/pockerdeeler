ALTER TABLE "payments" ADD COLUMN "product_key" VARCHAR(32);

UPDATE "payments"
SET "product_key" = COALESCE("metadata"->>'productKey', 'legacy')
WHERE "product_key" IS NULL;

ALTER TABLE "payments" ALTER COLUMN "product_key" SET NOT NULL;

CREATE INDEX "payments_user_id_type_product_key_idx"
ON "payments"("user_id", "type", "product_key");

CREATE UNIQUE INDEX "payments_one_open_product_idx"
ON "payments"("user_id", "type", "product_key")
WHERE "status" = 'PENDING';
