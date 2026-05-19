CREATE TABLE "friend_requests" (
  "id" UUID NOT NULL,
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "friend_requests_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "friend_requests_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "friendships" (
  "id" UUID NOT NULL,
  "user_a_id" UUID NOT NULL,
  "user_b_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "friendships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "friendships_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "friendships_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "room_invites" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_invites_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_invites_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_invites_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "room_chat_messages" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "participant_id" UUID,
  "user_id" UUID,
  "sender_name" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "room_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "room_chat_messages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "room_chat_messages_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "room_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "room_chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "friend_requests_from_user_id_to_user_id_key" ON "friend_requests"("from_user_id", "to_user_id");
CREATE INDEX "friend_requests_to_user_id_status_idx" ON "friend_requests"("to_user_id", "status");
CREATE INDEX "friend_requests_from_user_id_status_idx" ON "friend_requests"("from_user_id", "status");

CREATE UNIQUE INDEX "friendships_user_a_id_user_b_id_key" ON "friendships"("user_a_id", "user_b_id");
CREATE INDEX "friendships_user_a_id_idx" ON "friendships"("user_a_id");
CREATE INDEX "friendships_user_b_id_idx" ON "friendships"("user_b_id");

CREATE UNIQUE INDEX "room_invites_room_id_from_user_id_to_user_id_key" ON "room_invites"("room_id", "from_user_id", "to_user_id");
CREATE INDEX "room_invites_room_id_status_idx" ON "room_invites"("room_id", "status");
CREATE INDEX "room_invites_to_user_id_status_idx" ON "room_invites"("to_user_id", "status");

CREATE INDEX "room_chat_messages_room_id_created_at_idx" ON "room_chat_messages"("room_id", "created_at");
CREATE INDEX "room_chat_messages_participant_id_idx" ON "room_chat_messages"("participant_id");
CREATE INDEX "room_chat_messages_user_id_idx" ON "room_chat_messages"("user_id");
