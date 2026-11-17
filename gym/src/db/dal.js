import { db } from './db.js'
import { SEED_EXERCISES } from './seedExercises.js'

// Every write stamps updatedAt, so a future sync to a server can ask "what changed since …".
// (Restoring a backup keeps the stamps that are in the file.)
const stamp = (row) => ({ ...row, updatedAt: new Date().toISOString() })

// ── Daily Log ──────────────────────────────────────────────
export const saveLog = (log) => db.dailyLogs.put(stamp(log))   // full replace (used by "Edit this entry")

// New entries merge into the day: filled fields update it, missing ones keep what was there.
// The day keeps its original goal snapshot so its colours don't change after the fact.
export const mergeLog = async (entry) => {
  const existing = await db.dailyLogs.get(entry.date)
  if (!existing) return db.dailyLogs.put(stamp(entry))
  return db.dailyLogs.put(stamp({ ...existing, ...entry, goalsSnapshot: existing.goalsSnapshot ?? entry.goalsSnapshot }))
}
export const getLog = (date) => db.dailyLogs.get(date)
export const getLogs = (from, to) =>
  db.dailyLogs.where('date').between(from, to, true, true).sortBy('date')
export const getAllLogs = () => db.dailyLogs.orderBy('date').toArray()

// Most recent log that actually has a finite weight (newest-first)
export const getLatestWeighedLog = async () => {
  const all = await db.dailyLogs.orderBy('date').reverse().toArray()
  return all.find(l => Number.isFinite(l.weight)) ?? null
}

// ── Exercises (global library) ─────────────────────────────
export const getAllExercises = () => db.exercises.orderBy('name').toArray()
export const saveExercise = (ex) => db.exercises.put(stamp(ex))   // returns the id

// ── Session types (user-created workout days) ──────────────
export const getSessionTypes = () => db.sessionTypes.toArray()
export const saveSessionType = (st) => db.sessionTypes.put(stamp(st))
export const deleteSessionType = (id) => db.sessionTypes.delete(id)

// ── Goals ──────────────────────────────────────────────────
export const getGoal = (exerciseId) => db.exerciseGoals.get(exerciseId)
export const saveGoal = (goal) => db.exerciseGoals.put(stamp(goal))
export const getAllGoals = () => db.exerciseGoals.toArray()

// ── Sessions ──────────────────────────────────────────────
export const saveSessions = (sessions) => db.sessions.bulkPut(sessions.map(stamp))
export const getSessionsForExercise = (exerciseId) =>
  db.sessions.where('exerciseId').equals(exerciseId).sortBy('date')
export const getAllSessions = () => db.sessions.orderBy('date').toArray()

export const getSessionsOnDate = (date) => db.sessions.where('date').equals(date).toArray()

// Delete specific logged sets (one "Save session" press = one batch).
// Returns the affected exerciseIds so their PRs can be recomputed.
export const deleteSessionsByIds = async (ids) => {
  const sessions = await db.sessions.bulkGet(ids)
  const exerciseIds = [...new Set(sessions.filter(Boolean).map(s => s.exerciseId))]
  await db.sessions.bulkDelete(ids)
  return exerciseIds
}

// ── PRs ────────────────────────────────────────────────────
export const getPR = (exerciseId) => db.personalRecords.get(exerciseId)
export const savePR = (pr) => db.personalRecords.put(stamp(pr))
export const getAllPRs = () => db.personalRecords.toArray()

// Recompute the PR for one exercise from its full session history, using 8RM scoring.
export const recomputePR = async (exerciseId, estimate8RM) => {
  const sessions = await db.sessions.where('exerciseId').equals(exerciseId).toArray()
  let best = null, bestScore = -1
  for (const s of sessions) {
    const score = estimate8RM(s.weight, s.reps)
    if (score > bestScore) { bestScore = score; best = s }
  }
  if (best) {
    await db.personalRecords.put(stamp({ exerciseId, date: best.date, weight: best.weight, reps: best.reps }))
  } else {
    await db.personalRecords.delete(exerciseId)
  }
}

// Recompute every exercise's PR (used once to migrate old raw-weight PRs to 8RM).
export const recomputeAllPRs = async (estimate8RM) => {
  const exercises = await db.exercises.toArray()
  for (const ex of exercises) await recomputePR(ex.id, estimate8RM)
}

// ── Schedule ──────────────────────────────────────────────
export const getSchedule = () => db.schedule.orderBy('day').toArray()
export const saveScheduleDay = (day) => db.schedule.put(stamp(day))

// ── Research ──────────────────────────────────────────────
export const getResearch = () => db.research.orderBy('order').toArray()
export const saveResearch = (item) => db.research.put(stamp(item))
export const deleteResearch = (id) => db.research.delete(id)

// ── Profile ───────────────────────────────────────────────
export const getProfile = () => db.profile.get(1)
export const saveProfile = (data) => db.profile.put(stamp({ ...data, id: 1 }))

// ── AI Memory ─────────────────────────────────────────────
// The in-app AI was removed; the table stays so older backups keep round-tripping intact.
const getAIMemories = () => db.aiMemory.orderBy('date').toArray()

// ── Backup / Restore ──────────────────────────────────────
// The backup file = every table as an array (+ the profile object). Format: docs/DATA_FORMAT.md
const BACKUP_TABLES = ['dailyLogs', 'exercises', 'exerciseGoals', 'sessions', 'personalRecords', 'schedule', 'research', 'aiMemory', 'sessionTypes']

export const exportAll = async () => ({
  meta: { format: 'gym-app-backup', schemaVersion: db.verno, exportedAt: new Date().toISOString() },
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
  if (data.meta?.schemaVersion > db.verno) throw new Error('This backup comes from a newer version of the app — update the app first.')
  await db.transaction('rw',
    db.dailyLogs, db.exercises, db.exerciseGoals,
    db.sessions, db.personalRecords, db.schedule,
    db.research, db.profile, db.aiMemory, db.sessionTypes,
    async () => {
      // A restore REPLACES what's in the app. Merging by ID would mix two data sets: IDs are
      // per-phone, so the same number can be a different exercise/set on another phone.
      for (const t of BACKUP_TABLES) {
        if (!Array.isArray(data[t])) continue   // older backups may lack a table — keep what's there
        await db[t].clear()
        if (data[t].length) await db[t].bulkPut(data[t])
      }
      if (data.profile) {
        await db.profile.clear()
        await db.profile.put({ ...data.profile, id: 1 })
      }

      // Library exercises added in app versions newer than the backup
      const have = new Set((await db.exercises.toArray()).flatMap(e => [e.name, e.seedName].filter(Boolean).map(n => n.toLowerCase())))
      const missing = SEED_EXERCISES.filter(e => !have.has(e.name.toLowerCase()))
      if (missing.length) await db.exercises.bulkAdd(missing.map(e => ({ ...e })))

      // The weekly schedule always has 7 days
      if (await db.schedule.count() === 0) {
        await db.schedule.bulkPut([0, 1, 2, 3, 4, 5, 6].map(day => ({ day, type: 'rest', label: 'Rest', sessionTypeId: null })))
      }
    }
  )
}
