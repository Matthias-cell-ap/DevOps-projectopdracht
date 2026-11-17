// Next-set weight suggestions — pure local math, no AI calls.
//
// Method: double progression with e1RM-sized load jumps, one step per week.
// An exercise's "level" = its current weight and the most reps done at that weight.
//   • In range  → +1 rep, once the level has held for a week (until then: same reps)
//   • Top hit   → after a week at the top, add weight so the lifter would get (bottom + 2)
//                 reps at current strength, but only ask for (bottom + 1): a 1-rep buffer
//   • Below range → drop weight into range right away, same 1-rep buffer
// A "hold" phase (cut) asks you to match your level instead of beating it.
// Each saved set stores the target it was aiming for; a week of missed targets = stalling.
import { resolvePhase } from './phases.js'
import { daysBetween } from './utils.js'

// Groups that aren't weight × reps strength work — no suggestions for these
const NON_STRENGTH = ['Conditioning', 'Sport', 'Mobility']

// Estimated 1-rep max (Epley) — same formula the 8RM/PR logic is built on
export function estimate1RM(weight, reps) {
  return weight * (1 + reps / 30)
}

// Weight you'd lift for `reps` at a given e1RM
function weightFor(e1rm, reps) {
  return e1rm / (1 + reps / 30)
}

// Round down to 0.5 kg so the suggestion errs on the achievable side
function roundDown(w) {
  return Math.floor(w * 2) / 2
}

export function getProgressionConfig(profile) {
  const min = parseInt(profile?.progMinReps)
  const max = parseInt(profile?.progMaxReps)
  const minReps = Number.isFinite(min) && min >= 1 ? min : 6
  const maxReps = Number.isFinite(max) && max > minReps + 1 ? max : Math.max(10, minReps + 2)
  return {
    enabled: !!profile?.weightSuggestions,
    minReps,
    maxReps,
  }
}

// "A week": 6+ days, so a Monday → Sunday week counts too
export const WEEK_DAYS = 6

// 'progress' | 'hold' | 'off' for the active phase.
// Built-ins define it; custom phases may set it, otherwise it follows their colour feel.
export function getProgressionMode(profile) {
  const phase = resolvePhase(profile)
  if (phase.progressionMode) return phase.progressionMode
  return phase.baseType === 'cut' ? 'hold' : 'progress'
}

// The level an exercise is at: its current weight and the most reps done at that weight since
// switching to it. A bad day doesn't lower it.
// since = start of the latest unbroken stretch of sets at that level (the one-week clock).
// recovering = the last set dropped below the level: get back to it first; the clock restarts then.
export function currentLevel(sessions) {
  const sorted = chronological(sessions)
  if (!sorted.length) return null
  const weight = sorted[sorted.length - 1].weight
  let i = sorted.length - 1
  while (i > 0 && sorted[i - 1].weight === weight) i--
  const run = sorted.slice(i)
  const reps = Math.max(...run.map(s => s.reps))
  let j = run.length - 1
  if (run[j].reps < reps) return { weight, reps, since: null, recovering: true }
  while (j > 0 && run[j - 1].reps >= reps) j--
  return { weight, reps, since: run[j].date, recovering: false }
}

// Suggest the next top set from the exercise's level. Returns null when there's nothing to suggest.
// kind: 'rep' (+1 rep) | 'jump' (add weight) | 'reset' (lighter, back in range) | 'hold' | 'bodyweight'
//       | 'wait' (same reps — the level is less than a week old; `dueIn` days to go, `next` = the step then)
//       | 'recover' (back to your level after dropping below it)
// sessionDate: the day being logged (so backdating works).
export function suggestNext(level, mode, cfg, muscleGroup, sessionDate) {
  const s = baseSuggestion(level, mode, cfg, muscleGroup)
  if (s && ['rep', 'jump', 'bodyweight'].includes(s.kind)) {
    // Dropped below your level last time: get back to it first (the week restarts once you're there)
    if (level.recovering) return { weight: level.weight, reps: level.reps, kind: 'recover' }
  }
  // A step forward only once you've held your level for a week. Too heavy ('reset') never waits.
  if (s && ['rep', 'jump', 'bodyweight'].includes(s.kind) && sessionDate) {
    const held = daysBetween(level.since, sessionDate)
    if (held >= 0 && held < WEEK_DAYS) {
      return { weight: level.weight, reps: level.reps, kind: 'wait', next: s.kind, dueIn: WEEK_DAYS - held }
    }
  }
  return s
}

