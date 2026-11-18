// Every collection the app stores, and which field is its primary key.
// Mirrors the IndexedDB schema in ../../src/db/db.js.
//
// This list is also a whitelist: table names can't be passed as SQL parameters, so they
// end up in the query text. Only names from this list are ever used that way, so a request
// for "/api/data/users; DROP TABLE ..." is refused instead of reaching the database.
//
// autoId: the server hands out the id when a new row has none (like Dexie's "++id").
export const TABLES = {
  dailyLogs:       { sql: 'daily_logs',       key: 'date' },
  exercises:       { sql: 'exercises',        key: 'id', autoId: true },
  exerciseGoals:   { sql: 'exercise_goals',   key: 'exerciseId' },
  sessions:        { sql: 'sessions',         key: 'id', autoId: true },
  personalRecords: { sql: 'personal_records', key: 'exerciseId' },
  schedule:        { sql: 'schedule',         key: 'day' },
  research:        { sql: 'research',         key: 'id', autoId: true },
  profile:         { sql: 'profile',          key: 'id' },
  aiMemory:        { sql: 'ai_memory',        key: 'id', autoId: true },
  sessionTypes:    { sql: 'session_types',    key: 'id', autoId: true },
}

// An error that becomes an HTTP response with this status (instead of a 500).
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function getTable(name) {
  if (!Object.hasOwn(TABLES, name)) throw new HttpError(404, `Unknown table: ${name}`)
  return TABLES[name]
}
