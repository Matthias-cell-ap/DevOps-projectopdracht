import express from 'express'
import { pool, withTransaction } from './db.js'
import { TABLES, HttpError, getTable } from './tables.js'
import { getAll, getOne, isEmpty, upsertRows, deleteKeys, deleteAll } from './store.js'

// There is no login code here on purpose: the reverse proxy checks the login (forward auth)
// before a request ever reaches this server. That only holds if the server is NOT reachable
// any other way — so never publish its port; only the proxy may talk to it.

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '25mb' }))   // a full backup is one request
  app.use(logRequests)

  const api = express.Router()

  // For Gatus and Docker healthchecks: 200 only when the database answers too
  api.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1')
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'error', error: 'Database unreachable' })
    }
  })

  // Which tables are still empty (a fresh database): the app then sends its default data
  api.get('/status', async (req, res) => {
    const emptyTables = []
    for (const [name, table] of Object.entries(TABLES)) {
      if (await isEmpty(pool, table)) emptyTables.push(name)
    }
    res.json({ emptyTables })
  })

  // Fill empty tables with the app's defaults (exercise library, weekly schedule, profile).
  // A table that already has rows is left alone, so calling this twice changes nothing.
  api.post('/init', async (req, res) => {
    const defaults = req.body?.defaults
    if (!defaults || typeof defaults !== 'object') throw new HttpError(400, 'Expected { defaults }')
    const seeded = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(7243002)')   // two tabs at once: one waits
      const done = []
      for (const [name, rows] of Object.entries(defaults)) {
        const table = getTable(name)
        if (await isEmpty(client, table)) {
          await upsertRows(client, table, rows)
          done.push(name)
        }
      }
      return done
    })
    res.json({ seeded })
  })

  api.get('/data/:table', async (req, res) => {
    res.json({ rows: await getAll(pool, getTable(req.params.table)) })
  })

  api.get('/data/:table/:key', async (req, res) => {
    res.json({ row: await getOne(pool, getTable(req.params.table), req.params.key) })
  })

  // Body: { rows: [...] } — inserts new rows, replaces existing ones
  api.put('/data/:table', async (req, res) => {
    const table = getTable(req.params.table)
    const keys = await withTransaction(client => upsertRows(client, table, req.body?.rows))
    res.json({ keys })
  })

  // Body: { keys: [...] }
  api.post('/data/:table/delete', async (req, res) => {
    const table = getTable(req.params.table)
    res.json({ deleted: await deleteKeys(pool, table, req.body?.keys) })
  })

  // Restore a backup. Body: { tables: { name: [rows] } }. Every table in the body is replaced;
  // tables that aren't in it are kept. All in one transaction: a broken backup changes nothing.
  api.put('/import', async (req, res) => {
    const tables = req.body?.tables
    if (!tables || typeof tables !== 'object') throw new HttpError(400, 'Expected { tables }')
    const entries = Object.entries(tables).map(([name, rows]) => [getTable(name), rows])
    await withTransaction(async (client) => {
      for (const [table, rows] of entries) {
        await deleteAll(client, table)
        await upsertRows(client, table, rows)
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
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`))
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
