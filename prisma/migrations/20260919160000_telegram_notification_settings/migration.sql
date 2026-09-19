CREATE TABLE "telegram_notification_settings" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_notification_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_notification_settings_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "telegram_notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
