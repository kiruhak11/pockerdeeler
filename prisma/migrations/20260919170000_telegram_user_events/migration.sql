CREATE TABLE "telegram_user_events" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "category" VARCHAR(32) NOT NULL,
  "event_key" VARCHAR(160) NOT NULL,
  "text" TEXT NOT NULL,
  "attempted_at" TIMESTAMPTZ(6),
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_user_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_user_events_event_key_key" UNIQUE ("event_key"),
  CONSTRAINT "telegram_user_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "telegram_user_events_attempted_at_created_at_idx" ON "telegram_user_events" ("attempted_at", "created_at");
