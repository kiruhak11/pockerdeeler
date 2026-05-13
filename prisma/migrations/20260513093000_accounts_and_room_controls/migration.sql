CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "username" VARCHAR(64) NOT NULL,
  "password_hash" TEXT NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 5000,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "room_participants" ADD COLUMN "user_id" UUID;
ALTER TABLE "players" ADD COLUMN "user_id" UUID;

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "users_username_idx" ON "users"("username");
CREATE INDEX "room_participants_user_id_idx" ON "room_participants"("user_id");
CREATE INDEX "players_user_id_idx" ON "players"("user_id");

ALTER TABLE "room_participants"
  ADD CONSTRAINT "room_participants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "players"
  ADD CONSTRAINT "players_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
