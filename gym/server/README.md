# gym-api

Backend for the self-hosted web version of the gym app. It stores the app's data in
PostgreSQL. The Android app doesn't use it: that one keeps its data on the phone.

```
browser ──► reverse proxy (HTTPS + login) ──► gym frontend (nginx, static files)
                                         └──► /api/* ──► gym-api (this) ──► PostgreSQL
```

The app picks its data layer at build time:

| build | data layer | data lives in |
|---|---|---|
| `npm run build` | `src/db/dal.js` | IndexedDB on the phone (Android app) |
| `npm run build:server` | `src/db/dal.api.js` | this server's PostgreSQL database |

## Configuration

| variable | required | default | example |
|---|---|---|---|
| `DATABASE_URL` | yes | — | `postgres://gym:secret@gym-db:5432/gym` |
| `PORT` | no | `3000` | |

On start the server waits for the database (up to ~1 minute), creates its tables if they
don't exist yet, and listens on `PORT`. It stops cleanly on `SIGTERM` (`docker stop`).

## Security

There is **no login in this server**. The reverse proxy checks the login (forward auth)
before a request reaches it. That only works if the proxy is the *only* way in:
never publish this server's port, only put it on the network the proxy can reach.

## API

All bodies are JSON. `:table` is one of the app's tables (see `src/tables.js`); anything
else is refused.

| method | path | body | answer |
|---|---|---|---|
| GET | `/api/health` | | `200 {status:"ok"}`, or `503` when the database is unreachable |
| GET | `/api/status` | | `{emptyTables: [...]}` |
| POST | `/api/init` | `{defaults: {table: [rows]}}` | fills only tables that are still empty |
| GET | `/api/data/:table` | | `{rows: [...]}` |
| GET | `/api/data/:table/:key` | | `{row: {...}}` or `{row: null}` |
| PUT | `/api/data/:table` | `{rows: [...]}` | insert or replace; `{keys: [...]}` |
| POST | `/api/data/:table/delete` | `{keys: [...]}` | `{deleted: n}` |
| PUT | `/api/import` | `{tables: {table: [rows]}}` | restore a backup: replaces those tables, in one transaction |

## Data model

One SQL table per app table, all with the same three columns:

```sql
key        TEXT PRIMARY KEY   -- the row's id / date / exerciseId / day
data       JSONB NOT NULL     -- the row as the app stores it
updated_at TIMESTAMPTZ        -- last change, set by the database
```

Why JSONB instead of a column per field: the app's rows change with the app (it has had
5 schema versions so far). With JSONB the server doesn't need a migration for every new
field, and Postgres still gives transactions, constraints on the key, and `pg_dump` backups.
You can query inside the rows:

```sql
SELECT data->>'date' AS date, data->>'weight' AS kg FROM daily_logs ORDER BY key;
```

## Running it without Docker

```bash
npm ci
DATABASE_URL=postgres://gym:secret@localhost:5432/gym npm start
# and in the app folder (one level up): the dev server forwards /api to port 3000
npm run dev:server
```

## Tests

`../test/dal-parity.test.js` runs the same actions against the phone data layer (IndexedDB)
and against this server, and checks that every result is identical. It **wipes** the
database you give it, so use a separate one:

```bash
npm ci --prefix server
TEST_DATABASE_URL=postgres://gym:secret@localhost:5432/gym_test npm test
```
