import { HttpError } from './tables.js'

// Reading and writing rows. Every function takes a database client and a table description
// from tables.js. upsertRows must run inside a transaction (see withTransaction in db.js).

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isValidKey = (k) => (typeof k === 'string' && k !== '') || (typeof k === 'number' && Number.isFinite(k))
const isValidId = (id) => Number.isSafeInteger(id) && id > 0

export async function getAll(db, table) {
  const order = table.autoId ? 'key::bigint' : 'key'
  const { rows } = await db.query(`SELECT data FROM ${table.sql} ORDER BY ${order}`)
  return rows.map(r => r.data)
}

export async function getOne(db, table, key) {
  const { rows } = await db.query(`SELECT data FROM ${table.sql} WHERE key = $1`, [String(key)])
  return rows[0]?.data ?? null
}

export async function isEmpty(db, table) {
  const { rows } = await db.query(`SELECT NOT EXISTS (SELECT 1 FROM ${table.sql}) AS empty`)
  return rows[0].empty
}

// Insert or replace rows ("put"). Returns each row's key, in the same order as the input.
// Rows of an autoId table without an id get the next free one, like Dexie does.
export async function upsertRows(db, table, input) {
  if (!Array.isArray(input) || !input.every(isPlainObject)) {
    throw new HttpError(400, 'Expected a list of objects')
  }
  const rows = input.map(r => ({ ...r }))   // don't change the caller's objects

  if (!table.autoId) {
    for (const row of rows) {
      if (!isValidKey(row[table.key])) throw new HttpError(400, `Every row needs a "${table.key}"`)
    }
    await insert(db, table, rows)
    return rows.map(r => r[table.key])
  }

  for (const row of rows) {
    const hasId = row.id !== undefined && row.id !== null
    if (hasId && !isValidId(row.id)) throw new HttpError(400, '"id" must be a positive whole number')
  }

  // Hand out ids in row order, exactly like IndexedDB's key generator: a row without id gets
  // the counter's value; a row with an id higher than the counter moves the counter past it.
  // The counter only goes up, so an id that was used once (and deleted) is never reused.
  // The lock makes a second request for this table wait until this transaction is done,
  // so two requests can never hand out the same id.
  const seq = `${table.sql}_id_seq`
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table.sql])
  const { rows: [counter] } = await db.query(`
    SELECT GREATEST(
      (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM ${seq}),
      (SELECT COALESCE(MAX(key::bigint), 0) + 1 FROM ${table.sql})
    ) AS next`)
  let next = Number(counter.next)
  for (const row of rows) {
    if (row.id === undefined || row.id === null) row.id = next++
    else next = Math.max(next, row.id + 1)
  }
  await insert(db, table, rows)
  await db.query(`SELECT setval('${seq}', $1, false)`, [next])
  return rows.map(r => r.id)
}

export async function deleteKeys(db, table, keys) {
  if (!Array.isArray(keys) || !keys.every(isValidKey)) throw new HttpError(400, 'Expected a list of keys')
  if (!keys.length) return 0
  const { rowCount } = await db.query(
    `DELETE FROM ${table.sql} WHERE key = ANY($1::text[])`, [keys.map(String)])
  return rowCount
}

export async function deleteAll(db, table) {
  await db.query(`DELETE FROM ${table.sql}`)
}

// One INSERT for all rows. If a key already exists, its row is replaced.
async function insert(db, table, rows) {
  if (!rows.length) return
  // The same key twice in one statement is an error in Postgres; like Dexie, the last one wins
  const byKey = new Map()
  for (const row of rows) byKey.set(String(row[table.key]), row)
  await db.query(
    `INSERT INTO ${table.sql} (key, data)
     SELECT u.key, u.data::jsonb FROM unnest($1::text[], $2::text[]) AS u(key, data)
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [[...byKey.keys()], [...byKey.values()].map(r => JSON.stringify(r))])
}
