#!/usr/bin/env bash
set -euo pipefail

PROJECT=/home/pyfro/devops/projectopdracht
LOCAL_REPO=/backups
VPS_REPO_FILE=/root/.restic-vps-repo
export RESTIC_PASSWORD_FILE=/root/.restic-password
DUMPS="$PROJECT/backup-dumps"

cd "$PROJECT"
mkdir -p "$DUMPS"

echo "1/5 Databases exporteren"
docker compose exec -T gym-db sh -c 'pg_dump --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DUMPS/gym.sql"
docker compose exec -T schautrack-db sh -c 'pg_dump --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DUMPS/schautrack.sql"

echo "2/5 Apps met een SQLite-bestand even stoppen"
docker compose stop memos authelia
trap 'docker compose start memos authelia' EXIT

echo "3/5 Lokale backup maken"
restic -r "$LOCAL_REPO" backup --tag devops \
  "$DUMPS" data/memos data/authelia data/gatus \
  secrets config/authelia/users_database.yml *.env

docker compose start memos authelia
trap - EXIT

echo "4/5 Lokaal opruimen"
restic -r "$LOCAL_REPO" forget --keep-daily 7 --keep-weekly 8 --prune

echo "5/5 Kopie naar de VPS"
restic --repository-file "$VPS_REPO_FILE" copy --from-repo "$LOCAL_REPO" --from-password-file "$RESTIC_PASSWORD_FILE"
restic --repository-file "$VPS_REPO_FILE" forget --keep-daily 7 --keep-weekly 8 --prune

rm -f "$DUMPS"/*.sql
echo "Klaar"