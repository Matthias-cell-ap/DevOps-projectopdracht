import {
  getAllLogs, getAllExercises, getAllSessions, getAllPRs, getAllGoals,
  getResearch, getSessionTypes, getSchedule, getProfile,
} from '../db/dal.js'
import { formatLogsTable, averageLogs, estimate8RMDisplay } from './utils.js'
import { resolvePhase, phaseEnd } from './phases.js'
import { prSetIds } from './progression.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

// What can be copied. usesPeriod / usesExercises say which filters apply.
export const COPY_TARGETS = [
  { id: 'dailyLogs', label: 'Daily logs (weight + macros)',    usesPeriod: true },
  { id: 'exercises', label: 'Exercise history (logged sets)',  usesPeriod: true, usesExercises: true },
  { id: 'prs',       label: 'Personal records & goals',        usesExercises: true },
  { id: 'sessions',  label: 'My splits & schedule' },
  { id: 'research',  label: 'Research notes' },
  { id: 'profile',   label: 'Profile, targets & training info' },
]

// Put in front of the copied data when it's meant for an AI chat (ChatGPT, Claude, …):
// explains how to read the data, so the answers don't misread it.
const AI_INTRO = `I track my fitness in an app. My data is below — please use it to answer my question at the end.

How to read the data:
- Body weight is measured each morning, fasted. The macros on the same row are what I ate during that day, AFTER the weigh-in — so a day's food shows up in the NEXT morning's weight, not the same row's. Daily weight also swings with water; judge trends over a week or more.
- Each logged set is my top set for that exercise that workout (taken close to failure), as weight × reps.
- est_8rm_kg is the estimated weight I could lift for 8 reps (Epley formula). Use it to compare sets with different rep counts. new_best = yes means the set beat every earlier set of that exercise.
- Exercise notes apply to that exercise only (e.g. a form change, which can explain a drop); workout notes apply to the whole workout.
- Phases (cut / bulk / maintain) each have their own daily targets; profile & phase history show which applied when.

Keep answers specific to my data and to the point.`

const AI_OUTRO = `My question: `

const inPeriod = (date, period) => !period || ((!period.from || date >= period.from) && (!period.to || date <= period.to))
const periodText = (period) => {
  if (!period) return 'all time'
  const range = `${period.from ?? 'start'} → ${period.to ?? 'today'}`
  return period.label ? `${period.label} (${range})` : range
}

// Each chosen period becomes its own block (with its own averages), so periods can be compared.
// periods: array of { from, to, label? }, or null/empty for all time.
const eachPeriod = (periods) => (periods?.length ? periods : [null])

async function textDailyLogs({ periods }) {
  const all = await getAllLogs()
  return eachPeriod(periods).map(period => {
    const logs = all.filter(l => inPeriod(l.date, period))
    if (!logs.length) return `Period: ${periodText(period)}\nNo daily logs.`
    // Averages first — the usual reason to copy a period
    const { avg, total } = averageLogs(logs)
    const f = (v, d = 0) => (v == null ? '—' : v.toFixed(d))
    const summary =
      `Period: ${periodText(period)} · ${total} days\n` +
      `Averages: weight ${f(avg.weight, 1)}kg | kcal ${f(avg.kcal)} | protein ${f(avg.protein)}g | ` +
      `carbs ${f(avg.carbs)}g | fat ${f(avg.fat)}g | sugar ${f(avg.sugar)}g | salt ${f(avg.salt, 1)}g | ` +
      `steps ${f(avg.steps)} | sleep ${f(avg.sleep, 1)}h`
    return `${summary}\n\n${formatLogsTable(logs)}`
  }).join('\n\n')
}

