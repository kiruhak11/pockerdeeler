CREATE TABLE "refund_requests" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "purchase_type" VARCHAR(32) NOT NULL,
  "reason" TEXT NOT NULL,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" VARCHAR(24) NOT NULL DEFAULT 'REQUESTED',
  "processed_at" TIMESTAMPTZ(6),
  "decision_reason" TEXT,
  CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refund_requests_payment_id_key" ON "refund_requests"("payment_id");
CREATE INDEX "refund_requests_user_id_requested_at_idx" ON "refund_requests"("user_id", "requested_at");
CREATE INDEX "refund_requests_status_requested_at_idx" ON "refund_requests"("status", "requested_at");
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
