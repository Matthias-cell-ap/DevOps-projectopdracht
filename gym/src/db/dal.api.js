// Server version of dal.js: the same functions with the same results, but the data lives in
// the gym server's PostgreSQL database instead of IndexedDB on the device.
//
// Which one the app uses is decided at build time (see vite.config.js):
//   npm run build          → dal.js      (Android app, data stays on the phone)
//   npm run build:server   → this file   (self-hosted web version, data on the server)
// The pages don't know the difference: they keep importing '../db/dal.js'.
//
// When you add or change a function in dal.js, do the same here. A function that's missing
// here makes `npm run build:server` fail, so you'll notice.
//
// Requests go to /api on the same address the app is served from. The login is checked by
// the reverse proxy before a request gets there, so there's no login code in here. The proxy
// also tells the server who is logged in, and the server keeps each user's data separate:
// every Authelia user gets their own gym app.
import { SEED_EXERCISES } from './seedExercises.js'
import { SCHEMA_VERSION, defaultSchedule, defaultProfile } from './defaults.js'

// Every write stamps updatedAt (same as dal.js)
const stamp = (row) => ({ ...row, updatedAt: new Date().toISOString() })

// ── Talking to the server ─────────────────────────────────
async function call(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body === undefined
      ? { Accept: 'application/json' }
      : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) {
    // The login expired, or the request reached the server without a user: reload, so the
    // browser goes through the login page and comes back. At most once per 30 seconds — if
    // the server keeps saying 401 after that (a proxy misconfiguration), reloading again
    // would only loop forever.
    reloadForLogin()
    throw new Error('Not logged in')
  }
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error(`Unexpected answer from the server (HTTP ${res.status})`)
  }
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `Server error (HTTP ${res.status})`)
  return json
}

function reloadForLogin() {
  if (typeof window === 'undefined') return
  try {
    const last = Number(window.sessionStorage.getItem('gym-login-reload') ?? 0)
    if (Date.now() - last < 30_000) return
    window.sessionStorage.setItem('gym-login-reload', String(Date.now()))
  } catch { /* storage unavailable: still reload once */ }
  window.location.reload()
}

// A new user starts with nothing: fill their data with the same defaults a fresh phone
// install gets.
// Runs once per page load, before the first request. The server only fills tables that are
// still empty, so two tabs doing this at the same time is fine.
let ready = null
function ensureReady() {
  ready ??= (async () => {
    const { emptyTables } = await call('GET', '/status')
    const defaults = {}
    if (emptyTables.includes('schedule')) defaults.schedule = defaultSchedule()
    if (emptyTables.includes('exercises')) defaults.exercises = SEED_EXERCISES.map(e => ({ ...e }))
    if (emptyTables.includes('profile')) defaults.profile = [defaultProfile()]
    if (Object.keys(defaults).length) await call('POST', '/init', { defaults })
  })().catch(err => { ready = null; throw err })   // failed (server down?): try again next time
  return ready
}

async function request(method, path, body) {
  await ensureReady()
  return call(method, path, body)
}

const all = async (table) => sortByPrimaryKey(table, (await request('GET', `/data/${table}`)).rows)
const one = async (table, key) =>
  (await request('GET', `/data/${table}/${encodeURIComponent(key)}`)).row ?? undefined
const put = async (table, rows) => (await request('PUT', `/data/${table}`, { rows })).keys
const remove = (table, keys) => request('POST', `/data/${table}/delete`, { keys })

// ── Sorting like IndexedDB ────────────────────────────────
// IndexedDB sorts numbers before strings, and leaves rows without a valid value out of
// orderBy(). These helpers do the same, so lists come out in exactly the same order.
const PRIMARY_KEYS = {
  dailyLogs: 'date', exercises: 'id', exerciseGoals: 'exerciseId', sessions: 'id',
  personalRecords: 'exerciseId', schedule: 'day', research: 'id', profile: 'id',
  aiMemory: 'id', sessionTypes: 'id',
}
const keyRank = (v) => typeof v === 'number' ? (Number.isNaN(v) ? 0 : 1) : typeof v === 'string' ? 2 : 0
const compareKeys = (a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0)
const sortBy = (rows, field) => [...rows].sort((a, b) => compareKeys(a[field], b[field]))
const orderBy = (rows, field) => sortBy(rows.filter(r => keyRank(r[field]) > 0), field)
const sortByPrimaryKey = (table, rows) => sortBy(rows, PRIMARY_KEYS[table])
const sameKey = (a, b) => keyRank(a) > 0 && compareKeys(a, b) === 0

