#!/usr/bin/env bash
set -euo pipefail

PROJECT=/home/pyfro/devops/projectopdracht
export RESTIC_REPOSITORY=/backups
export RESTIC_PASSWORD_FILE=/root/.restic-password
DUMPS="$PROJECT/backup-dumps"

cd "$PROJECT"
mkdir -p "$DUMPS"

echo "1/4 Databases exporteren"
docker compose exec -T gym-db sh -c 'pg_dump --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DUMPS/gym.sql"
docker compose exec -T schautrack-db sh -c 'pg_dump --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DUMPS/schautrack.sql"

echo "2/4 Apps met een SQLite-bestand even stoppen"
docker compose stop memos authelia
trap 'docker compose start memos authelia' EXIT

echo "3/4 Backup maken"
restic backup --tag devops \
  "$DUMPS" data/memos data/authelia data/gatus \
  secrets config/authelia/users_database.yml *.env

docker compose start memos authelia
trap - EXIT

echo "4/4 Oude backups opruimen"
restic forget --keep-daily 7 --keep-weekly 8 --prune