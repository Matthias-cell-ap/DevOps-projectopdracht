# gym-api

Backend for the self-hosted web version of the gym app. It stores the app's data in
PostgreSQL, separately for every user: each Authelia user gets their own gym app.
The Android app doesn't use it: that one keeps its data on the phone.

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
| `GYM_MIGRATE_OWNER` | once, see below | — | `matthias` |
| `GYM_DEFAULT_USER` | no — **local development only** | — | `dev` |

**Upgrading from the single-user version:** its tables have no owner. On the first start
the server needs `GYM_MIGRATE_OWNER` (the Authelia username the existing data belongs to);
without it, it refuses to start rather than guess. After that start the setting does nothing
and can be removed.

**`GYM_DEFAULT_USER`** acts as the logged-in user when a request has none — for running the
app on your own machine without Authelia (`npm run dev:server`). Never set it on the server:
anyone reaching the API would then be that user.

On start the server waits for the database (up to ~1 minute), creates its tables if they
don't exist yet, and listens on `PORT`. It stops cleanly on `SIGTERM` (`docker stop`).

## Security

There is **no login in this server**. The reverse proxy checks the login (forward auth)
before a request reaches it, and tells the server who it is: after the Authelia login,
Traefik sets the header `Remote-User` (`authResponseHeaders` on the middleware). Traefik
**replaces** a `Remote-User` header the browser sent itself, so nobody can pretend to be
someone else. A request without that header gets `401`.

That only holds if the proxy is the *only* way in: never publish this server's port, and
keep it on a network that only the gym frontend (whose nginx forwards `/api`) and the
database share. Any other container that could reach the API could send any `Remote-User`.

## API

All bodies are JSON. `:table` is one of the app's tables (see `src/tables.js`); anything
else is refused. Every route except `/api/health` works on the data of the logged-in user only.

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

One SQL table per app table, all with the same columns:

```sql
owner      TEXT               -- the Authelia username this row belongs to
key        TEXT               -- the row's id / date / exerciseId / day
data       JSONB NOT NULL     -- the row as the app stores it
updated_at TIMESTAMPTZ        -- last change, set by the database
PRIMARY KEY (owner, key)      -- two users can both have a log for the same day
```

Every query has `WHERE owner = <logged-in user>`: a user can't read, change or delete
another user's rows, and restoring a backup only replaces that user's data. New users get
the default exercise library, schedule and profile on their first visit.

Why JSONB instead of a column per field: the app's rows change with the app (it has had
5 schema versions so far). With JSONB the server doesn't need a migration for every new
field, and Postgres still gives transactions, constraints on the key, and `pg_dump` backups.
You can query inside the rows:

```sql
SELECT owner, data->>'date' AS date, data->>'weight' AS kg FROM daily_logs ORDER BY owner, key;
```

## Running it without Docker

```bash
npm ci
DATABASE_URL=postgres://gym:secret@localhost:5432/gym GYM_DEFAULT_USER=dev npm start
# and in the app folder (one level up): the dev server forwards /api to port 3000
npm run dev:server
```

## Tests

- `../test/dal-parity.test.js` runs the same actions against the phone data layer
  (IndexedDB) and against this server, and checks that every result is identical.
- `../test/multi-user.test.js` checks that users only see their own data, that requests
  without a user are refused, and that single-user data is migrated correctly.

Both **wipe** the database you give them, so use a separate one:

```bash
npm ci --prefix server
TEST_DATABASE_URL=postgres://gym:secret@localhost:5432/gym_test npm test
```
