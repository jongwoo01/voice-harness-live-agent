#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for migration in "${SCRIPT_DIR}"/migrations/*.sql; do
  echo "Applying ${migration}"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${migration}"
done

echo "Migrations applied successfully."
