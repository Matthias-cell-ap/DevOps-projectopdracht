import express from 'express'
import { pool, withTransaction } from './db.js'
import { TABLES, HttpError, getTable, isValidUserName } from './tables.js'
import { getAll, getOne, isEmpty, upsertRows, deleteKeys, deleteAll } from './store.js'

// Who is asking? The reverse proxy answers that: after Authelia approved the login, Traefik
// sets the header "Remote-User" to the username (authResponseHeaders on the middleware).
// Traefik REPLACES a Remote-User header that the browser sent itself, so nobody can pretend
// to be someone else — as long as this server can only be reached through the proxy.
// So: never publish this server's port, and keep it on a network only the gym frontend shares.
//
// defaultUser (GYM_DEFAULT_USER): used when the header is missing. Only for running the app
// on your own machine without Authelia; never set it on the server.

export function createApp({ defaultUser } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '25mb' }))   // a full backup is one request
  app.use(logRequests)

  const api = express.Router()

  // For Gatus and Docker healthchecks: 200 only when the database answers too.
  // The only route that doesn't need a user.
  api.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1')
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'error', error: 'Database unreachable' })
    }
  })

  // Every other route works on the data of the logged-in user (req.user)
  api.use((req, res, next) => {
    const user = req.get('Remote-User') ?? defaultUser
    if (!user) throw new HttpError(401, 'Not logged in')
    if (!isValidUserName(user)) throw new HttpError(400, 'Invalid user name')
    req.user = user
    next()
  })

  // Which of this user's tables are still empty (a new user): the app then sends its defaults
  api.get('/status', async (req, res) => {
    const emptyTables = []
    for (const [name, table] of Object.entries(TABLES)) {
      if (await isEmpty(pool, table, req.user)) emptyTables.push(name)
    }
    res.json({ emptyTables })
  })

  // Fill this user's empty tables with the app's defaults (exercise library, weekly schedule,
  // profile). A table that already has rows is left alone, so calling this twice changes nothing.
  api.post('/init', async (req, res) => {
    const defaults = req.body?.defaults
    if (!defaults || typeof defaults !== 'object') throw new HttpError(400, 'Expected { defaults }')
    const seeded = await withTransaction(async (client) => {
      // Two tabs of the same user at once: one waits for the other
      await client.query('SELECT pg_advisory_xact_lock(7243002, hashtext($1))', [req.user])
      const done = []
      for (const [name, rows] of Object.entries(defaults)) {
        const table = getTable(name)
        if (await isEmpty(client, table, req.user)) {
          await upsertRows(client, table, req.user, rows)
          done.push(name)
        }
      }
      return done
    })
    res.json({ seeded })
  })

  api.get('/data/:table', async (req, res) => {
    res.json({ rows: await getAll(pool, getTable(req.params.table), req.user) })
  })

  api.get('/data/:table/:key', async (req, res) => {
    res.json({ row: await getOne(pool, getTable(req.params.table), req.user, req.params.key) })
  })

  // Body: { rows: [...] } — inserts new rows, replaces existing ones
  api.put('/data/:table', async (req, res) => {
    const table = getTable(req.params.table)
    const keys = await withTransaction(client => upsertRows(client, table, req.user, req.body?.rows))
    res.json({ keys })
  })

  // Body: { keys: [...] }
  api.post('/data/:table/delete', async (req, res) => {
    const table = getTable(req.params.table)
    res.json({ deleted: await deleteKeys(pool, table, req.user, req.body?.keys) })
  })

  // Restore a backup into this user's data. Body: { tables: { name: [rows] } }. Every table in
  // the body is replaced; tables that aren't in it are kept. Other users are never touched.
  // All in one transaction: a broken backup changes nothing.
  api.put('/import', async (req, res) => {
    const tables = req.body?.tables
    if (!tables || typeof tables !== 'object') throw new HttpError(400, 'Expected { tables }')
    const entries = Object.entries(tables).map(([name, rows]) => [getTable(name), rows])
    await withTransaction(async (client) => {
      for (const [table, rows] of entries) {
        await deleteAll(client, table, req.user)
        await upsertRows(client, table, req.user, rows)
      }
    })
    res.json({ ok: true })
  })

  app.use('/api', api)
  app.use((req, res) => res.status(404).json({ error: 'Not found' }))
  app.use(handleErrors)
  return app
}

function logRequests(req, res, next) {
  if (req.path === '/api/health') return next()   // checked every few seconds: too noisy
  const start = Date.now()
  res.on('finish', () => console.log(
    `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms user=${req.user ?? '-'}`))
  next()
}

// Express 5 sends errors from async routes here automatically
// eslint-disable-next-line no-unused-vars
function handleErrors(err, req, res, next) {
  // Our own errors and Express' (bad JSON, body too large) carry a 4xx status: tell the client
  const status = err.status ?? err.statusCode
  if (status >= 400 && status < 500) return res.status(status).json({ error: err.message })
  // Anything else is a bug or a database problem: log it, but don't show internals
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
}
