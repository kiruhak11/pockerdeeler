CREATE TABLE "legal_checkout_sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "context" VARCHAR(32) NOT NULL,
  "payment_type" VARCHAR(32),
  "product_key" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_checkout_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_checkout_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "legal_checkout_sessions_user_id_created_at_idx" ON "legal_checkout_sessions"("user_id", "created_at");

ALTER TABLE "payments" ADD COLUMN "checkout_id" UUID;

CREATE UNIQUE INDEX "payments_checkout_id_key" ON "payments"("checkout_id");

ALTER TABLE "payments" ADD CONSTRAINT "payments_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "legal_checkout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "payments_one_open_product_idx";
