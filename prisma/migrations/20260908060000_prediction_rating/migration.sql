ALTER TABLE "users"
  ADD COLUMN "prediction_rating" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "premium_type" VARCHAR(16) NOT NULL DEFAULT 'FREE',
  ADD COLUMN "premium_until" TIMESTAMPTZ(6);

ALTER TABLE "prediction_bets"
  ADD COLUMN "risk_percent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rating_delta" INTEGER,
  ADD COLUMN "rating_applied_at" TIMESTAMPTZ(6);

CREATE TABLE "prediction_rating_events" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "bet_id" UUID NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prediction_rating_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prediction_rating_events_bet_id_key" UNIQUE ("bet_id"),
  CONSTRAINT "prediction_rating_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_rating_events_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "prediction_bets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "prediction_rating_events_user_id_created_at_idx" ON "prediction_rating_events"("user_id", "created_at");
