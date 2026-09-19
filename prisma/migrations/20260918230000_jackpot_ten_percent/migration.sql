ALTER TABLE "mini_game_economy"
  ADD COLUMN "jackpot_tenths" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "jackpot_draws"
  ADD COLUMN "pot_tenths" BIGINT NOT NULL DEFAULT 0;

-- Before this migration the accumulator represented 100% of the current pool.
-- Reinterpret that existing pool as tenths: 704815 becomes 70481.5.
UPDATE "mini_game_economy" e
SET "jackpot_tenths" = "jackpot",
"jackpot" = "jackpot" / 10;

UPDATE "jackpot_draws"
SET "pot_tenths" = "pot" * 10;
