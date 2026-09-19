CREATE TABLE "legal_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "type" VARCHAR(48) NOT NULL,
  "version" VARCHAR(32) NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "content_path" TEXT,
  "content_hash" VARCHAR(64) NOT NULL,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "legal_acceptances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "version" VARCHAR(32) NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "context" VARCHAR(32) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip" VARCHAR(64) NOT NULL,
  "user_agent" TEXT NOT NULL,
  "payment_id" VARCHAR(128),
  "order_id" VARCHAR(128),
  "request_id" UUID NOT NULL,
  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "legal_acceptances_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "legal_documents_type_version_key" ON "legal_documents"("type", "version");
CREATE UNIQUE INDEX "legal_documents_one_active_type_idx" ON "legal_documents"("type") WHERE "is_active" = true;
CREATE INDEX "legal_documents_type_is_active_effective_from_idx" ON "legal_documents"("type", "is_active", "effective_from");
CREATE UNIQUE INDEX "legal_acceptances_request_id_document_id_key" ON "legal_acceptances"("request_id", "document_id");
CREATE INDEX "legal_acceptances_user_id_document_id_context_idx" ON "legal_acceptances"("user_id", "document_id", "context");
CREATE INDEX "legal_acceptances_user_id_accepted_at_idx" ON "legal_acceptances"("user_id", "accepted_at");
CREATE INDEX "legal_acceptances_payment_id_idx" ON "legal_acceptances"("payment_id");
CREATE INDEX "legal_acceptances_order_id_idx" ON "legal_acceptances"("order_id");
