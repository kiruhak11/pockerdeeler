CREATE TABLE "room_code_registry" (
  "code" VARCHAR(8) PRIMARY KEY,
  "room_type" VARCHAR(16) NOT NULL,
  "target_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "room_code_registry_room_type_target_id_key" UNIQUE ("room_type", "target_id")
);

CREATE INDEX "room_code_registry_room_type_idx" ON "room_code_registry" ("room_type");
CREATE INDEX "room_code_registry_target_id_idx" ON "room_code_registry" ("target_id");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "rooms"
    GROUP BY UPPER(BTRIM("code"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot backfill room_code_registry: normalized HOME room code collision detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "rooms"
    WHERE BTRIM("code") = ''
       OR LENGTH(BTRIM("code")) > 8
       OR BTRIM("code") !~ '^[A-Za-z0-9]+$'
  ) THEN
    RAISE EXCEPTION 'Cannot backfill room_code_registry: invalid HOME room code detected';
  END IF;
END $$;

INSERT INTO "room_code_registry" ("code", "room_type", "target_id")
SELECT UPPER(BTRIM("code")), 'HOME', "id"::text
FROM "rooms";

CREATE TABLE "online_rooms" (
  "id" UUID PRIMARY KEY,
  "room_code" VARCHAR(8) NOT NULL UNIQUE,
  "visibility" VARCHAR(8) NOT NULL,
  "owner_id" VARCHAR(128) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "max_players" INTEGER NOT NULL DEFAULT 6,
  "private_join_secret_hash" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX "online_rooms_visibility_status_idx" ON "online_rooms" ("visibility", "status");
CREATE INDEX "online_rooms_owner_id_idx" ON "online_rooms" ("owner_id");
