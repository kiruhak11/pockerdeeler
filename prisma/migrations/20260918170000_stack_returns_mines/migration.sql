CREATE TABLE "stack_returns" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "transfer_id" UUID NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stack_returns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stack_returns_transfer_id_key" ON "stack_returns"("transfer_id");
CREATE UNIQUE INDEX "stack_returns_room_id_member_id_client_request_id_key" ON "stack_returns"("room_id", "member_id", "client_request_id");
CREATE INDEX "stack_returns_user_id_created_at_idx" ON "stack_returns"("user_id", "created_at");
ALTER TABLE "stack_returns" ADD CONSTRAINT "stack_returns_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stack_returns" ADD CONSTRAINT "stack_returns_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stack_returns" ADD CONSTRAINT "stack_returns_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stack_returns" ADD CONSTRAINT "stack_returns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mini_game_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "stake" BIGINT NOT NULL,
    "mines" INTEGER,
    "server_seed_hash" CHAR(64),
    "server_seed" CHAR(64),
    "client_seed" VARCHAR(128),
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "opened_cells" JSONB NOT NULL DEFAULT '[]',
    "mine_cells" JSONB,
    "multiplier" DECIMAL(12,4) NOT NULL DEFAULT 1,
    "payout" BIGINT NOT NULL DEFAULT 0,
    "bank_user_id" UUID NOT NULL,
    "bank_reserve" BIGINT NOT NULL,
    "max_payout" BIGINT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "mini_game_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mini_game_sessions_idempotency_key_key" ON "mini_game_sessions"("idempotency_key");
CREATE INDEX "mini_game_sessions_user_id_status_created_at_idx" ON "mini_game_sessions"("user_id", "status", "created_at");
ALTER TABLE "mini_game_sessions" ADD CONSTRAINT "mini_game_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "mini_games_one_active" ON "mini_game_sessions"("user_id", "game") WHERE "status"='ACTIVE';
ALTER TABLE "mini_game_sessions" ADD CONSTRAINT "mines_valid_stake" CHECK ("stake">0 AND "bank_reserve">=0 AND "max_payout">="stake" AND "payout">=0 AND "payout"<="max_payout");
ALTER TABLE "mini_game_sessions" ADD CONSTRAINT "mines_bank_user_fkey" FOREIGN KEY ("bank_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

CREATE TABLE "mines_commitments" (
 "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "server_seed" CHAR(64) NOT NULL, "seed_hash" CHAR(64) NOT NULL,
 "expires_at" TIMESTAMPTZ(6) NOT NULL, "consumed_at" TIMESTAMPTZ(6),
 "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "mines_commitments_user_id_expires_at_idx" ON "mines_commitments"("user_id","expires_at");
CREATE TABLE "token_prediction_rounds" (
 "id" UUID PRIMARY KEY, "room_id" UUID NOT NULL, "hand_id" UUID NOT NULL UNIQUE,
 "hand_number" INTEGER NOT NULL, "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
 "candidates" JSONB NOT NULL, "reward_fund" BIGINT NOT NULL DEFAULT 0,
 "deductions" JSONB NOT NULL DEFAULT '{}', "locked_at" TIMESTAMPTZ(6), "settled_at" TIMESTAMPTZ(6),
 "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "token_prediction_rounds_room_id_created_at_idx" ON "token_prediction_rounds"("room_id","created_at");
CREATE TABLE "token_predictions" (
 "id" UUID PRIMARY KEY, "round_id" UUID NOT NULL REFERENCES "token_prediction_rounds"("id") ON DELETE CASCADE,
 "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT, "candidate_id" UUID NOT NULL,
 "tokens" INTEGER NOT NULL CHECK ("tokens" BETWEEN 1 AND 3), "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
 "payout" BIGINT NOT NULL DEFAULT 0 CHECK ("payout">=0), "rating_delta" INTEGER NOT NULL DEFAULT 0,
 "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "token_predictions_round_id_user_id_candidate_id_key" ON "token_predictions"("round_id","user_id","candidate_id");
CREATE INDEX "token_predictions_user_id_status_idx" ON "token_predictions"("user_id","status");
CREATE TABLE "token_prediction_commands" (
 "id" UUID PRIMARY KEY, "round_id" UUID NOT NULL REFERENCES "token_prediction_rounds"("id") ON DELETE CASCADE,
 "user_id" UUID NOT NULL, "request_id" VARCHAR(128) NOT NULL, "input_hash" CHAR(64) NOT NULL,
 "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "token_prediction_commands_round_id_user_id_request_id_key" ON "token_prediction_commands"("round_id","user_id","request_id");
ALTER TABLE "stack_returns" ADD CONSTRAINT "stack_returns_positive" CHECK ("amount">0);
