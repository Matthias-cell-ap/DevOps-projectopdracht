# DevOps-projectopdracht
Dit is mijn projectopdracht, hierbij een handleiding om het project werkend te krijgen op je eigen apparaat. Voor informatie over de diensten verwijs ik je door naar https://info.matthias-gym-app.duckdns.org.

# Installatie

## Vereisten
- Ubuntu (of WSL2) met Docker, Tailscale en restic geïnstalleerd
- Een DuckDNS-domein en token
- Een VPS met Docker en Tailscale, met poort 80 en 443 open

## Stappen op de laptop
1. Clone de repository met onderstaand commando en voer het startup script uit, hierna volgen nog enkele manuele stappen. Het script meerdere keren laten uitvoeren gaat niet, onderbreek de werking van het script dus niet. Loopt het toch mis, verwijder dan de `.env` bestanden, `secrets/` en `config/authelia/users_database.yml` en voer het opnieuw uit.
```bash
git clone https://github.com/Matthias-cell-ap/DevOps-projectopdracht.git ~/devops/projectopdracht
cd ~/devops/projectopdracht

scripts/startup.sh
```
2. Vul dan je persoonlijke DuckDNS-token in in het bestand `traefik.env` en het e-mailadres van de admin in `schautrack.env`.
3. Maak een wachtwoord aan voor je gebruiker met onderstaand commando. Vul dan wat achter `Digest:` komt in bij `password` in `config/authelia/users_database.yml`, vul hier ook de e-mail en gebruikersnaam in:
```bash
docker run --rm -it authelia/authelia:4.39.28 authelia crypto hash generate argon2
```
4. Voer onderstaand commando 2 keer uit. een keer voor Memos en een keer voor Schautrack. Elke keer krijg je een random password en een digest die bij elkaar horen.
De digest komt bij `client_secret` van die client in `config/authelia/configuration.yml`. Het random password van Schautrack moet je invullen in `schautrack.env` (`OIDC_CLIENT_SECRET`) en het wachtwoord van Memos gebruiken we in stap 6.
```bash
docker run --rm authelia/authelia:4.39.28 authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986
```
5. Start alles met `docker compose up -d`.
6. De instellingen van Memos staan niet in een bestand maar in de database van Memos. Ga in de browser naar `https://notes.matthias-gym-app.duckdns.org` en log in. Ga dan in de settings naar de SSO-instellingen en vul onderstaande velden in.
   - Client ID: `memos`
   - Client secret: het random password van de eerste run van stap 4
   - Authorization endpoint: `https://auth.matthias-gym-app.duckdns.org/api/oidc/authorization`
   - Token endpoint: `https://auth.matthias-gym-app.duckdns.org/api/oidc/token`
   - User endpoint: `https://auth.matthias-gym-app.duckdns.org/api/oidc/userinfo`
   - Scopes: `openid profile email`
7. Ga naar je VPS en clone hier de repo opnieuw met `git clone https://github.com/Matthias-cell-ap/DevOps-projectopdracht.git`. Zet dan in `vps/nginx.conf` het Tailscale IP van je laptop en in `vps/docker-compose.yml` bij `backup-server` het Tailscale IP van de VPS. Je Tailscale IP kan je zien op de site van Tailscale of met `tailscale ip -4`. Start het daarna op en maak een gebruiker aan met onderstaand commando. Je moet een wachtwoord kiezen, dit heb je nodig in stap 8.
```bash
cd DevOps-projectopdracht/vps
docker compose up -d
docker compose exec backup-server create_user laptop
```
8. Ga terug naar je laptop. Bij stap 7 koos je een wachtwoord dat we nu gebruiken om de laptop toegang te geven tot de backup server van de VPS. Vervang wat tussen <> staat met de werkelijke waarden en voer onderstaande regels uit.
```bash
echo 'rest:http://laptop:<wachtwoord uit stap 7>@<tailscale ip vps>:8000/' | sudo tee /root/.restic-vps-repo > /dev/null
sudo chmod 600 /root/.restic-vps-repo
sudo restic --repository-file /root/.restic-vps-repo --password-file /root/.restic-password init
```
9. Zet de timers voor backup en deploy aan, we doen dit nu pas omdat het anders foutmeldingen kan geven als eerdere stappen nog niet uitgevoerd zijn.
```bash
sudo systemctl enable --now backup.timer deploy.timer
```
10. Bewaar het restic-wachtwoord goed op meerdere plekken, dit wachtwoord is nodig om de backups te gebruiken. Als je het enkel op je laptop opslaat, kunnen de backups niet gebruikt worden zonder de laptop. Je ziet het wachtwoord met `sudo cat /root/.restic-password`.

# Backups
`backup.timer` maakt elke nacht een backup. Er worden lokaal 7 dagelijkse en 8 wekelijkse backups bewaard, en ze worden gekopieerd naar de VPS. Hieronder enkele nuttige commando's.

1. Nu een backup maken
```bash
sudo ./scripts/backup.sh
```
2. Een backup terugzetten. Moest je de backup van de VPS willen halen, gebruik dan `--repository-file /root/.restic-vps-repo` in plaats van `-r /backups`.
```bash
sudo restic -r /backups --password-file /root/.restic-password snapshots
sudo restic -r /backups --password-file /root/.restic-password restore latest --target /tmp/restore
```
Dit zet de bestanden nog in een tijdelijke map, voor de apps met SQLite (Memos, Authelia, Gatus) stop je eerst de app om te vermijden dat er dingen fout lopen doordat de app probeert te schrijven terwijl je de bestanden vervangt. Vervang de waarden in <> door de naam van de app die je wilt terug zetten
```bash
docker compose stop <naam>
sudo rsync -a --delete /tmp/restore/data/<naam>/ data/<naam>/
docker compose start <naam>
```
Voor de andere apps (gym-app en schautrack) voer je onderstaande code uit. Vervang de waarden in <> door de waarden met het overeenkomende nummer van de gewenste app.
`gym-app: 1 = gym gym-api, 2 = gym-db, 3 = gym.sql, 4 = projectopdracht_gym-db-data`
`Schautrack: 1 = schautrack, 2 = schautrack-db, 3 = schautrack.sql, 4 = projectopdracht_schautrack-db-data`
```bash
DUMP=$(sudo find /tmp/restore -name <3>)
docker compose stop <1>
docker compose rm -sf <2>
docker volume rm <4>
docker compose up -d --wait <2>
sudo cat "$DUMP" | docker compose exec -T <2> sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d <1>
```
Ruim daarna op met `sudo rm -rf /tmp/restore`, want er staan geheime bestanden in de backups.