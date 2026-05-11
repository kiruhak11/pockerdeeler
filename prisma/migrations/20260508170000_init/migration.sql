CREATE TABLE "rooms" (
  "id" UUID PRIMARY KEY,
  "code" VARCHAR(8) NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "dealer_id" UUID,
  "dealer_secret_hash" TEXT NOT NULL,
  "settings" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "room_participants" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "role" VARCHAR(32) NOT NULL,
  "name" TEXT NOT NULL,
  "session_token_hash" TEXT NOT NULL,
  "is_connected" BOOLEAN NOT NULL DEFAULT FALSE,
  "joined_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "players" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "participant_id" UUID UNIQUE REFERENCES "room_participants"("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "seat" INTEGER NOT NULL,
  "stack" INTEGER NOT NULL,
  "current_bet" INTEGER NOT NULL DEFAULT 0,
  "total_committed" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(32) NOT NULL,
  "is_connected" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("room_id", "seat")
);

CREATE TABLE "game_sessions" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "status" VARCHAR(32) NOT NULL,
  "hand_number" INTEGER NOT NULL DEFAULT 0,
  "pot" INTEGER NOT NULL DEFAULT 0,
  "current_bet" INTEGER NOT NULL DEFAULT 0,
  "current_player_id" UUID REFERENCES "players"("id"),
  "dealer_button_player_id" UUID REFERENCES "players"("id"),
  "small_blind_player_id" UUID REFERENCES "players"("id"),
  "big_blind_player_id" UUID REFERENCES "players"("id"),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "hands" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "session_id" UUID NOT NULL REFERENCES "game_sessions"("id") ON DELETE CASCADE,
  "hand_number" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "pot" INTEGER NOT NULL DEFAULT 0,
  "current_bet" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "finished_at" TIMESTAMPTZ
);

CREATE TABLE "player_actions" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "hand_id" UUID NOT NULL REFERENCES "hands"("id") ON DELETE CASCADE,
  "player_id" UUID NOT NULL REFERENCES "players"("id") ON DELETE CASCADE,
  "type" VARCHAR(32) NOT NULL,
  "amount" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(32) NOT NULL,
  "client_request_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "applied_at" TIMESTAMPTZ,
  UNIQUE ("room_id", "player_id", "client_request_id")
);

CREATE TABLE "hand_results" (
  "id" UUID PRIMARY KEY,
  "hand_id" UUID NOT NULL REFERENCES "hands"("id") ON DELETE CASCADE,
  "player_id" UUID NOT NULL REFERENCES "players"("id") ON DELETE CASCADE,
  "amount_won" INTEGER NOT NULL,
  "pot_type" VARCHAR(32) NOT NULL
);

CREATE TABLE "game_snapshots" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "hand_id" UUID REFERENCES "hands"("id") ON DELETE CASCADE,
  "snapshot_type" VARCHAR(64) NOT NULL,
  "data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "audit_logs" (
  "id" UUID PRIMARY KEY,
  "room_id" UUID NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
  "actor_participant_id" UUID REFERENCES "room_participants"("id"),
  "actor_role" VARCHAR(32) NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_rooms_code" ON "rooms"("code");
CREATE INDEX "idx_room_participants_room_id" ON "room_participants"("room_id");
CREATE INDEX "idx_players_room_id" ON "players"("room_id");
CREATE INDEX "idx_game_sessions_room_id" ON "game_sessions"("room_id");
CREATE INDEX "idx_hands_room_hand_number" ON "hands"("room_id", "hand_number");
CREATE INDEX "idx_player_actions_room_hand" ON "player_actions"("room_id", "hand_id");
CREATE INDEX "idx_player_actions_client_request_id" ON "player_actions"("client_request_id");
CREATE INDEX "idx_audit_logs_room_created_at" ON "audit_logs"("room_id", "created_at");
