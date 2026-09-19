CREATE TABLE "crash_rounds" (
  "id" UUID NOT NULL,
  "phase" VARCHAR(16) NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "crash_at_hundredths" INTEGER NOT NULL,
  "seed_hash" CHAR(64) NOT NULL,
  "seed" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crash_rounds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crash_rounds_phase_check" CHECK ("phase" IN ('betting', 'flying', 'crashed')),
  CONSTRAINT "crash_rounds_crash_at_check" CHECK ("crash_at_hundredths" >= 101)
);
CREATE INDEX "crash_rounds_phase_started_at_idx" ON "crash_rounds"("phase", "started_at");

CREATE TABLE "crash_bets" (
  "id" UUID NOT NULL,
  "round_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "stake" INTEGER NOT NULL,
  "cashed_at_hundredths" INTEGER,
  "payout" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crash_bets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crash_bets_stake_check" CHECK ("stake" BETWEEN 1 AND 1000000),
  CONSTRAINT "crash_bets_payout_check" CHECK ("payout" >= 0),
  CONSTRAINT "crash_bets_round_id_user_id_key" UNIQUE ("round_id", "user_id"),
  CONSTRAINT "crash_bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "crash_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "crash_bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "crash_bets_user_id_created_at_idx" ON "crash_bets"("user_id", "created_at");
