#!/usr/bin/env sh
set -eu

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"

printf 'Waiting for database %s:%s...\n' "$DB_HOST" "$DB_PORT"

until nc -z "$DB_HOST" "$DB_PORT"; do
  sleep 1
done

printf 'Database is reachable.\n'
