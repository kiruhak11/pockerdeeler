CREATE TABLE "seasons" (
  "id" UUID NOT NULL, "number" INTEGER NOT NULL, "status" VARCHAR(16) NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL, "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "finalized_at" TIMESTAMPTZ(6), "starting_balance" BIGINT NOT NULL DEFAULT 50000,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seasons_number_key" ON "seasons"("number");
CREATE INDEX "seasons_status_starts_at_ends_at_idx" ON "seasons"("status", "starts_at", "ends_at");
CREATE TABLE "seasonal_user_stats" (
  "id" UUID NOT NULL, "season_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "balance" BIGINT NOT NULL DEFAULT 50000, "starting_balance" BIGINT NOT NULL DEFAULT 50000,
  "table_rating" INTEGER NOT NULL DEFAULT 1000, "prediction_rating" INTEGER NOT NULL DEFAULT 1000,
  "hands_played" INTEGER NOT NULL DEFAULT 0, "hands_won" INTEGER NOT NULL DEFAULT 0,
  "prediction_count" INTEGER NOT NULL DEFAULT 0, "prediction_wins" INTEGER NOT NULL DEFAULT 0,
  "prediction_split_wins" INTEGER NOT NULL DEFAULT 0, "total_prediction_profit" BIGINT NOT NULL DEFAULT 0,
  "total_won" BIGINT NOT NULL DEFAULT 0, "total_lost" BIGINT NOT NULL DEFAULT 0,
  "best_win_streak" INTEGER NOT NULL DEFAULT 0, "current_win_streak" INTEGER NOT NULL DEFAULT 0,
  "active_days" INTEGER NOT NULL DEFAULT 0, "rooms_joined" INTEGER NOT NULL DEFAULT 0,
  "excluded" BOOLEAN NOT NULL DEFAULT false, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seasonal_user_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "seasonal_user_stats_season_id_user_id_key" ON "seasonal_user_stats"("season_id", "user_id");
CREATE INDEX "seasonal_user_stats_season_id_balance_idx" ON "seasonal_user_stats"("season_id", "balance");
CREATE TABLE "season_leaderboards" (
  "id" UUID NOT NULL, "season_id" UUID NOT NULL, "user_id" UUID NOT NULL, "category" VARCHAR(32) NOT NULL,
  "place" INTEGER NOT NULL, "value" DECIMAL(20,4) NOT NULL, "tie_key" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "season_leaderboards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "season_leaderboards_season_id_category_user_id_key" ON "season_leaderboards"("season_id", "category", "user_id");
CREATE INDEX "season_leaderboards_season_id_category_place_idx" ON "season_leaderboards"("season_id", "category", "place");
CREATE TABLE "season_rewards" (
  "id" UUID NOT NULL, "season_id" UUID NOT NULL, "user_id" UUID NOT NULL, "reward_type" VARCHAR(32) NOT NULL,
  "title" VARCHAR(128) NOT NULL, "description" TEXT NOT NULL, "icon" VARCHAR(16) NOT NULL, "place" INTEGER,
  "category" VARCHAR(32) NOT NULL, "rarity" VARCHAR(16) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "season_rewards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "season_rewards_season_id_user_id_reward_type_category_key" ON "season_rewards"("season_id", "user_id", "reward_type", "category");
CREATE INDEX "season_rewards_season_id_user_id_idx" ON "season_rewards"("season_id", "user_id");
CREATE TABLE "season_snapshots" (
  "id" UUID NOT NULL, "season_id" UUID NOT NULL, "user_id" UUID NOT NULL, "data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "season_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "season_snapshots_season_id_user_id_key" ON "season_snapshots"("season_id", "user_id");
CREATE INDEX "season_snapshots_user_id_created_at_idx" ON "season_snapshots"("user_id", "created_at");
ALTER TABLE "seasonal_user_stats" ADD CONSTRAINT "seasonal_user_stats_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seasonal_user_stats" ADD CONSTRAINT "seasonal_user_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "season_leaderboards" ADD CONSTRAINT "season_leaderboards_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "season_leaderboards" ADD CONSTRAINT "season_leaderboards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "season_rewards" ADD CONSTRAINT "season_rewards_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "season_rewards" ADD CONSTRAINT "season_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "season_snapshots" ADD CONSTRAINT "season_snapshots_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "season_snapshots" ADD CONSTRAINT "season_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