// ── Daily Log ──────────────────────────────────────────────
export const saveLog = async (log) => (await put('dailyLogs', [stamp(log)]))[0]

// New entries merge into the day: filled fields update it, missing ones keep what was there.
// The day keeps its original goal snapshot so its colours don't change after the fact.
export const mergeLog = async (entry) => {
  const existing = await one('dailyLogs', entry.date)
  if (!existing) return saveLog(entry)
  return saveLog({ ...existing, ...entry, goalsSnapshot: existing.goalsSnapshot ?? entry.goalsSnapshot })
}
export const getLog = (date) => one('dailyLogs', date)
export const getLogs = async (from, to) =>
  orderBy(await all('dailyLogs'), 'date')
    .filter(l => compareKeys(l.date, from) >= 0 && compareKeys(l.date, to) <= 0)
export const getAllLogs = async () => orderBy(await all('dailyLogs'), 'date')

// Most recent log that actually has a finite weight (newest-first)
export const getLatestWeighedLog = async () => {
  const all = (await getAllLogs()).reverse()
  return all.find(l => Number.isFinite(l.weight)) ?? null
}

// ── Exercises (global library) ─────────────────────────────
export const getAllExercises = async () => orderBy(await all('exercises'), 'name')
export const saveExercise = async (ex) => (await put('exercises', [stamp(ex)]))[0]   // returns the id

// ── Session types (user-created workout days) ──────────────
export const getSessionTypes = () => all('sessionTypes')
export const saveSessionType = async (st) => (await put('sessionTypes', [stamp(st)]))[0]
export const deleteSessionType = async (id) => { await remove('sessionTypes', [id]) }

// ── Goals ──────────────────────────────────────────────────
export const getGoal = (exerciseId) => one('exerciseGoals', exerciseId)
export const saveGoal = async (goal) => (await put('exerciseGoals', [stamp(goal)]))[0]
export const getAllGoals = () => all('exerciseGoals')

// ── Sessions ──────────────────────────────────────────────
export const saveSessions = async (sessions) => (await put('sessions', sessions.map(stamp))).at(-1)
export const getSessionsForExercise = async (exerciseId) =>
  sortBy((await all('sessions')).filter(s => sameKey(s.exerciseId, exerciseId)), 'date')
export const getAllSessions = async () => orderBy(await all('sessions'), 'date')

export const getSessionsOnDate = async (date) => (await all('sessions')).filter(s => sameKey(s.date, date))

// Delete specific logged sets (one "Save session" press = one batch).
// Returns the affected exerciseIds so their PRs can be recomputed.
export const deleteSessionsByIds = async (ids) => {
  const byId = new Map((await all('sessions')).map(s => [s.id, s]))
  const sessions = ids.map(id => byId.get(id))
  const exerciseIds = [...new Set(sessions.filter(Boolean).map(s => s.exerciseId))]
  await remove('sessions', ids)
  return exerciseIds
}

// ── PRs ────────────────────────────────────────────────────
export const getPR = (exerciseId) => one('personalRecords', exerciseId)
export const savePR = async (pr) => (await put('personalRecords', [stamp(pr)]))[0]
export const getAllPRs = () => all('personalRecords')

// The best set (8RM score) of a list of sessions, or null when there are none
function bestSession(sessions, estimate8RM) {
  let best = null, bestScore = -1
  for (const s of sessions) {
    const score = estimate8RM(s.weight, s.reps)
    if (score > bestScore) { bestScore = score; best = s }
  }
  return best
}

// Recompute the PR for one exercise from its full session history, using 8RM scoring.
export const recomputePR = async (exerciseId, estimate8RM) => {
  const sessions = (await all('sessions')).filter(s => sameKey(s.exerciseId, exerciseId))
  const best = bestSession(sessions, estimate8RM)
  if (best) {
    await put('personalRecords', [stamp({ exerciseId, date: best.date, weight: best.weight, reps: best.reps })])
  } else {
    await remove('personalRecords', [exerciseId])
  }
}

