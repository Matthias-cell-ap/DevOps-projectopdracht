import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout.jsx'
import Chip from '../components/Chip.jsx'
import { useAppStore } from '../store/useAppStore.js'
import { getLog, mergeLog, getLogs, getSchedule, getLatestWeighedLog } from '../db/dal.js'
import { resolvePhase, phaseClass } from '../lib/phases.js'
import {
  macroColor, judgeConfigForLog, snapshotSettings, today, daysAgo, daysSince, formatDate,
  emptyEntry, entryHasData, coerceEntryFields, invalidEntryFields,
} from '../lib/utils.js'
import { loadDraft, saveDraft, clearDraft } from '../lib/drafts.js'
import styles from './Dashboard.module.css'

const MACRO_FIELDS = [
  { key: 'kcal',    label: 'Kcal',    unit: '',  higherIsBad: true },
  { key: 'protein', label: 'Protein', unit: 'g', higherIsBad: false },
  { key: 'carbs',   label: 'Carbs',   unit: 'g', higherIsBad: true },
  { key: 'fat',     label: 'Fat',     unit: 'g', higherIsBad: true },
  { key: 'sugar',   label: 'Sugar',   unit: 'g', higherIsBad: true },
  { key: 'salt',    label: 'Salt',    unit: 'g', higherIsBad: true },
]

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

