// Checks the multi-user part of the gym server:
// - every user only ever sees and changes their own data
// - a request without a (valid) logged-in user is refused
// - the data of the old single-user version is migrated to one user, exactly once
//
// Needs a Postgres database that may be WIPED, like dal-parity.test.js:
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gym_test npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const DB_URL = process.env.TEST_DATABASE_URL
// In een pipeline (GitHub zet CI=true) mag deze test nooit stil overgeslagen worden
if (!DB_URL && process.env.CI) throw new Error('TEST_DATABASE_URL is not set: the multi-user test cannot run')
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run this test'

let server, base, pool, serverDb, TABLES

async function resetDatabase() {
  for (const t of Object.values(TABLES)) {
    await pool.query(`DROP TABLE IF EXISTS ${t.sql}`)
    await pool.query(`DROP SEQUENCE IF EXISTS ${t.sql}_id_seq`)
  }
}

before(async () => {
  if (skip) return
  process.env.DATABASE_URL = DB_URL   // read by server/src/db.js when it's imported
  serverDb = await import('../server/src/db.js')
  ;({ TABLES } = await import('../server/src/tables.js'))
  const { createApp } = await import('../server/src/app.js')
  pool = serverDb.pool
  await resetDatabase()
  await serverDb.migrate()
  server = createApp().listen(0)   // no default user: like on the server
  base = `http://localhost:${server.address().port}/api`
})

after(async () => {
  server?.close()
  await pool?.end()
})

// A request as a given user, the way Traefik delivers it after the Authelia login
const as = (user) => async (method, path, body) => {
  const headers = { Accept: 'application/json' }
  if (user !== null) headers['Remote-User'] = user
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const alice = as('alice')
const bob = as('bob')

test('every user only sees their own data', { skip }, async () => {
  await alice('PUT', '/data/dailyLogs', { rows: [{ date: '2026-11-20', weight: 70 }] })
  await bob('PUT', '/data/dailyLogs', { rows: [{ date: '2026-11-20', weight: 90 }] })   // same day, other user

  assert.deepEqual((await alice('GET', '/data/dailyLogs')).body.rows, [{ date: '2026-11-20', weight: 70 }])
  assert.deepEqual((await bob('GET', '/data/dailyLogs/2026-11-20')).body.row, { date: '2026-11-20', weight: 90 })
  assert.deepEqual((await as('carol')('GET', '/data/dailyLogs')).body.rows, [])
})

test('a user cannot change or delete rows of another user', { skip }, async () => {
  const { body: { keys: [aliceId] } } = await alice('PUT', '/data/exercises', { rows: [{ name: 'Alice press' }] })

  // Bob deletes "that id": nothing of Alice's disappears
  assert.equal((await bob('POST', '/data/exercises/delete', { keys: [aliceId] })).body.deleted, 0)
  // Bob writes a row with Alice's id: it becomes a row of Bob's own
  await bob('PUT', '/data/exercises', { rows: [{ id: aliceId, name: 'Bob row' }] })
  assert.deepEqual((await alice('GET', `/data/exercises/${aliceId}`)).body.row, { id: aliceId, name: 'Alice press' })

  // Bob restores an (empty) backup: only Bob's exercises are replaced
  await bob('PUT', '/import', { tables: { exercises: [] } })
  assert.equal((await bob('GET', '/data/exercises')).body.rows.length, 0)
  assert.equal((await alice('GET', '/data/exercises')).body.rows.length, 1)
})

test('every new user starts with their own defaults', { skip }, async () => {
  const dave = as('dave')
  assert.ok((await dave('GET', '/status')).body.emptyTables.includes('schedule'))

  const schedule = [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, type: 'rest', label: 'Rest', sessionTypeId: null }))
  assert.deepEqual((await dave('POST', '/init', { defaults: { schedule } })).body.seeded, ['schedule'])
  assert.deepEqual((await dave('POST', '/init', { defaults: { schedule } })).body.seeded, [])   // second time: nothing

  assert.equal((await dave('GET', '/data/schedule')).body.rows.length, 7)
  assert.equal((await alice('GET', '/data/schedule')).body.rows.length, 0)   // Alice is untouched
})

test('requests without a valid user are refused', { skip }, async () => {
  assert.equal((await as(null)('GET', '/status')).status, 401)
  assert.equal((await as(null)('GET', '/data/dailyLogs')).status, 401)
  assert.equal((await as('not a name!')('GET', '/status')).status, 400)
  assert.equal((await as('x'.repeat(101))('GET', '/status')).status, 400)
  assert.equal((await as(null)('GET', '/health')).status, 200)   // the health check needs no user
})

test('data of the single-user version is migrated to one user, once', { skip }, async () => {
  // Rebuild the database as the first version of the server left it: no owner column
  await resetDatabase()
  for (const t of Object.values(TABLES)) {
    await pool.query(`CREATE TABLE ${t.sql} (key TEXT PRIMARY KEY, data JSONB NOT NULL,
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    if (t.autoId) await pool.query(`CREATE SEQUENCE ${t.sql}_id_seq`)
  }
  await pool.query(`INSERT INTO daily_logs (key, data) VALUES ('2026-01-01', '{"date":"2026-01-01","weight":80}')`)
  await pool.query(`INSERT INTO exercises (key, data) VALUES ('1', '{"id":1,"name":"Bench"}')`)

  // Without saying whose data it is, the server refuses to start
  await assert.rejects(serverDb.migrate(), /GYM_MIGRATE_OWNER/)

  await serverDb.migrate({ migrateOwner: 'matthias' })
  const { rows } = await pool.query('SELECT owner, key FROM daily_logs')
  assert.deepEqual(rows, [{ owner: 'matthias', key: '2026-01-01' }])

  const { rows: pk } = await pool.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'daily_logs'::regclass AND i.indisprimary ORDER BY a.attname`)
  assert.deepEqual(pk.map(r => r.attname), ['key', 'owner'])

  // Running it again (every start of the server) changes nothing
  await serverDb.migrate({ migrateOwner: 'matthias' })
  await serverDb.migrate()

  const matthias = as('matthias')
  assert.deepEqual((await matthias('GET', '/data/dailyLogs')).body.rows, [{ date: '2026-01-01', weight: 80 }])
  assert.deepEqual((await alice('GET', '/data/dailyLogs')).body.rows, [])
  // A new exercise for matthias continues after his existing id 1
  assert.deepEqual((await matthias('PUT', '/data/exercises', { rows: [{ name: 'Squat' }] })).body.keys, [2])
})
