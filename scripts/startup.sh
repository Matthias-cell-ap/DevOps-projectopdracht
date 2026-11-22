#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f gym.env ]; then echo "Er is hier al een installatie (gym.env bestaat). Gestopt." >&2; exit 1; fi

echo "1/5 Voorbeeldbestanden kopiëren"
for f in *.env.example; do cp "$f" "${f%.example}"; done
cp config/authelia/users_database.example.yml config/authelia/users_database.yml

echo "2/5 Databasewachtwoorden aanmaken"
for f in gym.env schautrack.env; do
  pw=$(openssl rand -hex 24)
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pw/; s/<POSTGRES_PASSWORD>/$pw/" "$f"
done

echo "3/5 Geheimen voor Authelia aanmaken"
mkdir -p secrets/authelia
for f in session_secret storage_encryption_key jwt_secret oidc_hmac_secret; do
  openssl rand -hex 32 > "secrets/authelia/$f"
done
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/secrets/authelia:/keys" authelia/authelia:4.39.28 \
  authelia crypto pair rsa generate --directory /keys

echo "4/5 Lokale backup-repo aanmaken"
openssl rand -hex 32 | sudo tee /root/.restic-password > /dev/null
sudo chmod 600 /root/.restic-password
sudo restic -r /backups --password-file /root/.restic-password init

echo "5/5 systemd-bestanden installeren"
for f in systemd/*; do
  sed "s#@PROJECT@#$(pwd -P)#g" "$f" | sudo tee "/etc/systemd/system/$(basename "$f")" > /dev/null
done
sudo systemctl daemon-reload

echo "Klaar. Volg nu de manuele stappen in de README."