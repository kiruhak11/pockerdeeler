ALTER TABLE "users"
  ADD COLUMN "table_hands_played" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "table_hands_won" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "table_current_streak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "table_best_streak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "prediction_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "prediction_wins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "prediction_split_wins" INTEGER NOT NULL DEFAULT 0;

UPDATE "users" u SET
  "table_hands_played" = COALESCE((SELECT COUNT(*) FROM "table_rating_events" e WHERE e."user_id" = u."id"), 0),
  "table_hands_won" = COALESCE((SELECT COUNT(*) FROM "table_rating_events" e WHERE e."user_id" = u."id" AND e."delta" > 0), 0),
  "prediction_count" = COALESCE((SELECT COUNT(*) FROM "prediction_rating_events" e WHERE e."user_id" = u."id"), 0),
  "prediction_wins" = COALESCE((SELECT COUNT(*) FROM "prediction_rating_events" e WHERE e."user_id" = u."id" AND e."delta" > 0), 0);

ALTER TABLE "prediction_rating_events" DROP CONSTRAINT "prediction_rating_events_bet_id_fkey";
ALTER TABLE "prediction_rating_events" ALTER COLUMN "bet_id" DROP NOT NULL;
ALTER TABLE "prediction_rating_events" ADD CONSTRAINT "prediction_rating_events_bet_id_fkey"
  FOREIGN KEY ("bet_id") REFERENCES "prediction_bets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "table_rating_events" DROP CONSTRAINT "table_rating_events_hand_id_fkey";
ALTER TABLE "table_rating_events" ALTER COLUMN "hand_id" DROP NOT NULL;
ALTER TABLE "table_rating_events" ADD CONSTRAINT "table_rating_events_hand_id_fkey"
  FOREIGN KEY ("hand_id") REFERENCES "hands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
