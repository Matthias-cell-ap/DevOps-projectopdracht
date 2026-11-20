# Installatie

## Vereisten
- Ubuntu (of WSL2) met Docker, Tailscale en restic geïnstalleerd
- Een DuckDNS-domein en token
- Een VPS met Docker en Tailscale, met poort 80 en 443 open

## Stappen
1. `git clone https://github.com/Matthias-cell-ap/DevOps-projectopdracht.git` en ga naar de map.
2. Maak de env-bestanden aan vanaf de voorbeelden: `cp <naam>.env.example <naam>.env` en vul ze in.
3. Maak de secrets voor Authelia aan:
   ```bash
   mkdir -p secrets/authelia
   for f in session_secret storage_encryption_key jwt_secret oidc_hmac_secret; do openssl rand -hex 32 > secrets/authelia/$f; done
   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/secrets/authelia:/keys" authelia/authelia:4.39.28 authelia crypto pair rsa generate --directory /keys
   ```
4. Maak `config/authelia/users_database.yml` aan. Een wachtwoord-hash maak je zo:
   ```bash
   docker run --rm -it authelia/authelia:4.39.28 authelia crypto hash generate argon2
   ```
   Zet de regel na `Digest:` bij `password:` van je gebruiker.
5. Start alles: `docker compose up -d`.
6. Installeer de timers:
   ```bash
   sudo cp systemd/* /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now backup.timer deploy.timer
   ```
7. VPS: zet het Tailscale-IP van je laptop in `vps/nginx.conf`, en start op de VPS `cd vps && docker compose up -d`.
8. Backups: maak `/root/.restic-password` en `/root/.restic-vps-repo` aan, en maak beide repo's aan met `restic init`.