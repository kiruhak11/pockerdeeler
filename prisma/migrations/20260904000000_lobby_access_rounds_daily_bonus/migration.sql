ALTER TABLE "rooms" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "last_daily_bonus_at" TIMESTAMPTZ(6);
ALTER TABLE "hands" ADD COLUMN "betting_state" JSONB;
ALTER TABLE "players" ADD COLUMN "balance_settled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "players" SET "balance_settled" = true WHERE "participant_id" IS NULL AND "status" <> 'all-in';
