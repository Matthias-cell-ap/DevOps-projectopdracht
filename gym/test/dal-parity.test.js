// Checks that the server version of the data layer (dal.api.js + the gym server + Postgres)
// gives exactly the same results as the phone version (dal.js + IndexedDB).
// The same list of actions runs against both; every result must be identical.
//
// Needs a Postgres database that may be WIPED — never point this at your real data:
//   npm ci --prefix server
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gym_test npm test
import 'fake-indexeddb/auto'   // IndexedDB for Node, so dal.js can run outside a browser
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const DB_URL = process.env.TEST_DATABASE_URL
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run this test'

let server, pool, local, remote, db, SCHEMA_VERSION, estimate8RM

before(async () => {
  if (skip) return
  process.env.DATABASE_URL = DB_URL   // read by server/src/db.js when it's imported
  const serverDb = await import('../server/src/db.js')
  const { TABLES } = await import('../server/src/tables.js')
  const { createApp } = await import('../server/src/app.js')
  pool = serverDb.pool

  // Start from an empty database
  for (const t of Object.values(TABLES)) {
    await pool.query(`DROP TABLE IF EXISTS ${t.sql}`)
    await pool.query(`DROP SEQUENCE IF EXISTS ${t.sql}_id_seq`)
  }
  await serverDb.migrate()
  server = createApp().listen(0)
  const base = `http://localhost:${server.address().port}`

  // dal.api.js calls fetch('/api/...') like a browser would; in Node it needs the full address
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, options) => realFetch(new URL(url, base), options)

  local = await import('../src/db/dal.js')
  remote = await import('../src/db/dal.api.js')
  ;({ db } = await import('../src/db/db.js'))
  ;({ SCHEMA_VERSION } = await import('../src/db/defaults.js'))
  ;({ estimate8RM } = await import('../src/lib/utils.js'))
})

after(async () => {
  server?.close()
  await pool?.end()
})

// Timestamps differ between the two runs; everything else must match
const normalize = (value) => JSON.parse(JSON.stringify(value ?? null, (k, v) =>
  k === 'updatedAt' || k === 'exportedAt' ? undefined : v))

