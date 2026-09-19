CREATE TABLE "premium_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "plan" VARCHAR(16) NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "premium_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "premium_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "premium_subscriptions_plan_check" CHECK ("plan" IN ('LITE','PRO','ELITE')),
  CONSTRAINT "premium_subscriptions_status_check" CHECK ("status" IN ('ACTIVE','EXPIRED','CANCELLED')),
  CONSTRAINT "premium_subscriptions_period_check" CHECK ("expires_at" > "started_at")
);
CREATE INDEX "premium_subscriptions_user_id_status_expires_at_idx" ON "premium_subscriptions"("user_id","status","expires_at");
CREATE UNIQUE INDEX "premium_subscriptions_one_active_user_idx" ON "premium_subscriptions"("user_id") WHERE "status"='ACTIVE';

CREATE TABLE "premium_user_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "premium_user_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "premium_user_settings_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "premium_user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Preserve the only legacy Premium capability as Lite. No game or rating data changes.
INSERT INTO "premium_subscriptions" ("user_id","plan","started_at","expires_at","status")
SELECT "id", 'LITE', "created_at",
  CASE
    WHEN "premium_until" IS NULL THEN CURRENT_TIMESTAMP + INTERVAL '100 years'
    WHEN "premium_until" <= "created_at" THEN "created_at" + INTERVAL '1 second'
    ELSE "premium_until"
  END,
  CASE WHEN "premium_until" IS NOT NULL AND "premium_until" <= CURRENT_TIMESTAMP THEN 'EXPIRED' ELSE 'ACTIVE' END
FROM "users" WHERE "premium_type"='PREMIUM';
