CREATE TABLE "online_stack_operations" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "reservation_id" UUID NOT NULL,
  "request_key" UUID NOT NULL,
  "direction" VARCHAR(8) NOT NULL,
  "amount" BIGINT NOT NULL,
  "stack_before" BIGINT NOT NULL,
  "stack_after" BIGINT NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PREPARED',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "online_stack_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "online_stack_operations_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "online_rooms"("id") ON DELETE CASCADE,
  CONSTRAINT "online_stack_operations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "online_stack_operations_reservation_id_fkey"
    FOREIGN KEY ("reservation_id") REFERENCES "online_room_players"("id") ON DELETE CASCADE,
  CONSTRAINT "online_stack_operations_direction_check"
    CHECK ("direction" IN ('ADD', 'WITHDRAW')),
  CONSTRAINT "online_stack_operations_amount_check"
    CHECK ("amount" > 0),
  CONSTRAINT "online_stack_operations_state_check"
    CHECK ("status" IN ('PREPARED', 'RUNTIME_APPLIED', 'COMPLETED'))
);

CREATE UNIQUE INDEX "online_stack_operations_room_id_user_id_request_key_key"
  ON "online_stack_operations" ("room_id", "user_id", "request_key");
CREATE INDEX "online_stack_operations_status_created_at_idx"
  ON "online_stack_operations" ("status", "created_at");
CREATE INDEX "online_stack_operations_room_id_status_idx"
  ON "online_stack_operations" ("room_id", "status");
