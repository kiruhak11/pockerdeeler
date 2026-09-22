CREATE TABLE "online_poker_rating_events" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "hand_id" VARCHAR(64) NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "online_poker_rating_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "online_poker_rating_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "online_poker_rating_events_user_id_hand_id_key" ON "online_poker_rating_events"("user_id", "hand_id");
CREATE INDEX "online_poker_rating_events_user_id_created_at_idx" ON "online_poker_rating_events"("user_id", "created_at");
