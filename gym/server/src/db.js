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
// Each app table becomes one SQL table: the primary key, the row itself as JSONB, and when it
// last changed. The app's rows evolve with the app (new fields, schema versions); JSONB stores
// them as they are, so the server doesn't need a migration for every new field.
export async function migrate() {
  await withTransaction(async (client) => {
    // Two server instances starting at the same time wait for each other here
    await client.query('SELECT pg_advisory_xact_lock(7243001)')
    for (const t of Object.values(TABLES)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${t.sql} (
          key        TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
      if (t.autoId) await client.query(`CREATE SEQUENCE IF NOT EXISTS ${t.sql}_id_seq`)
    }
  })
}
