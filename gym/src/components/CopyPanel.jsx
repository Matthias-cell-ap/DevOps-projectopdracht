import { useState, useEffect } from 'react'
import { getAllExercises, getAllSessions, getAllPRs, getAllGoals, getSessionTypes } from '../db/dal.js'
import { COPY_TARGETS, buildCopyText } from '../lib/exports.js'
import { copyToClipboard } from '../lib/clipboard.js'
import { phaseRanges } from '../lib/phases.js'
import { today } from '../lib/utils.js'
import styles from './CopyPanel.module.css'

// Pick any combination of data, periods and specific exercises, then copy as text —
// optionally wrapped with an explanation for pasting into an AI chat.
export default function CopyPanel({ profile }) {
  const [targets, setTargets] = useState(['dailyLogs'])
  const [forAI, setForAI] = useState(false)
  const [allTime, setAllTime] = useState(true)
  const [periodIds, setPeriodIds] = useState([])   // phase ranges and/or 'custom'
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [allExercises, setAllExercises] = useState(true)
  const [pickedIds, setPickedIds] = useState([])
  const [exerciseOptions, setExerciseOptions] = useState([])
  const [splits, setSplits] = useState([])
  const [search, setSearch] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // Only offer exercises that actually have logged sets, a PR or a goal
  useEffect(() => {
    Promise.all([getAllExercises(), getAllSessions(), getAllPRs(), getAllGoals(), getSessionTypes()]).then(([ex, sessions, prs, goals, types]) => {
      const withData = new Set([...sessions, ...prs, ...goals].map(x => x.exerciseId))
      setExerciseOptions(ex.filter(e => withData.has(e.id)))
      // Each split's exercises that have something to copy
      setSplits(types.map(t => ({ id: t.id, name: t.name, ids: t.exerciseIds.filter(id => withData.has(id)) })))
    })
  }, [])

  const chosen = COPY_TARGETS.filter(t => targets.includes(t.id))
  const needsPeriod = chosen.some(t => t.usesPeriod)
  const needsExercises = chosen.some(t => t.usesExercises)

  const ranges = phaseRanges(profile, today())
  // Every ticked period becomes its own block in the copied text
  const customPeriod = customFrom || customTo ? { from: customFrom || null, to: customTo || null, label: 'Custom' } : null
  const periods = allTime ? null : [
    ...ranges.filter(r => periodIds.includes(r.id)).map(r => ({ from: r.from, to: r.to, label: r.name })),
    ...(periodIds.includes('custom') && customPeriod ? [customPeriod] : []),
  ]
  const togglePeriod = (id) =>
    setPeriodIds(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))

  const toggleTarget = (id) =>
    setTargets(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]))
  const togglePick = (id) =>
    setPickedIds(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))

  // A split is "on" when all its exercises are picked. Tapping adds them all, or removes them all.
  const splitOn = (s) => !allExercises && s.ids.length > 0 && s.ids.every(id => pickedIds.includes(id))
  const toggleSplit = (s) => {
    const on = splitOn(s)
    setAllExercises(false)
    setPickedIds(p => (on ? p.filter(id => !s.ids.includes(id)) : [...new Set([...p, ...s.ids])]))
  }

  const visibleExercises = exerciseOptions.filter(e => !search || e.name.toLowerCase().includes(search.toLowerCase()))
  const exerciseFilterInvalid = needsExercises && !allExercises && pickedIds.length === 0
  const periodFilterInvalid = needsPeriod && !allTime && periods.length === 0
  const canCopy = targets.length > 0 && !exerciseFilterInvalid && !periodFilterInvalid && !busy

  const handleCopy = async () => {
    setBusy(true)
    try {
      const text = await buildCopyText({
        targets,
        periods: needsPeriod ? periods : null,
        exerciseIds: needsExercises && !allExercises ? pickedIds : null,
        forAI,
      })
      await copyToClipboard(text)
      setMsg(forAI
        ? `✓ Copied ${text.split('\n').length} lines — paste it into an AI chat and type your question at the end`
        : `✓ Copied ${text.split('\n').length} lines`)
    } catch (e) {
      setMsg('Copy failed: ' + (e?.message ?? e))
    }
    setBusy(false)
  }

  return (
    <div className={styles.panel}>
      <label className={`${styles.check} ${styles.aiToggle}`}>
        <input type="checkbox" checked={forAI} onChange={() => setForAI(v => !v)} />
        <span>
          <strong>For an AI chat</strong>
          <span className={styles.sub}>Adds a short explanation of how to read your data and ends with "My question:" — paste it into ChatGPT, Claude, … and ask away.</span>
        </span>
      </label>

      <div className={styles.label}>What to copy</div>
      {COPY_TARGETS.map(t => (
        <label key={t.id} className={styles.check}>
          <input type="checkbox" checked={targets.includes(t.id)} onChange={() => toggleTarget(t.id)} />
          <span>{t.label}</span>
        </label>
      ))}

      {needsPeriod && (
        <>
          <div className={styles.label}>Periods <span className={styles.hint}>· daily logs &amp; exercise history</span></div>
          <div className={styles.segment}>
            <button className={allTime ? styles.segOn : ''} onClick={() => setAllTime(true)}>All time</button>
            <button className={!allTime ? styles.segOn : ''} onClick={() => setAllTime(false)}>
              Choose{!allTime && periods.length ? ` (${periods.length})` : ''}
            </button>
          </div>
          {!allTime && (
            <div className={styles.exList}>
              {ranges.map(r => (
                <label key={r.id} className={styles.check}>
                  <input type="checkbox" checked={periodIds.includes(r.id)} onChange={() => togglePeriod(r.id)} />
                  <span>{r.label}</span>
                </label>
              ))}
              <label className={styles.check}>
                <input type="checkbox" checked={periodIds.includes('custom')} onChange={() => togglePeriod('custom')} />
                <span>Custom dates…</span>
              </label>
              {periodIds.includes('custom') && (
                <div className={styles.dates} style={{ marginBottom: 8 }}>
                  <input className={styles.date} type="date" max={today()} value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                  <span className={styles.hint}>to</span>
                  <input className={styles.date} type="date" max={today()} value={customTo} onChange={e => setCustomTo(e.target.value)} />
                </div>
              )}
            </div>
          )}
          {!allTime && periods.length > 1 && (
            <div className={styles.hint} style={{ marginTop: 6 }}>Each period is copied as its own block with its own averages.</div>
          )}
        </>
      )}

      {needsExercises && (
        <>
          <div className={styles.label}>Exercises <span className={styles.hint}>· exercise history &amp; PRs</span></div>
          <div className={styles.segment}>
            <button className={allExercises ? styles.segOn : ''} onClick={() => setAllExercises(true)}>All exercises</button>
            <button className={!allExercises ? styles.segOn : ''} onClick={() => setAllExercises(false)}>
              Choose{!allExercises && pickedIds.length ? ` (${pickedIds.length})` : ''}
            </button>
          </div>
          {splits.length > 0 && (
            <div className={styles.splitRow}>
              <span className={styles.hint}>Whole split:</span>
              {splits.map(s => (
                <button
                  key={s.id}
                  className={`${styles.splitChip} ${splitOn(s) ? styles.splitOn : ''}`}
                  disabled={s.ids.length === 0}
                  onClick={() => toggleSplit(s)}
                  title={s.ids.length === 0 ? 'Nothing logged in this split yet' : undefined}
                >
                  {splitOn(s) ? '✓ ' : ''}{s.name}
                </button>
              ))}
            </div>
          )}
          {!allExercises && (
            <>
              <input className={styles.select} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
              <div className={styles.exList}>
                {visibleExercises.map(e => (
                  <label key={e.id} className={styles.check}>
                    <input type="checkbox" checked={pickedIds.includes(e.id)} onChange={() => togglePick(e.id)} />
                    <span>{e.name}</span>
                    <span className={styles.muscle}>{e.muscleGroup}</span>
                  </label>
                ))}
                {exerciseOptions.length === 0 && <div className={styles.hint}>No exercises with logged data yet.</div>}
              </div>
            </>
          )}
        </>
      )}

      <div className={styles.footer}>
        {msg && <div className={styles.msg}>{msg}</div>}
        {exerciseFilterInvalid && <div className={styles.hint} style={{ marginBottom: 8 }}>Pick at least one exercise.</div>}
        {periodFilterInvalid && <div className={styles.hint} style={{ marginBottom: 8 }}>Pick at least one period (custom needs a date).</div>}
        <button className={styles.copyBtn} disabled={!canCopy} onClick={handleCopy}>
          {busy ? 'Copying…' : forAI ? '⧉ Copy for AI chat' : `⧉ Copy ${targets.length > 1 ? `${targets.length} items` : ''}`.trim()}
        </button>
      </div>
    </div>
  )
}
