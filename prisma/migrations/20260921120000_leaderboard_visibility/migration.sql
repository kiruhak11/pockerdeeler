ALTER TABLE "users" ADD COLUMN "leaderboard_visible" BOOLEAN;

UPDATE "users"
SET "leaderboard_visible" = true
WHERE "leaderboard_visible" IS NULL;

ALTER TABLE "users"
  ALTER COLUMN "leaderboard_visible" SET DEFAULT true,
  ALTER COLUMN "leaderboard_visible" SET NOT NULL;
