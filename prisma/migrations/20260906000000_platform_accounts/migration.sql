-- AlterTable
ALTER TABLE "room_chat_messages" ADD COLUMN     "client_request_id" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deletion_reason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "blocked_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phone" VARCHAR(16),
ADD COLUMN     "phone_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "role" VARCHAR(16) NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "account_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "browser_hash" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'creating',
    "provider_id" TEXT,
    "call_phone" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'watching',
    "amount" INTEGER NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'self_promo',
    "request_id" UUID NOT NULL,
    "ready_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "reward_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audits" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_id" TEXT,
    "reason" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_sessions_token_hash_key" ON "account_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "account_sessions_user_id_idx" ON "account_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_verifications_request_id_key" ON "phone_verifications"("request_id");

-- CreateIndex
CREATE INDEX "phone_verifications_phone_created_at_idx" ON "phone_verifications"("phone", "created_at");

-- CreateIndex
CREATE INDEX "phone_verifications_browser_hash_created_at_idx" ON "phone_verifications"("browser_hash", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reward_sessions_request_id_key" ON "reward_sessions"("request_id");

-- CreateIndex
CREATE INDEX "reward_sessions_user_id_created_at_idx" ON "reward_sessions"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_audits_request_id_key" ON "admin_audits"("request_id");

-- CreateIndex
CREATE INDEX "admin_audits_created_at_idx" ON "admin_audits"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "room_chat_messages_room_id_participant_id_client_request_id_key" ON "room_chat_messages"("room_id", "participant_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- AddForeignKey
ALTER TABLE "account_sessions" ADD CONSTRAINT "account_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_sessions" ADD CONSTRAINT "reward_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE users ADD CONSTRAINT user_role_valid CHECK (role IN ('USER','ADMIN','SUPERADMIN'));
ALTER TABLE reward_sessions ADD CONSTRAINT reward_amount_positive CHECK (amount > 0 AND amount <= 100000);
CREATE UNIQUE INDEX reward_one_active_per_user ON reward_sessions(user_id) WHERE status = 'watching';
