CREATE TABLE "mini_game_economy" (
  "id" VARCHAR(16) NOT NULL,
  "day_key" VARCHAR(10) NOT NULL,
  "mines_bank" BIGINT NOT NULL,
  "rocket_bank" BIGINT NOT NULL,
  "jackpot" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mini_game_economy_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "mini_game_jackpot_entries" (
  "id" UUID NOT NULL,
  "economy_id" VARCHAR(16) NOT NULL,
  "user_id" UUID NOT NULL,
  "game" VARCHAR(16) NOT NULL,
  "amount" BIGINT NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "reference_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mini_game_jackpot_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mini_game_jackpot_entries_economy_id_created_at_idx" ON "mini_game_jackpot_entries"("economy_id","created_at");
CREATE INDEX "mini_game_jackpot_entries_user_id_created_at_idx" ON "mini_game_jackpot_entries"("user_id","created_at");
ALTER TABLE "mini_game_jackpot_entries" ADD CONSTRAINT "mini_game_jackpot_entries_economy_id_fkey" FOREIGN KEY ("economy_id") REFERENCES "mini_game_economy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mini_game_jackpot_entries" ADD CONSTRAINT "mini_game_jackpot_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "mini_game_economy" ("id","day_key","mines_bank","rocket_bank","jackpot") VALUES ('global', to_char(CURRENT_DATE, 'YYYY-MM-DD'), 2000000, 5000000, 0);
DO $$
BEGIN
  IF to_regclass('public.mini_game_sessions') IS NOT NULL THEN
    INSERT INTO "mini_game_jackpot_entries" ("id","economy_id","user_id","game","amount","source","reference_id")
    SELECT gen_random_uuid(), 'global', "user_id", 'mines', "stake", 'HISTORICAL_LOSS', "id" FROM "mini_game_sessions" WHERE "status"='LOST';
  END IF;
END $$;
INSERT INTO "mini_game_jackpot_entries" ("id","economy_id","user_id","game","amount","source","reference_id")
SELECT gen_random_uuid(), 'global', "user_id", 'rocket', "stake", 'HISTORICAL_LOSS', "id" FROM "crash_bets" WHERE "payout"=0 AND "cashed_at_hundredths" IS NOT NULL;
UPDATE "mini_game_economy" SET "jackpot"=(SELECT COALESCE(SUM("amount"),0) FROM "mini_game_jackpot_entries") WHERE "id"='global';
