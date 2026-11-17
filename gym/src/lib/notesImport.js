// Import old notes (weight, food, lifts kept in a notes app) via any AI chat:
//   1. buildImportPrompt() → the user pastes it + their notes into ChatGPT / Claude / …
//   2. the chat answers with JSON in the format below
//   3. parseImport() + analyzeImport() show what would change, applyImport() writes it.
// Nothing is sent anywhere by the app itself.
import {
  getAllExercises, getAllLogs, getAllSessions, saveExercise, saveLog, saveSessions, recomputePR,
} from '../db/dal.js'
import { today, estimate8RM } from './utils.js'

// Day fields the JSON may contain → app field, with sane bounds (anything outside is dropped)
const DAY_FIELDS = {
  weight:  { key: 'weight',  min: 20, max: 400 },
  kcal:    { key: 'kcal',    min: 0,  max: 20000 },
  calories:{ key: 'kcal',    min: 0,  max: 20000 },
  protein: { key: 'protein', min: 0,  max: 2000 },
  carbs:   { key: 'carbs',   min: 0,  max: 2000 },
  fat:     { key: 'fat',     min: 0,  max: 2000 },
  sugar:   { key: 'sugar',   min: 0,  max: 2000 },
  salt:    { key: 'salt',    min: 0,  max: 100 },
  steps:   { key: 'steps',   min: 0,  max: 200000, int: true },
  sleep:   { key: 'sleep',   min: 0,  max: 24 },
  bodyFat: { key: 'bf',      min: 1,  max: 70 },
  bf:      { key: 'bf',      min: 1,  max: 70 },
}

// ── Step 1: the prompt ────────────────────────────────────
export async function buildImportPrompt() {
  const exercises = await getAllExercises()
  const byGroup = {}
  for (const e of exercises) (byGroup[e.muscleGroup] ??= []).push(e.name)
  const groups = Object.keys(byGroup).sort()
  const list = groups.map(g => `${g}: ${byGroup[g].sort().join('; ')}`).join('\n')

  return `Convert my old fitness notes (pasted at the bottom) into JSON for my tracking app.

Reply with ONLY the JSON — no explanation before or after. Use exactly this structure:

{
  "days": [
    { "date": "2025-03-14", "weight": 82.4, "kcal": 2400, "protein": 180, "carbs": 250, "fat": 70, "sugar": 50, "salt": 5.5, "steps": 9000, "sleep": 7.5, "bodyFat": 18.2, "note": "short note" }
  ],
  "sets": [
    { "date": "2025-03-14", "exercise": "Barbell Bench Press", "muscleGroup": "Chest", "weight": 80, "reps": 8, "note": "short note" }
  ]
}

Rules:
1. Only include values that are actually in my notes. Leave a field out when it's missing — never guess, estimate or invent numbers.
2. "days" = one object per date for body weight, food and daily stats. "weight" is my body weight in kg (morning weigh-in; if a day has several, use the first). "kcal" = calories eaten that day. protein, carbs, fat and sugar in grams. salt in grams (if only sodium in mg is given: salt = sodium mg × 2.5 / 1000). sleep in hours, bodyFat in %.
3. "sets" = lifting. ONE entry per exercise per date: my best set that day, i.e. the set with the highest weight × (1 + reps / 30). "weight" = weight lifted in kg (bodyweight exercises: 0, or only the added weight). "reps" = a whole number.
4. Convert pounds to kg (× 0.4536, round to 0.1). Dates as YYYY-MM-DD. If my notes leave out the year, use the most recent year that doesn't put the date after today (${today()}).
5. Exercise names: if the exercise is in the list below, use that exact name. Otherwise use a clear, standard English name, spelled the same way every time. "muscleGroup" must be one of: ${groups.join(', ')}.
6. "note": only short remarks from my notes that matter (e.g. "sick", "elbow pain", "new grip"). Leave it out otherwise.
7. Leave out anything that isn't body stats, food or lifting. If part of my notes is unclear, skip it rather than guess.
8. If you can't fit everything in one answer, stop after a complete entry, close the JSON properly, and tell me the last date you converted on one line AFTER the JSON.

Exercise list (use these exact names when they match):
${list}

My notes:
`
}

