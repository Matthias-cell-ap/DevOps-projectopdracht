import pg from 'pg'
import { TABLES } from './tables.js'

// Connection settings come from DATABASE_URL, e.g.
//   postgres://gym:<password>@gym-db:5432/gym
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })

// A connection that breaks while idle (e.g. the database restarts) must not crash the server;
// the pool simply opens a new one for the next query.
pool.on('error', (err) => console.error('Idle database connection failed:', err.message))

// Runs fn(client) inside one transaction: everything is saved, or nothing is.
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// The database container can still be starting when the server starts: keep trying for a while.
export async function waitForDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      if (i >= attempts) throw err
      console.log(`Database not reachable yet (${err.message}), retry ${i}/${attempts - 1}…`)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
}

// Creates the tables if they don't exist yet. Safe to run on every start.
// Each app table becomes one SQL table: who it belongs to, the row's key, the row itself as
// JSONB, and when it last changed. The app's rows evolve with the app (new fields, schema
// versions); JSONB stores them as they are, so the server doesn't need a migration for every
// new field. The primary key is (owner, key): two users can both have "2026-11-20" as a day.
//
// migrateOwner: only needed once, when upgrading from the single-user version (see below).
export async function migrate({ migrateOwner } = {}) {
  await withTransaction(async (client) => {
    // Two server instances starting at the same time wait for each other here
    await client.query('SELECT pg_advisory_xact_lock(7243001)')
    for (const t of Object.values(TABLES)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${t.sql} (
          owner      TEXT NOT NULL,
          key        TEXT NOT NULL,
          data       JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (owner, key)
        )`)
      if (t.autoId) await client.query(`CREATE SEQUENCE IF NOT EXISTS ${t.sql}_id_seq`)
      await addOwnerColumn(client, t, migrateOwner)
    }
  })
}

// The first version of this server had a single user: its tables have no "owner" column.
// This adds it and gives every existing row to migrateOwner. Without migrateOwner the server
// refuses to start instead of guessing whose data it is. Runs once: afterwards the column exists.
async function addOwnerColumn(client, t, migrateOwner) {
  const { rows: hasOwner } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'owner'`, [t.sql])
  if (hasOwner.length) return

  const { rows: [{ count }] } = await client.query(`SELECT count(*)::int AS count FROM ${t.sql}`)
  if (count > 0 && !migrateOwner) {
    throw new Error(`Table ${t.sql} has ${count} rows from the single-user version. ` +
      'Set GYM_MIGRATE_OWNER to the Authelia username this data belongs to, and start again.')
  }
  await client.query(`ALTER TABLE ${t.sql} ADD COLUMN owner TEXT`)
  await client.query(`UPDATE ${t.sql} SET owner = $1`, [migrateOwner ?? ''])
  await client.query(`ALTER TABLE ${t.sql} ALTER COLUMN owner SET NOT NULL`)
  await client.query(`ALTER TABLE ${t.sql} DROP CONSTRAINT ${t.sql}_pkey`)
  await client.query(`ALTER TABLE ${t.sql} ADD PRIMARY KEY (owner, key)`)
  if (count > 0) console.log(`Migrated ${count} rows of ${t.sql} to user "${migrateOwner}"`)
}