export default function Dashboard() {
  const { profile, updateProfile } = useAppStore()
  const navigate = useNavigate()
  const [todayLog, setTodayLog] = useState(null)
  const [yesterdayLog, setYesterdayLog] = useState(null)
  const [weekWeights, setWeekWeights] = useState({ thisWeek: [], lastWeek: [] })
  const [todaySchedule, setTodaySchedule] = useState(null)
  const [lastWeighed, setLastWeighed] = useState(null)
  const [loaded, setLoaded] = useState(false)   // first load done (avoids flashing the welcome card)
  const [showBF, setShowBF] = useState(false)
  // Starts empty (or from an unsaved draft); saving merges into today and clears it again
  const [form, setForm] = useState(() => {
    const d = loadDraft('home')
    return d && d.date === today() ? { ...emptyEntry(today()), ...d } : emptyEntry(today())
  })
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  // Keep what's typed so it survives switching tabs or closing the app
  useEffect(() => {
    if (entryHasData(form)) saveDraft('home', form)
    else clearDraft('home')
  }, [form])

  const loadToday = async () => setTodayLog(await getLog(today()))

  // Weigh-ins this week (Mon→today) and last week (full Mon→Sun)
  const loadWeek = async () => {
    const daysFromMonday = (new Date().getDay() + 6) % 7   // Sun=0 -> 6, Mon=1 -> 0, ...
    const weekStart = daysAgo(daysFromMonday)
    const lastWeekStart = daysAgo(daysFromMonday + 7)
    const weighed = (await getLogs(lastWeekStart, today())).filter(l => Number.isFinite(l.weight))
    setWeekWeights({
      thisWeek: weighed.filter(l => l.date >= weekStart).map(l => l.weight),
      lastWeek: weighed.filter(l => l.date < weekStart).map(l => l.weight),
    })
  }

  useEffect(() => {
    const load = async () => {
      const t = today()
      const yDate = daysAgo(1)

      const [tLog, yLog, schedule, latestWeighed] = await Promise.all([
        getLog(t),
        getLog(yDate),
        getSchedule(),
        getLatestWeighedLog(),
        loadWeek(),
      ])

      setTodayLog(tLog)
      setYesterdayLog(yLog)
      setLastWeighed(latestWeighed)

      const day = new Date().getDay()
      setTodaySchedule(schedule.find(s => s.day === day))
      setLoaded(true)
    }
    load()
  }, [])

  const flash = (msg) => {
    setSavedMsg(msg)
    setTimeout(() => setSavedMsg(m => (m === msg ? '' : m)), 5000)
  }

  const handleSave = async () => {
    if (!entryHasData(form)) { flash('Nothing to save — fill in at least one value.'); return }
    const invalid = invalidEntryFields(form)
    if (invalid.length) { flash(`Check ${invalid.join(', ')} — values can't be negative.`); return }
    setSaving(true)
    const entry = coerceEntryFields({ ...form, date: today() })
    entry.goalsSnapshot = snapshotSettings(profile)   // goals + colour rules in force today
    await mergeLog(entry)          // filled fields update today, empty ones keep what's there
    await Promise.all([loadToday(), loadWeek()])
    setLastWeighed(await getLatestWeighedLog())
    clearDraft('home')
    setForm(emptyEntry(today()))   // clear the fields so it's obvious it went through
    flash(`✓ Saved for today`)
    setSaving(false)
  }

  const daysInPhase = daysSince(profile?.phaseStartDate)

  // Latest known weight across all history (today's takes priority if logged)
  const latestWeight = Number.isFinite(todayLog?.weight)
    ? todayLog.weight
    : (Number.isFinite(lastWeighed?.weight) ? lastWeighed.weight : null)

  // This week's average weight vs last week's — averages smooth out water weight.
  // Hidden until both weeks have at least 2 weigh-ins (so not on a fresh install).
  const avg = (arr) => arr.reduce((s, w) => s + w, 0) / arr.length
  const { thisWeek, lastWeek } = weekWeights
  const weekAvgReady = thisWeek.length >= 2 && lastWeek.length >= 2
  const thisWeekAvg = weekAvgReady ? avg(thisWeek) : null
  const lastWeekAvg = weekAvgReady ? avg(lastWeek) : null
  const weightChange = weekAvgReady ? thisWeekAvg - lastWeekAvg : null

  // Judged by the goals + colour rules of the phase it was logged in
  const yJudge = yesterdayLog ? judgeConfigForLog(profile, yesterdayLog) : null

  const activePhase = resolvePhase(profile)

  return (
    <Layout
      title="Home"
      right={<span className={styles.phaseBadge}>{activePhase.name} · Day {daysInPhase}</span>}
    >
      {/* Phase banner */}
      <div className={`${styles.phaseBanner} ${styles[phaseClass(activePhase.baseType)]}`}>
        <div>
          <div className={styles.phaseTitle}>{activePhase.name}</div>
          <div className={styles.phaseSub}>{activePhase.description || `Day ${daysInPhase}`}</div>
        </div>
        {latestWeight != null && (
          <div className={styles.currentWeight}>
            {latestWeight}<span className={styles.kgLabel}> kg</span>
          </div>
        )}
      </div>

      {/* First-time welcome: only for someone who hasn't logged a weight yet, until dismissed */}
      {loaded && !profile?.onboardingDone && !lastWeighed && !todayLog && (
        <div className={styles.section}>
          <div className={styles.welcome}>
            <div className={styles.welcomeTitle}>Welcome 👋 Getting started</div>
            <ol className={styles.welcomeList}>
              <li><button className={styles.welcomeLink} onClick={() => navigate('/settings')}>Settings</button> — pick your phase (cut, bulk or maintain) and set your daily targets.</li>
              <li><button className={styles.welcomeLink} onClick={() => navigate('/exercises')}>Gym</button> — tap <strong>+ Session</strong> to make your workout days and add exercises. Log one top set per exercise; the app suggests your next set.</li>
              <li>Here on Home — log your weight each morning (before eating) and your food at the end of the day.</li>
            </ol>
            <div className={styles.welcomeNote}>
              Tracked things in a notes app before? <button className={styles.welcomeLink} onClick={() => navigate('/data')}>Data</button> → Import from old notes.
              {import.meta.env.MODE === 'server'
                ? 'Your data is stored on your own server.'
                : 'Everything stays on this phone only — export a backup now and then (Data tab).'}
            </div>
            <button className={styles.welcomeBtn} onClick={() => updateProfile({ onboardingDone: true })}>Got it</button>
          </div>
        </div>
      )}

      {/* Yesterday summary */}
      {yesterdayLog && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Previous entry</div>
          <div className={styles.yesterdayCard}>
            <div className={styles.yDate}>{formatDate(yesterdayLog.date)}</div>
            <div className={styles.yWeight}>{yesterdayLog.weight != null ? `${yesterdayLog.weight} kg` : '—'}</div>
            <div className={styles.macroRow}>
              {MACRO_FIELDS.map(mf => {
                const val = yesterdayLog[mf.key]
                const goal = yJudge.goals[mf.key]
                if (val == null) return null
                const color = goal ? macroColor(val, goal, yJudge.modes[mf.key], yJudge.green, yJudge.amber) : 'neutral'
                return (
                  <div key={mf.key} className={`${styles.macroVal} ${styles[color]}`}>
                    <span className={styles.macroLbl}>{mf.label}</span>
                    <span className={styles.macroNum}>{val}{mf.unit}</span>
                    {goal && <span className={styles.macroGoal}>/{goal}{mf.unit}</span>}
                  </div>
                )
              })}
            </div>
            {yesterdayLog.sleep != null && yesterdayLog.sleep < 8 && (
              <div className={styles.sleepNote}>⚠ {yesterdayLog.sleep}h sleep logged.</div>
            )}
          </div>
        </div>
      )}

      {/* Quick entry */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Today's entry</div>
        <div className={styles.entryCard}>
          {todayLog && (
            <div className={styles.loggedNote}>
              ✓ Today is logged{Number.isFinite(todayLog.weight) ? ` (${todayLog.weight} kg)` : ''} — anything you fill in updates it.
            </div>
          )}
          <div className={styles.entryHeader}>
            <span className={styles.entryDate}>{formatDate(today())}</span>
            <button className={styles.bfToggle} onClick={() => setShowBF(v => !v)}>{showBF ? '− BF%' : '+ BF%'}</button>
          </div>
          <div className={styles.grid3}>
            <Field label="Weight (kg)" value={form.weight} onChange={v => setForm(f => ({ ...f, weight: v }))} placeholder="82.1" step="0.1" />
            <Field label="Sleep (h)" value={form.sleep} onChange={v => setForm(f => ({ ...f, sleep: v }))} placeholder="8.0" step="0.5" />
            <Field label="Steps" value={form.steps} onChange={v => setForm(f => ({ ...f, steps: v }))} placeholder="8000" />
          </div>
          <div className={styles.macroTitle}>Macros</div>
          <div className={styles.grid3}>
            {MACRO_FIELDS.map(mf => (
              <Field key={mf.key} label={mf.label} value={form[mf.key]} onChange={v => setForm(f => ({ ...f, [mf.key]: v }))} placeholder="" />
            ))}
          </div>
          {showBF && (
            <div className={styles.grid2} style={{ marginTop: 8 }}>
              <Field label="Body fat %" value={form.bf} onChange={v => setForm(f => ({ ...f, bf: v }))} placeholder="18.5" step="0.1" />
            </div>
          )}
          <div className={styles.noteRow}>
            <input
              className={styles.noteInput}
              placeholder="Note (optional)"
              value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
            />
            <button
              className={`${styles.sickBtn} ${form.important ? styles.sickActive : ''}`}
              onClick={() => setForm(f => ({ ...f, important: !f.important }))}
            >{form.important ? '🔴 Important' : '+ Important'}</button>
          </div>
          {savedMsg && <div className={styles.savedMsg}>{savedMsg}</div>}
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : todayLog ? 'Update today' : 'Save entry'}
          </button>
        </div>
      </div>

      {/* Week stats */}
      {weightChange != null && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>This week</div>
          <div className={styles.statRow}>
            <div className={styles.stat}>
              <div className={styles.statVal} style={{ color: 'var(--blue)' }}>
                {weightChange > 0 ? '+' : ''}{weightChange.toFixed(2)} kg
              </div>
              <div className={styles.statLbl}>vs last week (weekly averages)</div>
              <div className={styles.statSub}>
                {thisWeekAvg.toFixed(1)} kg avg ({thisWeek.length} days) · last week {lastWeekAvg.toFixed(1)} kg ({lastWeek.length} days)
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Today's workout */}
      {todaySchedule && todaySchedule.type !== 'rest' && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Today</div>
          <div className={styles.workoutCard}>
            <div>
              <div className={styles.workoutLabel}>{todaySchedule.label}</div>
              <div className={styles.workoutType}>{todaySchedule.type}</div>
            </div>
            {todaySchedule.type === 'gym' && (
              <button className={styles.logBtn} onClick={() => navigate('/exercises')}>Log session →</button>
            )}
          </div>
        </div>
      )}
    </Layout>
  )
}

function Field({ label, value, onChange, placeholder, step = 'any' }) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>{label}</label>
      <input className={styles.fieldInput} type="number" step={step} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}
