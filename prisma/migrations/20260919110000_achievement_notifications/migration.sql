CREATE TABLE "achievement_notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempted_at" TIMESTAMPTZ(6),
  "sent_at" TIMESTAMPTZ(6),
  CONSTRAINT "achievement_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "achievement_notifications_user_id_code_key" ON "achievement_notifications"("user_id", "code");
CREATE INDEX "achievement_notifications_attempted_at_created_at_idx" ON "achievement_notifications"("attempted_at", "created_at");
-- Existing grants are tombstones, not messages to broadcast on deployment.
INSERT INTO "achievement_notifications" ("user_id", "code", "text", "attempted_at")
SELECT ua.user_id, a.code, '', CURRENT_TIMESTAMP
FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
ON CONFLICT DO NOTHING;
INSERT INTO "achievement_notifications" ("user_id", "code", "text", "attempted_at")
SELECT w.user_id, l.metadata->>'code', '', CURRENT_TIMESTAMP
FROM wallet_ledger_entries l JOIN user_wallets w ON w.id = l.wallet_id
WHERE l.entry_type = 'ACHIEVEMENT_REWARD' AND l.metadata->>'code' IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO "achievement_notifications" ("user_id", "code", "text", "attempted_at")
SELECT u.id, a.code, '', CURRENT_TIMESTAMP
FROM admin_audits h JOIN users u ON h.entity_id = u.id::text
JOIN achievements a ON a.code = h.data->>'achievement'
WHERE h.action = 'user.achievement.grant'
ON CONFLICT DO NOTHING;
