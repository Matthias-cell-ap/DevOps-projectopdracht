import { resolvePhase } from './phases.js'

// ── Macro color config ────────────────────────────────────
// Per-macro mode: which direction counts as "good"
//   'under' — at/under goal is green, only going over is penalised (cut-style kcal)
//   'near'  — two-sided: green only when close to goal
//   'over'  — at/over goal is green, only falling under is penalised (protein-style)
// Sensible colour rules per phase type (used until the user changes them for that phase)
const PHASE_COLOR_DEFAULTS = {
  cut:      { kcal: 'under', protein: 'near', carbs: 'under', fat: 'under', sugar: 'under', salt: 'under' },
  bulk:     { kcal: 'over',  protein: 'near', carbs: 'near',  fat: 'near',  sugar: 'under', salt: 'under' },
  maintain: { kcal: 'near',  protein: 'near', carbs: 'near',  fat: 'near',  sugar: 'under', salt: 'under' },
}
export const defaultColorModes = (baseType) => PHASE_COLOR_DEFAULTS[baseType] ?? PHASE_COLOR_DEFAULTS.maintain

const MACRO_GOAL_KEYS = { kcal: 'goalKcal', protein: 'goalProtein', carbs: 'goalCarbs', fat: 'goalFat', sugar: 'goalSugar', salt: 'goalSalt' }

// Settings that belong to a phase: archived when you leave it, restored when you return
export const PHASE_SETTING_KEYS = [...Object.values(MACRO_GOAL_KEYS), 'colorModes', 'colorGreenPct', 'colorAmberPct']

// The most recent archived settings of a phase id (null if it was never left with settings)
export function lastPhaseSettings(profile, phaseId) {
  return [...(profile?.phaseHistory ?? [])].reverse().find(h => h.phase === phaseId && h.settings)?.settings ?? null
}

const pct = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback }

// Colour rules for a settings object (the live profile, or a phase's archived settings)
function colorConfigFrom(settings, baseType) {
  return {
    modes: { ...defaultColorModes(baseType), ...(settings?.colorModes ?? {}) },
    green: pct(settings?.colorGreenPct, 5),
    amber: pct(settings?.colorAmberPct, 15),
  }
}

// The current phase's colour rules
export function getColorConfig(profile) {
  return colorConfigFrom(profile, resolvePhase(profile).baseType)
}

// Macro goals ({kcal, protein, …}) from a settings object with goalKcal-style keys
export function goalsFrom(settings) {
  const out = {}
  for (const [k, gk] of Object.entries(MACRO_GOAL_KEYS)) out[k] = settings?.[gk]
  return out
}

// What a newly logged day stores: the goals AND colour rules in force right now,
// so it keeps its colours after goals or rules change in a later phase.
export function snapshotSettings(profile) {
  const cfg = getColorConfig(profile)
  return { ...goalsFrom(profile), modes: cfg.modes, green: cfg.green, amber: cfg.amber }
}

// Which phase a date belongs to: the current phase, or an archived one from history
export function phaseAtDate(profile, date) {
  if (!profile) return { baseType: 'cut', archived: null, current: true }
  if (!profile.phaseStartDate || date >= profile.phaseStartDate) {
    return { baseType: resolvePhase(profile).baseType, archived: null, current: true }
  }
  const h = [...(profile.phaseHistory ?? [])].reverse().find(x => date >= x.from && date <= x.to)
    ?? (profile.phaseHistory ?? [])[0]
  if (!h) return { baseType: resolvePhase(profile).baseType, archived: null, current: true }
  return { baseType: resolvePhase(profile, h.phase).baseType, archived: h.settings ?? null, current: false }
}

// The goals + colour rules a logged day should be judged by:
//   1. what it was logged with (snapshot), else
//   2. the phase it falls in — that phase's archived targets/rules, or its type's defaults, else
//   3. today's settings.
export function judgeConfigForLog(profile, log) {
  const snap = log?.goalsSnapshot
  const ph = phaseAtDate(profile, log?.date ?? '')
  const phaseSettings = ph.current ? profile : ph.archived
  const cfg = snap?.modes
    ? { modes: { ...defaultColorModes(ph.baseType), ...snap.modes }, green: pct(snap.green, 5), amber: pct(snap.amber, 15) }
    : colorConfigFrom(phaseSettings, ph.baseType)
  const snapHasGoals = snap && Object.keys(MACRO_GOAL_KEYS).some(k => snap[k] != null && snap[k] !== '')
  const goals = snapHasGoals ? snap : goalsFrom(phaseSettings ?? profile)
  return { ...cfg, goals }
}

export function macroColor(actual, goal, mode = 'near', greenPct = 5, amberPct = 15) {
  if (!goal) return 'neutral'
  const pct = ((actual - goal) / goal) * 100
  let dev
  if (mode === 'under') dev = Math.max(0, pct)        // only over-goal counts against you
  else if (mode === 'over') dev = Math.max(0, -pct)   // only under-goal counts against you
  else dev = Math.abs(pct)                            // two-sided
  if (dev <= greenPct) return 'green'
  if (dev <= amberPct) return 'amber'
  return 'red'
}

// Format a Date as a LOCAL YYYY-MM-DD string (no UTC conversion / timezone drift)
export function toLocalISODate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function today() {
  return toLocalISODate(new Date())
}

// Local date N days ago. Steps in calendar days, so daylight-saving changes
// (23- or 25-hour days) can't shift it to the wrong date.
export function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toLocalISODate(d)
}

// Whole calendar days from a YYYY-MM-DD date until today (0 on the day itself)
export function daysSince(dateStr) {
  if (!dateStr) return 0
  return daysBetween(dateStr, today())
}