// ── Step 2: read the AI's answer ──────────────────────────
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00').getTime())
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN)
const cleanNote = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null)
const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Returns { days, sets, skipped } or { error }
export function parseImport(text) {
  if (!text?.trim()) return { error: 'Paste the AI\'s answer first.' }
  // Chats often wrap JSON in ``` fences or add a line of text around it — keep only the { … } part
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: 'No JSON found. Copy the AI\'s whole answer (it starts with { and ends with }).' }
  let data
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { error: 'The JSON is incomplete or broken — the AI\'s answer was probably cut off. Ask it to redo it in smaller parts (e.g. one month per answer) and import each part separately.' }
  }

  const skipped = []
  const todayStr = today()
  const days = new Map()   // date → merged day (the first value for a field wins)
  for (const raw of Array.isArray(data.days) ? data.days : []) {
    if (!isDate(raw?.date)) { skipped.push(`Day without a valid date: ${JSON.stringify(raw).slice(0, 60)}`); continue }
    if (raw.date > todayStr) { skipped.push(`Day in the future: ${raw.date}`); continue }
    const day = days.get(raw.date) ?? { date: raw.date }
    let any = false
    for (const [k, def] of Object.entries(DAY_FIELDS)) {
      if (raw[k] == null || day[def.key] != null) continue
      let v = num(raw[k])
      if (!Number.isFinite(v) || v < def.min || v > def.max) { skipped.push(`${raw.date}: ${k} "${raw[k]}" looks wrong`); continue }
      day[def.key] = def.int ? Math.round(v) : Math.round(v * 100) / 100
      any = true
    }
    const note = cleanNote(raw.note)
    if (note && !day.note) { day.note = note; any = true }
    if (any || days.has(raw.date)) days.set(raw.date, day)
  }

  const sets = []
  for (const raw of Array.isArray(data.sets) ? data.sets : []) {
    const where = `${raw?.date ?? '?'} ${raw?.exercise ?? '?'}`
    if (!isDate(raw?.date)) { skipped.push(`Set without a valid date: ${where}`); continue }
    if (raw.date > todayStr) { skipped.push(`Set in the future: ${where}`); continue }
    if (!normName(raw.exercise)) { skipped.push(`Set without an exercise name on ${raw.date}`); continue }
    const weight = num(raw.weight), reps = num(raw.reps)
    if (!Number.isFinite(weight) || weight < 0 || weight > 1000) { skipped.push(`${where}: weight "${raw.weight}" looks wrong`); continue }
    if (!Number.isFinite(reps) || reps < 1 || reps > 200) { skipped.push(`${where}: reps "${raw.reps}" looks wrong`); continue }
    sets.push({
      date: raw.date,
      exercise: String(raw.exercise).trim().slice(0, 80),
      muscleGroup: typeof raw.muscleGroup === 'string' ? raw.muscleGroup.trim() : '',
      weight: Math.round(weight * 100) / 100,
      reps: Math.round(reps),
      note: cleanNote(raw.note),
    })
  }

  if (!days.size && !sets.length) {
    return { error: skipped.length ? `Nothing usable found (${skipped.length} entries skipped).` : 'The JSON has no "days" or "sets" in it.' }
  }
  return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), sets, skipped }
}

// ── Step 3: what would change ─────────────────────────────
export async function analyzeImport(parsed) {
  const [logs, exercises, sessions] = await Promise.all([getAllLogs(), getAllExercises(), getAllSessions()])
  const logMap = new Map(logs.map(l => [l.date, l]))
  const groups = new Map(exercises.map(e => [e.muscleGroup.toLowerCase(), e.muscleGroup]))

  // Days: brand new, or an existing day that only gets its EMPTY fields filled
  const dayPlan = parsed.days.map(d => {
    const existing = logMap.get(d.date)
    if (!existing) return { kind: 'new', entry: d }
    const fill = {}
    for (const [k, v] of Object.entries(d)) if (k !== 'date' && (existing[k] == null || existing[k] === '')) fill[k] = v
    return Object.keys(fill).length ? { kind: 'fill', entry: { ...existing, ...fill } } : { kind: 'same' }
  })

  // Exercises: match the library by name (also the original library name of renamed ones)
  const byName = new Map()
  for (const e of exercises) {
    byName.set(normName(e.name), e)
    if (e.seedName) byName.set(normName(e.seedName), e)
  }
  const newExercises = new Map()   // normalised name → { name, muscleGroup, count }
  const existingKeys = new Set(sessions.map(s => `${s.exerciseId}|${s.date}|${s.weight}|${s.reps}`))
  const seenInFile = new Set()
  const setPlan = []
  let duplicates = 0
  const matched = new Set()
  for (const s of parsed.sets) {
    const key = normName(s.exercise)
    const ex = byName.get(key)
    if (ex) matched.add(ex.id)
    else {
      const n = newExercises.get(key) ?? { name: s.exercise, muscleGroup: groups.get(s.muscleGroup.toLowerCase()) ?? 'Other', count: 0 }
      n.count++
      newExercises.set(key, n)
    }
    const dupKey = `${ex ? ex.id : 'new:' + key}|${s.date}|${s.weight}|${s.reps}`
    if (existingKeys.has(dupKey) || seenInFile.has(dupKey)) { duplicates++; continue }
    seenInFile.add(dupKey)
    setPlan.push({ ...s, exerciseId: ex?.id ?? null, newKey: ex ? null : key })
  }

  const dates = [...parsed.days.map(d => d.date), ...parsed.sets.map(s => s.date)].sort()
  return {
    dayPlan, setPlan,
    newDays: dayPlan.filter(p => p.kind === 'new').length,
    filledDays: dayPlan.filter(p => p.kind === 'fill').length,
    sameDays: dayPlan.filter(p => p.kind === 'same').length,
    duplicates,
    matchedExercises: matched.size,
    newExercises: [...newExercises.entries()].map(([key, v]) => ({ key, ...v })),
    from: dates[0], to: dates[dates.length - 1],
    skipped: parsed.skipped,
  }
}

// ── Step 4: write it ──────────────────────────────────────
export async function applyImport(plan) {
  for (const p of plan.dayPlan) if (p.kind !== 'same') await saveLog(p.entry)

  // Create the exercises that aren't in the library yet
  const newIds = {}
  for (const n of plan.newExercises) newIds[n.key] = await saveExercise({ name: n.name, muscleGroup: n.muscleGroup })

  // One "workout" per imported date, so Delete → whole workout works on them too
  const stamp = Date.now().toString(36)
  const sessions = plan.setPlan.map(s => {
    const entry = {
      exerciseId: s.exerciseId ?? newIds[s.newKey],
      date: s.date, weight: s.weight, reps: s.reps,
      batchId: `import-${s.date}-${stamp}`,
    }
    if (s.note) entry.exNote = s.note
    return entry
  })
  if (sessions.length) await saveSessions(sessions)
  const affected = [...new Set(sessions.map(s => s.exerciseId))]
  for (const id of affected) await recomputePR(id, estimate8RM)

  return { days: plan.newDays + plan.filledDays, sets: sessions.length, exercises: plan.newExercises.length }
}
