ALTER TABLE "blackjack_rounds"
  ADD COLUMN "player_hands" JSONB,
  ADD COLUMN "active_hand_index" INTEGER,
  ADD COLUMN "action_revision" INTEGER NOT NULL DEFAULT 0;
