CREATE TABLE "payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "order_id" VARCHAR(64) NOT NULL DEFAULT gen_random_uuid()::text,
  "yookassa_payment_id" VARCHAR(128),
  "idempotency_key" UUID NOT NULL,
  "provider" VARCHAR(24) NOT NULL DEFAULT 'YOOKASSA',
  "type" VARCHAR(32) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'RUB',
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "provider_status" VARCHAR(32),
  "description" VARCHAR(128) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "provider_data" JSONB NOT NULL DEFAULT '{}',
  "confirmation_url" TEXT,
  "return_url" TEXT NOT NULL,
  "provider_created_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "paid_at" TIMESTAMPTZ(6),
  "processed_at" TIMESTAMPTZ(6),
  "canceled_at" TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "payments_provider_check" CHECK ("provider" = 'YOOKASSA'),
  CONSTRAINT "payments_type_check" CHECK ("type" IN ('PREMIUM','VIRTUAL_CURRENCY')),
  CONSTRAINT "payments_status_check" CHECK ("status" IN ('PENDING','SUCCEEDED','CANCELED','PROCESSED')),
  CONSTRAINT "payments_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "payments_currency_check" CHECK ("currency" = upper("currency") AND char_length("currency") = 3),
  CONSTRAINT "payments_processed_check" CHECK ("status" <> 'PROCESSED' OR "processed_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");
CREATE UNIQUE INDEX "payments_yookassa_payment_id_key" ON "payments"("yookassa_payment_id");
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at");
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");
CREATE INDEX "payments_type_status_created_at_idx" ON "payments"("type", "status", "created_at");
