import Dexie from 'dexie'
import { SEED_EXERCISES } from './seedExercises.js'
import { today } from '../lib/utils.js'

export const db = new Dexie('GymApp')

db.version(1).stores({
  // One record per day: weight, sleep, macros
  dailyLogs: '&date, weight, sleep, kcal, protein, carbs, fat, sugar, salt, bf',

  // Exercise definitions
  exercises: '++id, name, muscleGroup, workoutType',

  // Goal per exercise (current target)
  exerciseGoals: '&exerciseId, targetWeight, targetReps',

  // Each logged top set for a session
  sessions: '++id, exerciseId, date, weight, reps',

  // Personal records per exercise
  personalRecords: '&exerciseId, date, weight, reps',

  // Weekly schedule: day 0=Sun..6=Sat
  schedule: '&day, type, label, workoutType',

  // Research / notes cards
  research: '++id, title, status, body, createdAt, order',

  // Single profile record, always id=1
  profile: '&id',

  // AI-generated persistent memories — key insights from chat sessions
  aiMemory: '++id, date, text',
})

// Migrate: add aiMemory table in v2 if upgrading from v1
db.version(2).stores({
  dailyLogs: '&date, weight, sleep, kcal, protein, carbs, fat, sugar, salt, bf',
  exercises: '++id, name, muscleGroup, workoutType',
  exerciseGoals: '&exerciseId, targetWeight, targetReps',
  sessions: '++id, exerciseId, date, weight, reps',
  personalRecords: '&exerciseId, date, weight, reps',
  schedule: '&day, type, label, workoutType',
  research: '++id, title, status, body, createdAt, order',
  profile: '&id',
  aiMemory: '++id, date, text',
})

// v3: exercise library + user-defined session types.
// Wipes old exercise/session/PR/goal data (old split model) and seeds the library.
db.version(3).stores({
  dailyLogs: '&date, weight, sleep, kcal, protein, carbs, fat, sugar, salt, bf',
  exercises: '++id, name, muscleGroup',
  exerciseGoals: '&exerciseId, targetWeight, targetReps',
  sessions: '++id, exerciseId, date, weight, reps',
  personalRecords: '&exerciseId, date, weight, reps',
  schedule: '&day, type, label',
  research: '++id, title, status, body, createdAt, order',
  profile: '&id',
  aiMemory: '++id, date, text',
  // User-created session types: { id, name, exerciseIds: [] }
  sessionTypes: '++id, name',
}).upgrade(async (tx) => {
  await tx.table('exercises').clear()
  await tx.table('sessions').clear()
  await tx.table('personalRecords').clear()
  await tx.table('exerciseGoals').clear()
  await tx.table('exercises').bulkAdd(SEED_EXERCISES.map(e => ({ ...e })))
  // Old push/pull/legs links no longer exist — clear them from the schedule
  const days = await tx.table('schedule').toArray()
  for (const d of days) {
    delete d.workoutType
    await tx.table('schedule').put({ ...d, sessionTypeId: null })
  }
})

// v4: expanded exercise library. Additive only — keeps user sessions, history,
// goals and any custom exercises; just fills in library entries that are missing.
db.version(4).stores({
  dailyLogs: '&date, weight, sleep, kcal, protein, carbs, fat, sugar, salt, bf',
  exercises: '++id, name, muscleGroup',
  exerciseGoals: '&exerciseId, targetWeight, targetReps',
  sessions: '++id, exerciseId, date, weight, reps',
  personalRecords: '&exerciseId, date, weight, reps',
  schedule: '&day, type, label',
  research: '++id, title, status, body, createdAt, order',
  profile: '&id',
  aiMemory: '++id, date, text',
  sessionTypes: '++id, name',
}).upgrade(async (tx) => {
  const existing = await tx.table('exercises').toArray()
  const have = new Set(existing.map(e => e.name.toLowerCase()))
  const missing = SEED_EXERCISES.filter(e => !have.has(e.name.toLowerCase()))
  if (missing.length) await tx.table('exercises').bulkAdd(missing.map(e => ({ ...e })))
})

// v5: library expanded again + new muscle groups (Obliques, Traps, Lower Back, Adductors).
// Adds missing entries and moves existing library entries into their new group.
// Matches by name only, so custom exercises and all logged history/IDs are untouched.
db.version(5).stores({
  dailyLogs: '&date, weight, sleep, kcal, protein, carbs, fat, sugar, salt, bf',
  exercises: '++id, name, muscleGroup',
  exerciseGoals: '&exerciseId, targetWeight, targetReps',
  sessions: '++id, exerciseId, date, weight, reps',
  personalRecords: '&exerciseId, date, weight, reps',
  schedule: '&day, type, label',
  research: '++id, title, status, body, createdAt, order',
  profile: '&id',
  aiMemory: '++id, date, text',
  sessionTypes: '++id, name',
}).upgrade(async (tx) => {
  const table = tx.table('exercises')
  const existing = await table.toArray()
  const byName = new Map(existing.map(e => [e.name.toLowerCase(), e]))
  const toAdd = []
  for (const seed of SEED_EXERCISES) {
    const row = byName.get(seed.name.toLowerCase())
    if (!row) toAdd.push({ ...seed })
    else if (row.muscleGroup !== seed.muscleGroup) await table.update(row.id, { muscleGroup: seed.muscleGroup })
  }
  if (toAdd.length) await table.bulkAdd(toAdd)
})

// Seed defaults if empty (fresh installs)
db.on('ready', async () => {
  const count = await db.schedule.count()
  if (count === 0) {
    await db.schedule.bulkPut(
      [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, type: 'rest', label: 'Rest', sessionTypeId: null }))
    )
  }

  const exerciseCount = await db.exercises.count()
  if (exerciseCount === 0) {
    await db.exercises.bulkAdd(SEED_EXERCISES.map(e => ({ ...e })))
  }

  const profileCount = await db.profile.count()
  if (profileCount === 0) {
    await db.profile.put({
      id: 1,
      injuries: '',
      trainingContext: '',
      dietaryNotes: '',
      height: '',
      age: '',
      goalWeight: '',
      experience: '',
      phase: 'cut',
      phaseStartDate: today(),
      phaseHistory: [],
      weightSuggestions: true,   // the gym tab's next-set suggestions are on for new users
      theme: 'dark',
    })
  }
})
