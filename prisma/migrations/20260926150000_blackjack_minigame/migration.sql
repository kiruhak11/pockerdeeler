CREATE TABLE "blackjack_rounds" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "stake" BIGINT NOT NULL,
  "player_cards" JSONB NOT NULL,
  "dealer_cards" JSONB NOT NULL,
  "shoe" JSONB NOT NULL,
  "next_card" INTEGER NOT NULL DEFAULT 4,
  "player_total" INTEGER NOT NULL,
  "dealer_total" INTEGER NOT NULL,
  "dealer_soft" BOOLEAN NOT NULL DEFAULT false,
  "dealer_hole_hidden" BOOLEAN NOT NULL DEFAULT true,
  "outcome" VARCHAR(16),
  "payout" BIGINT NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "settled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "blackjack_rounds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blackjack_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "round_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "action" VARCHAR(8) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blackjack_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blackjack_rounds_idempotency_key_key" ON "blackjack_rounds"("idempotency_key");
CREATE INDEX "blackjack_rounds_user_id_status_created_at_idx" ON "blackjack_rounds"("user_id", "status", "created_at");
CREATE UNIQUE INDEX "blackjack_one_active_round_per_user" ON "blackjack_rounds"("user_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "blackjack_actions_round_id_request_id_key" ON "blackjack_actions"("round_id", "request_id");
CREATE INDEX "blackjack_actions_round_id_created_at_idx" ON "blackjack_actions"("round_id", "created_at");

ALTER TABLE "blackjack_rounds" ADD CONSTRAINT "blackjack_rounds_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blackjack_actions" ADD CONSTRAINT "blackjack_actions_round_id_fkey"
  FOREIGN KEY ("round_id") REFERENCES "blackjack_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