async function textExercises({ periods, exerciseIds }) {
  const [sessions, exercises] = await Promise.all([getAllSessions(), getAllExercises()])
  const exMap = Object.fromEntries(exercises.map(e => [e.id, e]))
  // "new best" = beat every earlier set of that exercise (judged over all history, like the app's 🏆)
  const byExercise = {}
  for (const s of sessions) (byExercise[s.exerciseId] ??= []).push(s)
  const prIds = new Set(Object.values(byExercise).flatMap(list => [...prSetIds(list)]))
  const header = ['date', 'exercise', 'muscle', 'weight_kg', 'reps', 'est_8rm_kg', 'new_best', 'exercise_note', 'workout_note'].join('\t')
  return eachPeriod(periods).map(period => {
    const rows = sessions
      .filter(s => inPeriod(s.date, period) && (!exerciseIds || exerciseIds.includes(s.exerciseId)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    if (!rows.length) return `Period: ${periodText(period)}\nNo logged sets.`
    const lines = rows.map(s => [
      s.date,
      exMap[s.exerciseId]?.name ?? `#${s.exerciseId}`,
      exMap[s.exerciseId]?.muscleGroup ?? '',
      s.weight,
      s.reps,
      estimate8RMDisplay(s.weight, s.reps),
      prIds.has(s.id) ? 'yes' : '',
      s.exNote ? s.exNote.replace(/\t/g, ' ') : '',
      s.note ? s.note.replace(/\t/g, ' ') : '',
    ].join('\t'))
    return [`Period: ${periodText(period)}`, header, ...lines].join('\n')
  }).join('\n\n')
}

async function textPRs({ exerciseIds }) {
  const [prs, goals, exercises] = await Promise.all([getAllPRs(), getAllGoals(), getAllExercises()])
  const exMap = Object.fromEntries(exercises.map(e => [e.id, e]))
  let ids = [...new Set([...prs.map(p => p.exerciseId), ...goals.map(g => g.exerciseId)])]
  if (exerciseIds) ids = ids.filter(id => exerciseIds.includes(id))
  if (!ids.length) return 'No PRs or goals.'
  const prMap = Object.fromEntries(prs.map(p => [p.exerciseId, p]))
  const goalMap = Object.fromEntries(goals.map(g => [g.exerciseId, g]))
  const header = ['exercise', 'muscle', 'pr_weight', 'pr_reps', 'pr_est_8rm', 'pr_date', 'goal_weight', 'goal_reps'].join('\t')
  const lines = ids
    .map(id => {
      const pr = prMap[id], g = goalMap[id]
      return [
        exMap[id]?.name ?? `#${id}`,
        exMap[id]?.muscleGroup ?? '',
        pr?.weight ?? '', pr?.reps ?? '',
        pr ? estimate8RMDisplay(pr.weight, pr.reps) : '',
        pr?.date ?? '',
        g?.targetWeight ?? '', g?.targetReps ?? '',
      ].join('\t')
    })
    .sort()
  return [header, ...lines].join('\n')
}

async function textSessions() {
  const [types, exercises, schedule] = await Promise.all([getSessionTypes(), getAllExercises(), getSchedule()])
  const exMap = Object.fromEntries(exercises.map(e => [e.id, e]))
  const typeMap = Object.fromEntries(types.map(t => [t.id, t]))
  const out = ['MY SPLITS']
  if (!types.length) out.push('  (none created yet)')
  for (const t of types) {
    out.push(`  ${t.name}`)
    if (!t.exerciseIds.length) out.push('    (empty)')
    for (const id of t.exerciseIds) out.push(`    - ${exMap[id]?.name ?? `#${id}`} (${exMap[id]?.muscleGroup ?? '?'})`)
  }
  out.push('', 'WEEKLY SCHEDULE')
  for (const n of DAY_ORDER) {
    const d = schedule.find(s => s.day === n)
    if (!d) continue
    const linked = d.sessionTypeId ? typeMap[d.sessionTypeId]?.name : null
    out.push(`  ${DAY_NAMES[d.day]}: ${d.label} [${d.type}]${linked ? ` → ${linked}` : ''}`)
  }
  return out.join('\n')
}

async function textResearch() {
  const items = await getResearch()
  if (!items.length) return 'No research notes.'
  return items.map(i => `## ${i.title} [${i.status}]\n${i.body || '(empty)'}`).join('\n\n')
}

async function textProfile() {
  const p = await getProfile()
  if (!p) return 'No profile.'
  const phase = resolvePhase(p)
  const lines = [
    `Phase: ${phase.name} (started ${p.phaseStartDate})${phase.description ? ' — ' + phase.description : ''}`,
    `Height: ${p.height || '?'} cm | Age: ${p.age || '?'} | Experience: ${p.experience || '?'}`,
    `Targets: kcal ${p.goalKcal || '?'} | protein ${p.goalProtein || '?'}g | carbs ${p.goalCarbs || '?'}g | fat ${p.goalFat || '?'}g | sugar ${p.goalSugar || '?'}g | salt ${p.goalSalt || '?'}g`,
    '', 'TRAINING INFO', p.trainingInfo || '(not set)',
    '', 'PERSONAL PLAN', p.personalPlan || '(not set)',
  ]
  if (p.phaseHistory?.length) {
    lines.push('', 'PHASE HISTORY')
    for (const h of p.phaseHistory) {
      const s = h.settings
      const t = s ? ` · targets kcal ${s.goalKcal || '?'} | protein ${s.goalProtein || '?'}g | carbs ${s.goalCarbs || '?'}g | fat ${s.goalFat || '?'}g` : ''
      lines.push(`  ${h.name ?? h.phase}: ${h.from} → ${phaseEnd(h)}${t}`)
    }
  }
  return lines.join('\n')
}

const BUILDERS = {
  dailyLogs: textDailyLogs,
  exercises: textExercises,
  prs: textPRs,
  sessions: textSessions,
  research: textResearch,
  profile: textProfile,
}

// targets: ids from COPY_TARGETS
// periods: array of { from, to, label? }, or null for all time (applies to daily logs + exercise history)
// exerciseIds: array or null for all exercises (applies to exercise history + PRs)
// forAI: wrap the data in an explanation + "My question:" so it can be pasted straight into an AI chat
export async function buildCopyText({ targets, periods = null, exerciseIds = null, forAI = false }) {
  const chosen = COPY_TARGETS.filter(t => targets.includes(t.id))
  let text
  if (chosen.length === 1 && !forAI) {
    text = await BUILDERS[chosen[0].id]({ periods, exerciseIds })
  } else {
    const sections = []
    for (const t of chosen) {
      const body = await BUILDERS[t.id]({ periods, exerciseIds })
      sections.push(`═══ ${t.label.toUpperCase()} ═══\n${body}`)
    }
    text = sections.join('\n\n\n')
  }
  return forAI ? `${AI_INTRO}\n\n\n${text}\n\n\n${AI_OUTRO}` : text
}
