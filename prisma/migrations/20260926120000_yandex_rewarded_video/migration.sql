CREATE TABLE "yandex_rewarded_ad_attempts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'STARTED',
  "granted_amount" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "rewarded_at" TIMESTAMPTZ(6),
  CONSTRAINT "yandex_rewarded_ad_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "yandex_rewarded_ad_attempts_status_check" CHECK ("status" IN ('STARTED', 'REWARDED', 'CANCELLED', 'EXPIRED'))
);

CREATE TABLE "yandex_rewarded_progress" (
  "user_id" UUID NOT NULL,
  "views_since_grant" INTEGER NOT NULL DEFAULT 0,
  "completed_grants" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "yandex_rewarded_progress_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "yandex_rewarded_progress_views_check" CHECK ("views_since_grant" BETWEEN 0 AND 2),
  CONSTRAINT "yandex_rewarded_progress_grants_check" CHECK ("completed_grants" >= 0)
);

CREATE UNIQUE INDEX "yandex_rewarded_ad_attempts_user_id_request_id_key"
ON "yandex_rewarded_ad_attempts"("user_id", "request_id");
CREATE INDEX "yandex_rewarded_ad_attempts_user_id_status_expires_at_idx"
ON "yandex_rewarded_ad_attempts"("user_id", "status", "expires_at");

ALTER TABLE "yandex_rewarded_ad_attempts"
ADD CONSTRAINT "yandex_rewarded_ad_attempts_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "yandex_rewarded_progress"
ADD CONSTRAINT "yandex_rewarded_progress_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
