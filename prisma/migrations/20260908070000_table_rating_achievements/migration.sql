ALTER TABLE "users" ADD COLUMN "table_rating" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "users" ADD COLUMN "selected_achievement_code" VARCHAR(64);

CREATE TABLE "table_rating_events" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "hand_id" UUID NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "table_rating_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "table_rating_events_user_id_hand_id_key" ON "table_rating_events"("user_id", "hand_id");
CREATE INDEX "table_rating_events_user_id_created_at_idx" ON "table_rating_events"("user_id", "created_at");
ALTER TABLE "table_rating_events" ADD CONSTRAINT "table_rating_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "table_rating_events" ADD CONSTRAINT "table_rating_events_hand_id_fkey" FOREIGN KEY ("hand_id") REFERENCES "hands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "achievements" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "title" VARCHAR(128) NOT NULL,
  "description" TEXT NOT NULL,
  "icon" VARCHAR(16) NOT NULL,
  "rarity" VARCHAR(16) NOT NULL,
  "rating_reward" INTEGER NOT NULL DEFAULT 0,
  "money_reward" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "achievements_code_key" ON "achievements"("code");

CREATE TABLE "user_achievements" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "achievement_id" UUID NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 100,
  "unlocked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_achievements_user_id_achievement_id_key" ON "user_achievements"("user_id", "achievement_id");
CREATE INDEX "user_achievements_user_id_unlocked_at_idx" ON "user_achievements"("user_id", "unlocked_at");
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