function baseSuggestion(level, mode, cfg, muscleGroup) {
  if (!level || mode === 'off' || NON_STRENGTH.includes(muscleGroup)) return null
  const w = level.weight, r = level.reps
  if (!Number.isFinite(w) || !Number.isFinite(r) || r < 1) return null
  const { minReps, maxReps } = cfg

  // Unloaded / bodyweight: progress on reps only
  if (w <= 0) {
    return mode === 'hold'
      ? { weight: 0, reps: r, kind: 'hold' }
      : { weight: 0, reps: r + 1, kind: 'bodyweight' }
  }

  if (mode === 'hold') return { weight: w, reps: r, kind: 'hold' }

  const e1rm = estimate1RM(w, r)

  // Below the range: the load is too heavy — come back into range with a 1-rep buffer
  if (r < minReps) {
    const targetReps = Math.round((minReps + maxReps) / 2)
    const weight = roundDown(weightFor(e1rm, targetReps + 1))
    return { weight, reps: targetReps, kind: 'reset' }
  }

  // Top of the range reached: add weight, land near the bottom with a 1-rep buffer
  if (r >= maxReps) {
    const targetReps = Math.min(minReps + 1, maxReps)
    let weight = roundDown(weightFor(e1rm, targetReps + 1))
    if (weight <= w) weight = w + 0.5
    return { weight, reps: targetReps, kind: 'jump' }
  }

  // In range: same weight, one more rep
  return { weight: w, reps: r + 1, kind: 'rep' }
}

// Did a saved set reach the target it was aiming for? null = no target recorded.
export function sessionHit(s) {
  if (s?.targetReps == null) return null
  if (s.targetWeight > 0) {
    // Compared on estimated strength so a different-but-equivalent set still counts
    return estimate1RM(s.weight, s.reps) >= estimate1RM(s.targetWeight, s.targetReps) * 0.995
  }
  return s.reps >= s.targetReps
}

// How many earlier sessions a set is compared with. Beating only the previous one isn't
// enough — bouncing back after one bad day (80×8, 80×7, 80×8) is not progress.
export const RECENT_WINDOW = 3

// Did a set beat the best of the recent sessions before it on estimated strength (any amount counts)?
// `recent` = the sessions just before it, newest last.
export function beatRecent(s, recent) {
  if (!recent?.length) return false
  const best = Math.max(...recent.slice(-RECENT_WINDOW).map(r => estimate1RM(r.weight, r.reps)))
  return estimate1RM(s.weight, s.reps) > best * 1.0005
}

// Oldest → newest, same-day sets in save order
export function chronological(sessions) {
  return [...sessions].sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0))
}

// Stalling: since the last step forward, your misses (the extra rep / more weight not made,
// dropping below your level, or on a cut: not matching it) span a week or more.
// Holding your level ('wait') or getting back to it ('recover') is neutral — it's not a step
// forward, so going 8 → 7 → 8 reps doesn't hide a stall. A step forward (hitting a step target,
// or beating recent sessions) or a set without a target ends the run.
export function stallInfo(sessions) {
  const sorted = chronological(sessions)
  let first = null, last = null, count = 0
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]
    const recent = sorted.slice(Math.max(0, i - RECENT_WINDOW), i)
    if (beatRecent(s, recent)) break
    const hit = sessionHit(s)
    if (hit === null) break
    if (hit) {
      if (s.targetKind === 'wait' || s.targetKind === 'recover') continue
      break
    }
    last ??= s.date
    first = s.date
    count++
  }
  const days = first ? daysBetween(first, last) : 0
  return { stalled: count >= 2 && days >= WEEK_DAYS, count, days }
}

// Ids of sets that were a PR when logged: a better 8RM than every set before them.
// The very first set of an exercise isn't marked — there was nothing to beat yet.
export function prSetIds(sessions) {
  const ids = new Set()
  let best = null
  for (const s of chronological(sessions)) {
    const e = estimate1RM(s.weight, s.reps)
    if (best !== null && e > best * 1.0005) ids.add(s.id)
    if (best === null || e > best) best = e
  }
  return ids
}