// Recompute every exercise's PR (used once to migrate old raw-weight PRs to 8RM).
// Same result as recomputePR for each exercise, but in 3 reads and 2 writes instead of
// a few hundred requests.
export const recomputeAllPRs = async (estimate8RM) => {
  const [exercises, sessions, prs] = await Promise.all([all('exercises'), all('sessions'), all('personalRecords')])
  const toSave = [], toDelete = []
  for (const ex of exercises) {
    const best = bestSession(sessions.filter(s => sameKey(s.exerciseId, ex.id)), estimate8RM)
    if (best) toSave.push(stamp({ exerciseId: ex.id, date: best.date, weight: best.weight, reps: best.reps }))
    else if (prs.some(pr => sameKey(pr.exerciseId, ex.id))) toDelete.push(ex.id)
  }
  if (toSave.length) await put('personalRecords', toSave)
  if (toDelete.length) await remove('personalRecords', toDelete)
}

// ── Schedule ──────────────────────────────────────────────
export const getSchedule = async () => orderBy(await all('schedule'), 'day')
export const saveScheduleDay = async (day) => (await put('schedule', [stamp(day)]))[0]

// ── Research ──────────────────────────────────────────────
export const getResearch = async () => orderBy(await all('research'), 'order')
export const saveResearch = async (item) => (await put('research', [stamp(item)]))[0]
export const deleteResearch = async (id) => { await remove('research', [id]) }

// ── Profile ───────────────────────────────────────────────
export const getProfile = () => one('profile', 1)
export const saveProfile = async (data) => (await put('profile', [stamp({ ...data, id: 1 })]))[0]

// ── AI Memory ─────────────────────────────────────────────
// The in-app AI was removed; the table stays so older backups keep round-tripping intact.
const getAIMemories = async () => orderBy(await all('aiMemory'), 'date')

// ── Backup / Restore ──────────────────────────────────────
// Same file format as the phone app (docs/DATA_FORMAT.md), so a backup exported on the
// phone can be restored here and the other way around.
const BACKUP_TABLES = ['dailyLogs', 'exercises', 'exerciseGoals', 'sessions', 'personalRecords', 'schedule', 'research', 'aiMemory', 'sessionTypes']

export const exportAll = async () => ({
  meta: { format: 'gym-app-backup', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() },
  dailyLogs: await getAllLogs(),
  exercises: await getAllExercises(),
  exerciseGoals: await getAllGoals(),
  sessions: await getAllSessions(),
  personalRecords: await getAllPRs(),
  schedule: await getSchedule(),
  research: await getResearch(),
  profile: await getProfile(),
  aiMemory: await getAIMemories(),
  sessionTypes: await getSessionTypes(),
})

export const importAll = async (data) => {
  // Refuse anything that isn't a backup, instead of "restoring" nothing
  const looksLikeBackup = data && typeof data === 'object' &&
    (BACKUP_TABLES.some(t => Array.isArray(data[t])) || (data.profile && typeof data.profile === 'object'))
  if (!looksLikeBackup) throw new Error('This file is not a Gym App backup.')
  if (data.meta?.schemaVersion > SCHEMA_VERSION) throw new Error('This backup comes from a newer version of the app — update the app first.')

  // A restore REPLACES each table that's in the file; tables it lacks are kept (older backups).
  // Work out the final contents here, then the server swaps them in, in one transaction.
  const tables = {}
  for (const t of BACKUP_TABLES) if (Array.isArray(data[t])) tables[t] = data[t]
  if (data.profile) tables.profile = [{ ...data.profile, id: 1 }]

  // Library exercises added in app versions newer than the backup
  const exercises = tables.exercises ?? await all('exercises')
  const have = new Set(exercises.flatMap(e => [e.name, e.seedName].filter(Boolean).map(n => n.toLowerCase())))
  const missing = SEED_EXERCISES.filter(e => !have.has(e.name.toLowerCase()))
  if (missing.length) tables.exercises = [...exercises, ...missing.map(e => ({ ...e }))]

  // The weekly schedule always has 7 days
  if ((tables.schedule ?? await all('schedule')).length === 0) tables.schedule = defaultSchedule()

  await request('PUT', '/import', { tables })
}