// The scenario: what a user does in the app, plus the edge cases of every function.
// Returns [label, result] pairs.
async function scenario(dal) {
  const out = []
  const step = async (label, fn) => {
    try { out.push([label, normalize(await fn())]) } catch (err) { out.push([label, 'ERROR: ' + err.message]) }
  }

  // Fresh install
  await step('profile on a fresh install', () => dal.getProfile())
  await step('default schedule', () => dal.getSchedule())
  await step('exercise library', () => dal.getAllExercises())
  await step('no session types yet', () => dal.getSessionTypes())

  // Daily log
  await step('saveLog', () => dal.saveLog({ date: '2026-11-10', weight: 80.2, kcal: 2000 }))
  await step('mergeLog into existing day', () => dal.mergeLog({ date: '2026-11-10', protein: 150 }))
  await step('mergeLog new day', () => dal.mergeLog({ date: '2026-11-11', weight: 79.9, goalsSnapshot: { kcal: 2100 } }))
  await step('mergeLog keeps first goalsSnapshot', () => dal.mergeLog({ date: '2026-11-11', goalsSnapshot: { kcal: 9999 }, sleep: 7.5 }))
  await step('day without weight', () => dal.saveLog({ date: '2026-11-12', kcal: 1800 }))
  await step('day logged out of order', () => dal.saveLog({ date: '2026-11-01', weight: 81 }))
  await step('getLog', () => dal.getLog('2026-11-11'))
  await step('getLog missing day', () => dal.getLog('1999-01-01'))
  await step('getLogs range', () => dal.getLogs('2026-11-01', '2026-11-11'))
  await step('getAllLogs', () => dal.getAllLogs())
  await step('getLatestWeighedLog', () => dal.getLatestWeighedLog())

  // Exercises, session types, schedule
  let customId, pushId
  await step('saveExercise new', async () => (customId = await dal.saveExercise({ name: 'aaa lowercase custom', muscleGroup: 'Chest', custom: true })))
  await step('saveExercise edit', () => dal.saveExercise({ id: customId, name: 'Zzz Custom Press', muscleGroup: 'Chest', custom: true }))
  await step('exercises sorted by name', async () => (await dal.getAllExercises()).map(e => [e.id, e.name]))
  await step('saveSessionType', async () => (pushId = await dal.saveSessionType({ name: 'Push', exerciseIds: [1, 2, customId] })))
  await step('saveScheduleDay', () => dal.saveScheduleDay({ day: 1, type: 'workout', label: 'Push', sessionTypeId: pushId }))
  await step('schedule after edit', () => dal.getSchedule())

  // Sessions and PRs
  await step('saveSessions', () => dal.saveSessions([
    { exerciseId: 1, date: '2026-11-11', weight: 62.5, reps: 6 },
    { exerciseId: 1, date: '2026-11-10', weight: 60, reps: 8 },
    { exerciseId: customId, date: '2026-11-11', weight: 40, reps: 10 },
    { exerciseId: 2, date: '2026-11-11', weight: 100, reps: 3 },
  ]))
  await step('saveSessions empty', () => dal.saveSessions([]))
  await step('getSessionsForExercise', () => dal.getSessionsForExercise(1))
  await step('getSessionsOnDate', () => dal.getSessionsOnDate('2026-11-11'))
  await step('getAllSessions', () => dal.getAllSessions())
  await step('recomputePR', () => dal.recomputePR(1, estimate8RM))
  await step('recomputePR custom', () => dal.recomputePR(customId, estimate8RM))
  await step('getPR', () => dal.getPR(1))
  await step('getPR none', () => dal.getPR(3))
  await step('saveGoal', () => dal.saveGoal({ exerciseId: 1, targetWeight: 65, targetReps: 8 }))
  await step('saveGoal 2', () => dal.saveGoal({ exerciseId: 10, targetWeight: 20, targetReps: 12 }))
  await step('getGoal', () => dal.getGoal(1))
  await step('getAllGoals in key order', () => dal.getAllGoals())
  await step('deleteSessionsByIds', () => dal.deleteSessionsByIds([1, 4, 999]))
  await step('recomputePR after delete', () => dal.recomputePR(customId, estimate8RM))
  await step('PRs after delete', () => dal.getAllPRs())
  await step('new session id never reuses a deleted one', () => dal.saveSessions([{ exerciseId: 1, date: '2026-11-12', weight: 65, reps: 5 }]))
  await step('recomputeAllPRs', () => dal.recomputeAllPRs(estimate8RM))
  await step('PRs after recomputeAll', () => dal.getAllPRs())

  // Research
  let r1
  await step('saveResearch', async () => (r1 = await dal.saveResearch({ title: 'Creatine', status: 'todo', body: 'x', createdAt: '2026-11-01T10:00:00.000Z', order: 2 })))
  await step('saveResearch 2', () => dal.saveResearch({ title: 'Sleep', status: 'done', body: 'y', createdAt: '2026-11-02T10:00:00.000Z', order: 1 }))
  await step('saveResearch without order', () => dal.saveResearch({ title: 'No order field' }))
  await step('getResearch sorted, skips rows without order', () => dal.getResearch())
  await step('deleteResearch', () => dal.deleteResearch(r1))
  await step('research after delete', () => dal.getResearch())
  await step('deleteSessionType', () => dal.deleteSessionType(pushId))
  await step('session types after delete', () => dal.getSessionTypes())

  // Profile
  await step('saveProfile', async () => dal.saveProfile({ ...(await dal.getProfile()), height: '180', prRecomputedV2: true }))
  await step('profile after save', () => dal.getProfile())

  // Backup and restore
  let backup
  await step('exportAll', async () => (backup = await dal.exportAll()))
  await step('restore: not a backup', () => dal.importAll({ hello: 'world' }))
  await step('restore: newer schema', () => dal.importAll({ meta: { schemaVersion: 99 }, dailyLogs: [] }))
  await step('restore: row without key fails, nothing changes', async () => {
    const err = await dal.importAll({ dailyLogs: [{ weight: 1 }], research: [] }).then(() => 'no error', () => 'error')
    return [err, await dal.getResearch()]
  })
  await step('restore: full backup minus 3 library exercises, empty schedule', async () => {
    const trimmed = { ...backup, exercises: backup.exercises.filter(e => ![4, 5, 6].includes(e.id)), schedule: [] }
    await dal.importAll(trimmed)
    return dal.exportAll()
  })
  await step('restore: only dailyLogs, rest is kept', async () => {
    await dal.importAll({ dailyLogs: [{ date: '2025-01-01', weight: 90 }] })
    return dal.exportAll()
  })
  await step('restore: phone backup with id gaps, then add an exercise', async () => {
    const withGap = { ...backup, exercises: [...backup.exercises, { id: 5000, name: 'Far away id', muscleGroup: 'Back' }] }
    await dal.importAll(withGap)
    return [await dal.saveExercise({ name: 'After the gap', muscleGroup: 'Back' }), await dal.exportAll()]
  })
  return out
}

test('server data layer behaves exactly like the phone data layer', { skip }, async (t) => {
  assert.equal(db.verno, SCHEMA_VERSION, 'SCHEMA_VERSION in defaults.js must equal the highest db.version() in db.js')

  const fromPhone = await scenario(local)
  const fromServer = await scenario(remote)

  assert.equal(fromServer.length, fromPhone.length)
  for (let i = 0; i < fromPhone.length; i++) {
    const [label, expected] = fromPhone[i]
    await t.test(label, () => assert.deepStrictEqual(fromServer[i][1], expected))
  }
})

test('both data layers export the same functions', { skip }, () => {
  assert.deepStrictEqual(Object.keys(remote).sort(), Object.keys(local).sort())
})
