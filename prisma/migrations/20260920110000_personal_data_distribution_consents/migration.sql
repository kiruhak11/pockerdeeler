CREATE TABLE "personal_data_distribution_consents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_version" VARCHAR(32) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  "request_id" UUID NOT NULL,
  "ip" VARCHAR(64) NOT NULL,
  "user_agent" TEXT NOT NULL,
  CONSTRAINT "personal_data_distribution_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_data_distribution_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "personal_data_distribution_consents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "personal_data_distribution_permissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "consent_id" UUID NOT NULL,
  "category" VARCHAR(32) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "personal_data_distribution_permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_data_distribution_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "personal_data_distribution_permissions_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "personal_data_distribution_consents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "personal_data_distribution_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "consent_id" UUID,
  "document_version" VARCHAR(32) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "categories" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip" VARCHAR(64) NOT NULL,
  "user_agent" TEXT NOT NULL,
  CONSTRAINT "personal_data_distribution_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_data_distribution_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "personal_data_distribution_audits_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "personal_data_distribution_consents"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "personal_data_distribution_consents_user_id_document_id_document_version_key" ON "personal_data_distribution_consents"("user_id", "document_id", "document_version");
CREATE INDEX "personal_data_distribution_consents_user_id_revoked_at_idx" ON "personal_data_distribution_consents"("user_id", "revoked_at");
CREATE UNIQUE INDEX "pdd_permissions_user_category_active_key" ON "personal_data_distribution_permissions"("user_id", "category", "is_active");
CREATE UNIQUE INDEX "pdd_permissions_consent_category_key" ON "personal_data_distribution_permissions"("consent_id", "category");
CREATE INDEX "pdd_permissions_user_category_active_idx" ON "personal_data_distribution_permissions"("user_id", "category", "is_active");
CREATE INDEX "personal_data_distribution_audits_user_id_created_at_idx" ON "personal_data_distribution_audits"("user_id", "created_at");
