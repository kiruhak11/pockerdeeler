CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "room_participants" ADD COLUMN "member_id" UUID;
ALTER TABLE "players" ADD COLUMN "member_id" UUID;
ALTER TABLE "game_sessions" ADD COLUMN "current_turn_started_at" TIMESTAMPTZ(6);
ALTER TABLE "hands" ADD COLUMN "main_pot_winner_id" UUID;
ALTER TABLE "hands" ADD COLUMN "main_pot_split" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "player_actions" ADD COLUMN "street" VARCHAR(16);
ALTER TABLE "player_actions" ADD COLUMN "turn_started_at" TIMESTAMPTZ(6);
ALTER TABLE "player_actions" ADD COLUMN "requested_at" TIMESTAMPTZ(6);
ALTER TABLE "player_actions" ADD COLUMN "decision_time_ms" INTEGER;
ALTER TABLE "player_actions" ADD COLUMN "connection_interruption_ms" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "user_wallets" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "balance" BIGINT NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_wallets_balance_check" CHECK ("balance" >= 0),
  CONSTRAINT "user_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "room_members" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "approved_by_participant_id" UUID,
  "initial_buy_in" BIGINT,
  "requested_buy_in" BIGINT,
  "prediction_grant" BIGINT NOT NULL DEFAULT 0,
  "prediction_grant_issued_at" TIMESTAMPTZ(6),
  "eliminated_at" TIMESTAMPTZ(6),
  "reentry_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_members_initial_buy_in_check" CHECK ("initial_buy_in" IS NULL OR "initial_buy_in" > 0),
  CONSTRAINT "room_members_requested_buy_in_check" CHECK ("requested_buy_in" IS NULL OR "requested_buy_in" > 0),
  CONSTRAINT "room_members_prediction_grant_check" CHECK ("prediction_grant" >= 0),
  CONSTRAINT "room_members_reentry_count_check" CHECK ("reentry_count" >= 0),
  CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_members_approved_by_fkey" FOREIGN KEY ("approved_by_participant_id") REFERENCES "room_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "room_member_accounts" (
  "id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "bound_by_participant_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(6),
  CONSTRAINT "room_member_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_member_accounts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_member_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_member_accounts_bound_by_fkey" FOREIGN KEY ("bound_by_participant_id") REFERENCES "room_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "wallet_ledger_entries" (
  "id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "room_id" UUID,
  "member_id" UUID,
  "transfer_id" UUID NOT NULL,
  "entry_type" VARCHAR(64) NOT NULL,
  "amount" BIGINT NOT NULL,
  "balance_after" BIGINT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_ledger_entries_amount_check" CHECK ("amount" <> 0),
  CONSTRAINT "wallet_ledger_entries_balance_after_check" CHECK ("balance_after" >= 0),
  CONSTRAINT "wallet_ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "user_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wallet_ledger_entries_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "wallet_ledger_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "buy_ins" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "player_id" UUID NOT NULL,
  "amount" BIGINT NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "transfer_id" UUID NOT NULL,
  "client_request_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "buy_ins_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "buy_ins_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "buy_ins_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "buy_ins_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "buy_ins_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "prediction_wallets" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "balance" BIGINT NOT NULL DEFAULT 0,
  "grant_remaining" BIGINT NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prediction_wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prediction_wallets_balance_check" CHECK ("balance" >= 0),
  CONSTRAINT "prediction_wallets_grant_check" CHECK ("grant_remaining" >= 0),
  CONSTRAINT "prediction_wallets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_wallets_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "room_treasuries" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "balance" BIGINT NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_treasuries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_treasuries_balance_check" CHECK ("balance" >= 0),
  CONSTRAINT "room_treasuries_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "prediction_markets" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "hand_id" UUID NOT NULL,
  "market_type" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "liquidity" BIGINT NOT NULL DEFAULT 0,
  "model_version" TEXT NOT NULL,
  "model_snapshot" JSONB NOT NULL,
  "opened_at" TIMESTAMPTZ(6),
  "lock_due_at" TIMESTAMPTZ(6),
  "locked_at" TIMESTAMPTZ(6),
  "settled_at" TIMESTAMPTZ(6),
  "resolution_player_id" UUID,
  "void_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prediction_markets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prediction_markets_liquidity_check" CHECK ("liquidity" >= 0),
  CONSTRAINT "prediction_markets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_markets_hand_id_fkey" FOREIGN KEY ("hand_id") REFERENCES "hands"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_markets_resolution_player_id_fkey" FOREIGN KEY ("resolution_player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "prediction_quotes" (
  "id" UUID NOT NULL,
  "market_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "candidate_player_id" UUID NOT NULL,
  "real_stake" BIGINT NOT NULL DEFAULT 0,
  "virtual_stake" BIGINT NOT NULL DEFAULT 0,
  "model_probability" DOUBLE PRECISION NOT NULL,
  "odds" DOUBLE PRECISION NOT NULL,
  "reason_codes" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prediction_quotes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prediction_quotes_real_stake_check" CHECK ("real_stake" >= 0),
  CONSTRAINT "prediction_quotes_virtual_stake_check" CHECK ("virtual_stake" >= 0),
  CONSTRAINT "prediction_quotes_probability_check" CHECK ("model_probability" >= 0 AND "model_probability" <= 1),
  CONSTRAINT "prediction_quotes_odds_check" CHECK ("odds" >= 0),
  CONSTRAINT "prediction_quotes_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "prediction_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_quotes_candidate_player_id_fkey" FOREIGN KEY ("candidate_player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "prediction_bets" (
  "id" UUID NOT NULL,
  "market_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "candidate_player_id" UUID NOT NULL,
  "stake" BIGINT NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "gross_payout" BIGINT NOT NULL DEFAULT 0,
  "net_profit" BIGINT NOT NULL DEFAULT 0,
  "quote_revision" INTEGER NOT NULL,
  "client_request_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMPTZ(6),
  CONSTRAINT "prediction_bets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prediction_bets_stake_check" CHECK ("stake" > 0),
  CONSTRAINT "prediction_bets_payout_check" CHECK ("gross_payout" >= 0),
  CONSTRAINT "prediction_bets_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "prediction_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_bets_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "prediction_bets_candidate_player_id_fkey" FOREIGN KEY ("candidate_player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "room_ledger_entries" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "member_id" UUID,
  "market_id" UUID,
  "transfer_id" UUID NOT NULL,
  "account_type" VARCHAR(32) NOT NULL,
  "entry_type" VARCHAR(64) NOT NULL,
  "amount" BIGINT NOT NULL,
  "balance_after" BIGINT,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_ledger_entries_amount_check" CHECK ("amount" <> 0),
  CONSTRAINT "room_ledger_entries_balance_after_check" CHECK ("balance_after" IS NULL OR "balance_after" >= 0),
  CONSTRAINT "room_ledger_entries_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_ledger_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "room_ledger_entries_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "prediction_markets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "player_behavior_stats" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "sample_size" INTEGER NOT NULL DEFAULT 0,
  "opportunities" INTEGER NOT NULL DEFAULT 0,
  "bets" INTEGER NOT NULL DEFAULT 0,
  "raises" INTEGER NOT NULL DEFAULT 0,
  "folds" INTEGER NOT NULL DEFAULT 0,
  "all_ins" INTEGER NOT NULL DEFAULT 0,
  "showdowns" INTEGER NOT NULL DEFAULT 0,
  "main_pot_wins" INTEGER NOT NULL DEFAULT 0,
  "average_decision_ms" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "player_behavior_stats_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "player_behavior_stats_nonnegative_check" CHECK (
    "sample_size" >= 0 AND "opportunities" >= 0 AND "bets" >= 0 AND "raises" >= 0
    AND "folds" >= 0 AND "all_ins" >= 0 AND "showdowns" >= 0 AND "main_pot_wins" >= 0
  ),
  CONSTRAINT "player_behavior_stats_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "player_behavior_stats_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "reentry_requests" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "member_id" UUID NOT NULL,
  "player_id" UUID NOT NULL,
  "amount" BIGINT NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "client_request_id" TEXT NOT NULL,
  "reviewed_by_participant_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMPTZ(6),
  CONSTRAINT "reentry_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reentry_requests_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "reentry_requests_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reentry_requests_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reentry_requests_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reentry_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by_participant_id") REFERENCES "room_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_wallets_user_id_key" ON "user_wallets"("user_id");
CREATE UNIQUE INDEX "wallet_ledger_entries_idempotency_key_key" ON "wallet_ledger_entries"("idempotency_key");
CREATE INDEX "wallet_ledger_entries_wallet_id_created_at_idx" ON "wallet_ledger_entries"("wallet_id", "created_at");
CREATE INDEX "wallet_ledger_entries_transfer_id_idx" ON "wallet_ledger_entries"("transfer_id");
CREATE UNIQUE INDEX "room_members_room_name_key" ON "room_members"("room_id", LOWER("display_name"));
CREATE INDEX "room_members_room_id_state_idx" ON "room_members"("room_id", "state");
CREATE UNIQUE INDEX "room_member_accounts_member_user_active_key" ON "room_member_accounts"("member_id", "user_id", "is_active");
CREATE UNIQUE INDEX "room_member_accounts_one_active_member_key" ON "room_member_accounts"("member_id") WHERE "is_active" = true;
CREATE INDEX "room_member_accounts_user_id_is_active_idx" ON "room_member_accounts"("user_id", "is_active");
CREATE UNIQUE INDEX "buy_ins_transfer_id_key" ON "buy_ins"("transfer_id");
CREATE UNIQUE INDEX "buy_ins_room_member_request_key" ON "buy_ins"("room_id", "member_id", "client_request_id");
CREATE INDEX "buy_ins_member_id_created_at_idx" ON "buy_ins"("member_id", "created_at");
CREATE UNIQUE INDEX "prediction_wallets_member_id_key" ON "prediction_wallets"("member_id");
CREATE INDEX "prediction_wallets_room_id_idx" ON "prediction_wallets"("room_id");
CREATE UNIQUE INDEX "room_treasuries_room_id_key" ON "room_treasuries"("room_id");
CREATE UNIQUE INDEX "prediction_markets_hand_id_key" ON "prediction_markets"("hand_id");
CREATE INDEX "prediction_markets_room_id_status_idx" ON "prediction_markets"("room_id", "status");
CREATE UNIQUE INDEX "prediction_quotes_market_revision_candidate_key" ON "prediction_quotes"("market_id", "revision", "candidate_player_id");
CREATE INDEX "prediction_quotes_market_id_revision_idx" ON "prediction_quotes"("market_id", "revision");
CREATE UNIQUE INDEX "prediction_bets_market_member_key" ON "prediction_bets"("market_id", "member_id");
CREATE UNIQUE INDEX "prediction_bets_market_member_request_key" ON "prediction_bets"("market_id", "member_id", "client_request_id");
CREATE INDEX "prediction_bets_market_candidate_idx" ON "prediction_bets"("market_id", "candidate_player_id");
CREATE INDEX "prediction_bets_member_created_at_idx" ON "prediction_bets"("member_id", "created_at");
CREATE UNIQUE INDEX "room_ledger_entries_idempotency_key_key" ON "room_ledger_entries"("idempotency_key");
CREATE INDEX "room_ledger_entries_room_created_at_idx" ON "room_ledger_entries"("room_id", "created_at");
CREATE INDEX "room_ledger_entries_transfer_id_idx" ON "room_ledger_entries"("transfer_id");
CREATE UNIQUE INDEX "player_behavior_stats_member_id_key" ON "player_behavior_stats"("member_id");
CREATE INDEX "player_behavior_stats_room_member_idx" ON "player_behavior_stats"("room_id", "member_id");
CREATE UNIQUE INDEX "reentry_requests_room_member_request_key" ON "reentry_requests"("room_id", "member_id", "client_request_id");
CREATE UNIQUE INDEX "reentry_requests_one_pending_member_key" ON "reentry_requests"("member_id") WHERE "status" = 'pending';
CREATE INDEX "reentry_requests_room_status_idx" ON "reentry_requests"("room_id", "status");
CREATE INDEX "room_participants_member_id_idx" ON "room_participants"("member_id");
CREATE INDEX "players_member_id_idx" ON "players"("member_id");
CREATE UNIQUE INDEX "players_one_live_seat_per_member_key" ON "players"("member_id") WHERE "member_id" IS NOT NULL AND "participant_id" IS NOT NULL;

ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "players" ADD CONSTRAINT "players_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "room_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hands" ADD CONSTRAINT "hands_main_pot_winner_id_fkey" FOREIGN KEY ("main_pot_winner_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing live seats become stable room members. A live account seat already owns
-- the old account balance, so its free wallet starts at zero to avoid duplication.
INSERT INTO "user_wallets" ("id", "user_id", "balance")
SELECT gen_random_uuid(), u."id",
  CASE WHEN EXISTS (
    SELECT 1 FROM "players" p
    WHERE p."user_id" = u."id" AND p."participant_id" IS NOT NULL AND p."balance_settled" = false
  ) THEN 0 ELSE GREATEST(u."balance", 0)::BIGINT END
FROM "users" u;

INSERT INTO "wallet_ledger_entries" (
  "id", "wallet_id", "transfer_id", "entry_type", "amount", "balance_after", "idempotency_key", "metadata"
)
SELECT gen_random_uuid(), w."id", gen_random_uuid(), 'OPENING_BALANCE', w."balance", w."balance",
  'wallet-opening:' || w."user_id"::text, jsonb_build_object('source', 'users.balance')
FROM "user_wallets" w
WHERE w."balance" > 0;

INSERT INTO "room_members" (
  "id", "room_id", "display_name", "state", "approved_by_participant_id", "initial_buy_in"
)
SELECT gen_random_uuid(), p."room_id", p."name",
  CASE WHEN p."stack" > 0 THEN 'playing' ELSE 'spectating' END,
  r."dealer_id", GREATEST(p."stack" + p."total_committed", 1)::BIGINT
FROM "players" p
JOIN "rooms" r ON r."id" = p."room_id"
WHERE p."participant_id" IS NOT NULL;

UPDATE "players" p
SET "member_id" = m."id"
FROM "room_members" m
WHERE m."room_id" = p."room_id" AND LOWER(m."display_name") = LOWER(p."name") AND p."participant_id" IS NOT NULL;

UPDATE "room_participants" rp
SET "member_id" = p."member_id"
FROM "players" p
WHERE p."participant_id" = rp."id" AND p."member_id" IS NOT NULL;

INSERT INTO "room_member_accounts" ("id", "member_id", "user_id", "bound_by_participant_id")
SELECT gen_random_uuid(), p."member_id", p."user_id", r."dealer_id"
FROM "players" p
JOIN "rooms" r ON r."id" = p."room_id"
WHERE p."member_id" IS NOT NULL AND p."user_id" IS NOT NULL;

INSERT INTO "buy_ins" (
  "id", "room_id", "member_id", "player_id", "amount", "kind", "transfer_id", "client_request_id"
)
SELECT gen_random_uuid(), p."room_id", p."member_id", p."id",
  GREATEST(p."stack" + p."total_committed", 1)::BIGINT, 'initial', gen_random_uuid(), 'migration:' || p."id"::text
FROM "players" p
WHERE p."member_id" IS NOT NULL;

INSERT INTO "player_behavior_stats" ("id", "room_id", "member_id")
SELECT gen_random_uuid(), m."room_id", m."id" FROM "room_members" m;

UPDATE "users" u
SET "balance" = LEAST(w."balance", 2000000000)::INTEGER
FROM "user_wallets" w
WHERE w."user_id" = u."id";
