ALTER TABLE "users"
  ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bot_key" VARCHAR(64),
  ADD COLUMN "bot_skill_tier" VARCHAR(16),
  ADD COLUMN "bot_play_style" VARCHAR(32),
  ADD COLUMN "bot_enabled" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "users_bot_key_key" ON "users"("bot_key");
CREATE INDEX "users_is_bot_bot_enabled_idx" ON "users"("is_bot", "bot_enabled");