// Whole calendar days from one YYYY-MM-DD date to another (negative if `to` is earlier)
export function daysBetween(from, to) {
  const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((utc(to) - utc(from)) / 86400000)
}

export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Daily entry form helpers (shared by Home quick entry and the Log tab) ──
export const ENTRY_NUM_FIELDS = ['weight', 'sleep', 'steps', 'kcal', 'protein', 'carbs', 'fat', 'sugar', 'salt', 'bf']

export const emptyEntry = (date) => ({
  date, weight: '', sleep: '', steps: '',
  kcal: '', protein: '', carbs: '', fat: '', sugar: '', salt: '', bf: '',
  note: '', important: false,
})

// Has anything been entered that's worth saving (or keeping as a draft)?
export function entryHasData(f) {
  return ENTRY_NUM_FIELDS.some(k => f[k] !== '' && f[k] != null) || !!f.note || !!f.important
}

// Fields that were filled in but can't be saved (a negative number is a typo)
export function invalidEntryFields(raw) {
  return ENTRY_NUM_FIELDS.filter(k => raw[k] !== '' && raw[k] != null && !(parseFloat(raw[k]) >= 0))
}

// Form strings → stored entry: valid numbers only, empty fields dropped (so a merge keeps
// existing values), and the old "sick" flag folded into "important".
export function coerceEntryFields(raw) {
  const entry = { ...raw }
  for (const k of ENTRY_NUM_FIELDS) {
    const num = parseFloat(entry[k])
    if (entry[k] !== '' && entry[k] != null && Number.isFinite(num) && num >= 0) entry[k] = num   // negatives are typos
    else delete entry[k]
  }
  if (!entry.note) delete entry.note
  const important = !!(raw.important || raw.sick)
  delete entry.sick
  if (important) entry.important = true
  else delete entry.important
  return entry
}

// Compact export format for a single log entry
export function serializeLog(log, goals) {
  if (!log) return ''
  const parts = [`${log.date} | ${log.weight}kg`]
  if (log.sleep != null && log.sleep < 8) parts.push(`sleep ${log.sleep}h`)
  if (log.steps != null) parts.push(`steps ${log.steps.toLocaleString()}`)

  const fields = [
    { key: 'kcal',    label: 'kcal',    higherIsBad: true },
    { key: 'protein', label: 'protein', higherIsBad: false },
    { key: 'carbs',   label: 'carbs',   higherIsBad: true },
    { key: 'fat',     label: 'fat',     higherIsBad: true },
    { key: 'sugar',   label: 'sugar',   higherIsBad: true },
    { key: 'salt',    label: 'salt',    higherIsBad: true },
  ]

  let allGood = true
  for (const f of fields) {
    const actual = log[f.key]
    const goal = goals?.[f.key]
    if (actual == null || !goal) continue
    const diff = actual - goal
    const pct = Math.abs(diff) / goal
    if (pct > 0.05) {
      allGood = false
      const sign = diff > 0 ? '+' : ''
      const unit = f.key === 'kcal' ? '' : 'g'
      parts.push(`${f.label} ${sign}${Math.round(diff)}${unit}`)
    }
  }

  if (allGood && parts.length === 1) parts.push('all on target')
  if (log.important || log.sick) parts.push('IMPORTANT')
  if (log.note) parts.push(`note: ${log.note}`)
  return parts.join(' | ')
}


// ── Strength normalization ────────────────────────────────
// Epley estimated 1RM, then converted to the weight you could lift for 8 reps.
// This lets us compare sets fairly: 1×150 vs 20×145 — higher reps at near weight
// is actually a stronger performance, so it should win.
export function estimate8RM(weight, reps) {
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || reps < 1) return 0
  const e1rm = weight * (1 + reps / 30)      // Epley 1RM
  const w8 = e1rm / (1 + 8 / 30)             // weight for 8 reps
  return w8
}

// Rounded display value of the estimated 8RM
export function estimate8RMDisplay(weight, reps) {
  return Math.round(estimate8RM(weight, reps) * 10) / 10
}

// ── Data export & averages ────────────────────────────────
const EXPORT_FIELDS = ['weight', 'kcal', 'protein', 'carbs', 'fat', 'sugar', 'salt', 'steps', 'sleep']

// Build a clean tab-separated table of logs for copying to clipboard / spreadsheet.
export function formatLogsTable(logs) {
  const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date))
  const header = ['date', 'weight', 'kcal', 'protein', 'carbs', 'fat', 'sugar', 'salt', 'steps', 'sleep', 'note'].join('\t')
  const rows = sorted.map(l => {
    const cells = [
      l.date,
      l.weight ?? '',
      l.kcal ?? '',
      l.protein ?? '',
      l.carbs ?? '',
      l.fat ?? '',
      l.sugar ?? '',
      l.salt ?? '',
      l.steps ?? '',
      l.sleep ?? '',
      l.note ? l.note.replace(/\t/g, ' ') : '',
    ]
    return cells.join('\t')
  })
  return [header, ...rows].join('\n')
}

// Compute the average of each numeric field across logs (ignoring blanks).
export function averageLogs(logs) {
  const sums = {}, counts = {}
  for (const f of EXPORT_FIELDS) { sums[f] = 0; counts[f] = 0 }
  for (const l of logs) {
    for (const f of EXPORT_FIELDS) {
      if (Number.isFinite(l[f])) { sums[f] += l[f]; counts[f]++ }
    }
  }
  const avg = {}
  for (const f of EXPORT_FIELDS) {
    avg[f] = counts[f] > 0 ? sums[f] / counts[f] : null
  }
  return { avg, counts, total: logs.length }
}
