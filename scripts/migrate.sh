#!/usr/bin/env sh
set -eu

if [ -z "${DIRECT_DATABASE_URL:-}" ]; then
  echo "DIRECT_DATABASE_URL is required for migrations"
  exit 1
fi

echo "Running Prisma migrate deploy using DIRECT_DATABASE_URL"
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy
