ALTER TABLE "users"
ADD COLUMN "account_origin" VARCHAR(32) NOT NULL DEFAULT 'WEB';

CREATE TABLE "external_identities" (
  "id" UUID NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "provider_user_id" VARCHAR(256) NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "websocket_auth_tickets" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "websocket_auth_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_identities_provider_provider_user_id_key"
ON "external_identities"("provider", "provider_user_id");
CREATE UNIQUE INDEX "external_identities_provider_user_id_key"
ON "external_identities"("provider", "user_id");
CREATE INDEX "external_identities_user_id_idx" ON "external_identities"("user_id");
CREATE UNIQUE INDEX "websocket_auth_tickets_token_hash_key" ON "websocket_auth_tickets"("token_hash");
CREATE INDEX "websocket_auth_tickets_user_id_expires_at_idx" ON "websocket_auth_tickets"("user_id", "expires_at");

ALTER TABLE "external_identities"
ADD CONSTRAINT "external_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "websocket_auth_tickets"
ADD CONSTRAINT "websocket_auth_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
