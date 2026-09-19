CREATE TABLE "telegram_link_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_link_tokens_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "telegram_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "telegram_link_tokens_user_id_expires_at_idx" ON "telegram_link_tokens"("user_id", "expires_at");
CREATE TABLE "telegram_subscriptions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "chat_id" VARCHAR(64) NOT NULL,
  "telegram_user_id" VARCHAR(64) NOT NULL,
  "username" VARCHAR(128),
  "first_name" VARCHAR(128),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "subscribed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_subscriptions_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "telegram_subscriptions_chat_id_key" UNIQUE ("chat_id"),
  CONSTRAINT "telegram_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "telegram_subscriptions_is_active_last_seen_at_idx" ON "telegram_subscriptions"("is_active", "last_seen_at");
