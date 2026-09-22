ALTER TABLE "online_rooms"
  ADD COLUMN "starting_stack" BIGINT NOT NULL DEFAULT 1000;

CREATE TABLE "online_room_players" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "seat" INTEGER NOT NULL,
  "buy_in" BIGINT NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'RESERVING',
  "cash_out_pending" BIGINT,
  "buy_in_sequence" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "cashed_out_at" TIMESTAMPTZ(6),
  CONSTRAINT "online_room_players_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "online_rooms"("id") ON DELETE CASCADE,
  CONSTRAINT "online_room_players_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "online_room_players_room_id_user_id_key"
  ON "online_room_players" ("room_id", "user_id");
CREATE INDEX "online_room_players_user_id_status_idx"
  ON "online_room_players" ("user_id", "status");
CREATE INDEX "online_room_players_room_id_status_idx"
  ON "online_room_players" ("room_id", "status");
