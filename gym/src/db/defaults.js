import { today } from '../lib/utils.js'

// What a fresh install starts with. Used by both data layers: IndexedDB on the phone (db.js)
// and the server version (dal.api.js), so both start from the same data.

// Highest db.version(...) in db.js — the "schemaVersion" written into backups.
// Raise it together with a new db.version() there.
export const SCHEMA_VERSION = 5

// Weekly schedule: day 0=Sun..6=Sat, all rest days
export const defaultSchedule = () =>
  [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, type: 'rest', label: 'Rest', sessionTypeId: null }))

// Single profile record, always id=1
export const defaultProfile = () => ({
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
