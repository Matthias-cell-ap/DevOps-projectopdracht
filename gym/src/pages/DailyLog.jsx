import { useState, useEffect, useCallback, useRef } from 'react'
import Layout from '../components/Layout.jsx'
import { getLogs, getLog, saveLog, mergeLog, getAllLogs } from '../db/dal.js'
import { useAppStore } from '../store/useAppStore.js'
import { loadDraft, saveDraft, clearDraft } from '../lib/drafts.js'
import {
  macroColor, judgeConfigForLog, snapshotSettings, today, formatDate, toLocalISODate, averageLogs,
  emptyEntry, entryHasData, coerceEntryFields, invalidEntryFields,
} from '../lib/utils.js'
import { resolvePhase, phaseEnd, historyName } from '../lib/phases.js'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, CartesianGrid
} from 'recharts'
import styles from './DailyLog.module.css'

const MACRO_FIELDS = [
  { key: 'kcal',    label: 'Kcal',    unit: '',  higherIsBad: true },
  { key: 'protein', label: 'Protein', unit: 'g', higherIsBad: false },
  { key: 'carbs',   label: 'Carbs',   unit: 'g', higherIsBad: true },
  { key: 'fat',     label: 'Fat',     unit: 'g', higherIsBad: true },
  { key: 'sugar',   label: 'Sugar',   unit: 'g', higherIsBad: true },
  { key: 'salt',    label: 'Salt',    unit: 'g', higherIsBad: true },
]

const EMPTY_FORM = emptyEntry
const hasTyped = entryHasData

// Metrics that can be plotted. Weight is the default and owns the left axis.
const METRICS = [
  { key: 'weight',  label: 'Weight',  unit: 'kg',    color: 'var(--blue)' },
  { key: 'kcal',    label: 'Kcal',    unit: '',      color: '#f59e0b' },
  { key: 'protein', label: 'Protein', unit: 'g',     color: '#22c55e' },
  { key: 'carbs',   label: 'Carbs',   unit: 'g',     color: '#a78bfa' },
  { key: 'fat',     label: 'Fat',     unit: 'g',     color: '#ef4444' },
  { key: 'sugar',   label: 'Sugar',   unit: 'g',     color: '#ec4899' },
  { key: 'salt',    label: 'Salt',    unit: 'g',     color: '#14b8a6' },
  { key: 'steps',   label: 'Steps',   unit: '',      color: '#38bdf8' },
  { key: 'sleep',   label: 'Sleep',   unit: 'h',     color: '#c084fc' },
  { key: 'bf',      label: 'BF%',     unit: '%',     color: '#fb923c' },
]

function NoteDot({ cx, cy, payload }) {
  // Only mark days flagged as important — ordinary notes no longer show on the graph
  if (cx == null || cy == null || !payload?.important) return null
  return <circle cx={cx} cy={cy} r={4.5} fill="var(--red)" stroke="var(--bg)" strokeWidth={1.5} />
}

// Linear interpolation for missing weight values
function interpolateWeights(logs, from, to) {
  if (!logs.length) return []
  // Clamp the day range to actual data so huge ranges (e.g. All time) can't
  // generate tens of thousands of empty days and freeze the UI
  const dates = logs.map(l => l.date).sort()
  if (from < dates[0]) from = dates[0]
  const lastDate = dates[dates.length - 1]
  if (to > lastDate && to > today()) to = lastDate

  const weightMap = {}
  for (const l of logs) {
    if (Number.isFinite(l.weight)) weightMap[l.date] = l.weight
  }
  const importantMap = {}
  const noteTextMap = {}
  const byDate = {}
  for (const l of logs) {
    if (l.important || l.sick) importantMap[l.date] = true
    if (l.note) noteTextMap[l.date] = l.note
    byDate[l.date] = l
  }
  // Non-weight metrics are plotted as-is (no interpolation) so gaps stay honest
  const extras = (date) => {
    const l = byDate[date]
    const out = {}
    for (const m of METRICS) {
      if (m.key === 'weight') continue
      out[m.key] = Number.isFinite(l?.[m.key]) ? l[m.key] : null
    }
    return out
  }

  const days = []
  const cursor = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  while (cursor <= end) {
    days.push(toLocalISODate(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }

  return days.map((date, i) => {
    if (weightMap[date] != null) {
      return { date: date.slice(5), fullDate: date, weight: weightMap[date], actual: true, important: !!importantMap[date], note: noteTextMap[date] ?? null, ...extras(date) }
    }
    // Find nearest known before and after
    let prevDate = null, prevWeight = null, nextDate = null, nextWeight = null
    for (let j = i - 1; j >= 0; j--) {
      if (weightMap[days[j]] != null) { prevDate = days[j]; prevWeight = weightMap[days[j]]; break }
    }
    for (let j = i + 1; j < days.length; j++) {
      if (weightMap[days[j]] != null) { nextDate = days[j]; nextWeight = weightMap[days[j]]; break }
    }
    let weight = null
    if (prevWeight != null && nextWeight != null) {
      const total = new Date(nextDate + 'T00:00:00') - new Date(prevDate + 'T00:00:00')
      const elapsed = new Date(date + 'T00:00:00') - new Date(prevDate + 'T00:00:00')
      weight = parseFloat((prevWeight + (nextWeight - prevWeight) * (elapsed / total)).toFixed(2))
    } else if (prevWeight != null) {
      weight = prevWeight
    } else if (nextWeight != null) {
      weight = nextWeight
    }
    return { date: date.slice(5), fullDate: date, weight, actual: false, important: false, note: null, ...extras(date) }
  })
}

function buildPhaseOptions(profile) {
  if (!profile) return []
  // Resolve the active phase so custom phases show their chosen name, not "custom-12345"
  const active = resolvePhase(profile)
  const options = [
    {
      id: 'current',
      name: active.name,
      label: `${active.name} (current)`,
      from: profile.phaseStartDate,
      to: today(),
    }
  ]
  const history = [...(profile.phaseHistory ?? [])].reverse()
  history.forEach((h, i) => {
    const nm = historyName(h)
    const to = phaseEnd(h)   // the switch day belongs to the next phase
    options.push({ id: `h${i}`, name: nm, label: `${nm} (${h.from} – ${to})`, from: h.from, to })
  })
  options.push({ id: 'all', name: 'All time', label: 'All time', from: null, to: null })
  options.push({ id: 'custom', name: 'Custom', label: 'Custom', from: null, to: null })
  return options
}

// Options that can't be combined with phase toggles
const EXCLUSIVE_IDS = ['all', 'custom']

export default function DailyLog() {
  const { profile } = useAppStore()
  const [logs, setLogs] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [showBF, setShowBF] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM(today()))
  const [editing, setEditing] = useState(false)       // true = "Edit this entry" (full replace)
  const [dateHasEntry, setDateHasEntry] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  const [graphExpanded, setGraphExpanded] = useState(false)
  const [selectedIds, setSelectedIds] = useState(['current'])
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showStats, setShowStats] = useState(false)
  // Weight is always shown at launch; extra metrics overlay on a right-hand axis
  const [activeMetrics, setActiveMetrics] = useState(['weight'])

  const toggleMetric = (key) => {
    setActiveMetrics(prev =>
      prev.includes(key)
        ? (prev.length === 1 ? prev : prev.filter(k => k !== key))
        : [...prev, key]
    )
  }

  const phaseOptions = buildPhaseOptions(profile)
  const isAll = selectedIds.includes('all')
  const isCustom = selectedIds.includes('custom')
  const selectedPhases = phaseOptions.filter(p => selectedIds.includes(p.id) && p.from)

  // Toggle a phase on/off; 'all' and 'custom' are exclusive selections
  const togglePhase = (id) => {
    if (EXCLUSIVE_IDS.includes(id)) { setSelectedIds([id]); return }
    setSelectedIds(prev => {
      const phasesOnly = prev.filter(p => !EXCLUSIVE_IDS.includes(p))
      return phasesOnly.includes(id)
        ? phasesOnly.filter(p => p !== id)
        : [...phasesOnly, id]
    })
  }

  // Overall date range covering everything toggled on
  let rangeFromAll = null, rangeToAll = null
  if (isCustom) {
    rangeFromAll = customFrom || null
    rangeToAll = customTo || null
  } else if (!isAll && selectedPhases.length) {
    rangeFromAll = selectedPhases.map(p => p.from).sort()[0]
    rangeToAll = selectedPhases.map(p => p.to).sort().slice(-1)[0]
  }

  // Phase ranges toggled on, as a stable key for the loader below
  const phaseRangesKey = selectedPhases.map(p => `${p.from}|${p.to}`).join(',')

  const load = useCallback(async () => {
    let data = []
    if (isAll) {
      data = await getAllLogs()
    } else if (rangeFromAll && rangeToAll) {
      data = await getLogs(rangeFromAll, rangeToAll)
      // With several phases toggled, keep only days inside them — not a phase in between
      if (!isCustom && phaseRangesKey) {
        const ranges = phaseRangesKey.split(',').map(r => r.split('|'))
        data = data.filter(l => ranges.some(([from, to]) => l.date >= from && l.date <= to))
      }
    }
    setLogs(data.sort((a, b) => b.date.localeCompare(a.date)))
  }, [isAll, isCustom, rangeFromAll, rangeToAll, phaseRangesKey])

  useEffect(() => { load() }, [load])

  // Restore an unsaved entry (survives tab switches and closing the app)
  useEffect(() => {
    const d = loadDraft('log')
    if (d?.form) {
      setForm({ ...EMPTY_FORM(d.form.date ?? today()), ...d.form })
      setEditing(!!d.editing)
      setRangeMode(!!d.rangeMode)
      setRangeFrom(d.rangeFrom ?? '')
      setRangeTo(d.rangeTo ?? '')
      setShowForm(true)
    }
    setDraftLoaded(true)
  }, [])

  // Save the draft on every change; drop it once there's nothing typed
  useEffect(() => {
    if (!draftLoaded) return
    if (editing || hasTyped(form)) saveDraft('log', { form, editing, rangeMode, rangeFrom, rangeTo })
    else clearDraft('log')
  }, [draftLoaded, form, editing, rangeMode, rangeFrom, rangeTo])

  // Tell the user when the chosen day is already logged (new values will be merged in)
  useEffect(() => {
    if (editing || rangeMode) { setDateHasEntry(false); return }
    let alive = true
    getLog(form.date).then(e => { if (alive) setDateHasEntry(!!e) }).catch(() => {})
    return () => { alive = false }
  }, [form.date, editing, rangeMode, logs])

  const handleDateChange = (date) => setForm(f => ({ ...f, date }))

  const handleEditEntry = (log) => {
    setRangeMode(false)
    setEditing(true)
    setForm({ ...EMPTY_FORM(log.date), ...log })
    setShowForm(true)
    setSavedMsg('')
    // Scroll to top so the form is visible
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const resetForm = () => {
    setForm(EMPTY_FORM(today()))
    setEditing(false)
    setRangeMode(false)
    setRangeFrom('')
    setRangeTo('')
    clearDraft('log')
  }

  const flash = (msg) => {
    setSavedMsg(msg)
    setTimeout(() => setSavedMsg(m => (m === msg ? '' : m)), 5000)
  }

  const coerceEntry = (raw) => {
    const entry = coerceEntryFields(raw)
    // Goal snapshot keeps a day's colours right after goals change. An edited entry keeps
    // the snapshot it was logged with; a brand-new day takes today's goals.
    entry.goalsSnapshot = raw.goalsSnapshot ?? snapshotSettings(profile)
    return entry
  }

  const handleSave = async () => {
    if (!editing && !hasTyped(form)) { flash('Nothing to save — fill in at least one value.'); return }
    if (!form.date || form.date > today()) { flash('Pick a valid date (today or earlier).'); return }
    const invalid = invalidEntryFields(form)
    if (invalid.length) { flash(`Check ${invalid.join(', ')} — values can't be negative.`); return }
    setSaving(true)
    const entry = coerceEntry(form)
    if (editing) await saveLog(entry)   // edit: replace, so values can also be cleared
    else await mergeLog(entry)          // new: filled fields update the day, the rest stays
    await load()
    flash(`✓ ${editing ? 'Updated' : 'Saved'} ${formatDate(entry.date)}`)
    resetForm()                          // clear the fields so it's obvious it went through
    setSaving(false)
  }

  const handleRangeSave = async () => {
    if (!rangeFrom || !rangeTo || rangeFrom > rangeTo) return
    const invalid = invalidEntryFields(form)
    if (invalid.length) { flash(`Check ${invalid.join(', ')} — values can't be negative.`); return }
    setSaving(true)
    const base = coerceEntry({ ...form, goalsSnapshot: undefined })
    // Range mode only shows macros — never copy hidden per-day values onto every day
    delete base.weight
    delete base.sleep
    delete base.steps
    delete base.bf
    const cursor = new Date(rangeFrom + 'T00:00:00')
    const end = new Date(rangeTo + 'T00:00:00')
    let added = 0, skipped = 0
    while (cursor <= end) {
      const date = toLocalISODate(cursor)
      const existing = await getLog(date)
      if (!existing) { await saveLog({ ...base, date }); added++ } else skipped++
      cursor.setDate(cursor.getDate() + 1)
    }
    await load()
    flash(`✓ Saved ${added} day${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already logged, left as they were)` : ''}`)
    resetForm()
    setSaving(false)
  }

  const entryRefs = useRef({})
  const [highlighted, setHighlighted] = useState(null)

  const yMin = profile?.graphYMin ? parseFloat(profile.graphYMin) : 'auto'
  const yMax = profile?.graphYMax ? parseFloat(profile.graphYMax) : 'auto'

  // Chart range: All time spans the data itself (interpolateWeights clamps),
  // custom uses the pickers, phases use the combined toggled range
  const chartFrom = isAll ? (logs.length ? logs[logs.length - 1].date : null) : rangeFromAll
  const chartTo = isAll ? (logs.length ? logs[0].date : null) : rangeToAll
  const baseData = chartFrom && chartTo ? interpolateWeights(logs, chartFrom, chartTo) : []

  // Multi-phase mode: give each toggled phase its own data key so it renders as its own line
  const multiPhase = !isAll && !isCustom && selectedPhases.length > 0
  const chartData = multiPhase
    ? baseData.map(d => {
        const row = { ...d }
        for (const p of selectedPhases) {
          row['w_' + p.id] = (d.fullDate >= p.from && d.fullDate <= p.to) ? d.weight : null
        }
        return row
      })
    : baseData

  // Optional: rolling average trend line + rate of change (enabled in Settings)
  const trendDays = parseInt(profile?.trendDays) || 7
  const showTrend = !!profile?.showTrendLine
  const showRate = !!profile?.showRateOfChange

  if (showTrend) {
    for (let i = 0; i < chartData.length; i++) {
      const window = chartData.slice(Math.max(0, i - trendDays + 1), i + 1)
      const vals = window.map(d => d.weight).filter(Number.isFinite)
      chartData[i].trend = vals.length
        ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2))
        : null
    }
  }

  // kg/week: average of the first few days vs average of the last few days, so a single
  // water-heavy morning can't swing it. Only real weigh-ins count (no estimated days).
  let ratePerWeek = null
  let rateWindow = null
  if (showRate) {
    const toDays = (iso) => new Date(iso + 'T00:00:00').getTime() / 86400000
    const pts = logs
      .filter(l => Number.isFinite(l.weight))
      .map(l => ({ t: toDays(l.date), w: l.weight }))
      .sort((a, b) => a.t - b.t)
    if (pts.length >= 4) {
      const span = pts[pts.length - 1].t - pts[0].t
      // Window = smoothing setting, shrunk for short ranges so the two ends never overlap
      const win = Math.max(1, Math.min(trendDays, Math.floor(span / 3)))
      const first = pts.filter(p => p.t < pts[0].t + win)
      const last = pts.filter(p => p.t > pts[pts.length - 1].t - win)
      const mean = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length
      const days = mean(last, 't') - mean(first, 't')
      if (days >= 3) {
        ratePerWeek = ((mean(last, 'w') - mean(first, 'w')) / days) * 7
        rateWindow = win
      }
    }
  }

  const rangeLabel = isAll ? 'All time'
    : isCustom ? 'Custom range'
    : selectedPhases.length ? selectedPhases.map(p => p.name).join(' + ')
    : 'Nothing selected'
  const stats = averageLogs(logs)

  const fmt = (v, digits = 0) => v == null ? '—' : v.toFixed(digits)

  const handleChartClick = useCallback((data) => {
    // Resolve clicked full date from payload, or fall back to the x-axis label (MM-DD)
    let fullDate = data?.activePayload?.[0]?.payload?.fullDate
    if (!fullDate && data?.activeLabel) {
      fullDate = chartData.find(d => d.date === data.activeLabel)?.fullDate
    }
    if (!fullDate) return

    // If graph is expanded as a modal, close it first so the list is visible
    setGraphExpanded(false)

    // Find closest real entry (for interpolated clicks, walk outward from the clicked date)
    let target = entryRefs.current[fullDate]
    if (!target) {
      const sorted = [...logs].sort((a, b) =>
        Math.abs(new Date(a.date + 'T00:00:00') - new Date(fullDate + 'T00:00:00')) -
        Math.abs(new Date(b.date + 'T00:00:00') - new Date(fullDate + 'T00:00:00'))
      )
      for (const l of sorted) {
        if (entryRefs.current[l.date]) { target = entryRefs.current[l.date]; break }
      }
    }
    if (!target) return

    // Defer scroll so the modal close has committed to the DOM
    const date = target.dataset.date
    requestAnimationFrame(() => {
      entryRefs.current[date]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    setHighlighted(date)
    setTimeout(() => setHighlighted(null), 1500)
  }, [logs, chartData])

  const showWeight = activeMetrics.includes('weight')
  const otherMetrics = METRICS.filter(m => m.key !== 'weight' && activeMetrics.includes(m.key))

  const GraphContent = ({ height = 130, showGrid = false }) => (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 6, right: otherMetrics.length ? 4 : 4, left: -28, bottom: 0 }} onClick={handleChartClick} style={{ cursor: 'pointer' }}>
        {showGrid && <CartesianGrid stroke="var(--border)" strokeOpacity={0.5} />}
        <XAxis dataKey="date" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        {/* Left axis = weight, right axis = everything else (different scales) */}
        <YAxis yAxisId="left" domain={[yMin, yMax]} tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickLine={false} axisLine={false} hide={!showWeight} />
        <YAxis yAxisId="right" orientation="right" domain={['auto','auto']} tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickLine={false} axisLine={false} hide={otherMetrics.length === 0} width={34} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12 }}
          formatter={(val, name, props) => {
            const p = props.payload
            const metric = METRICS.find(m => m.label === name || name?.startsWith?.(m.label))
            const unit = metric?.unit ?? ''
            const isWeightLine = name === 'Weight' || String(name).startsWith('Weight')
            const tag = isWeightLine && !p.actual ? ' (est)' : ''
            const noteLine = isWeightLine && p.important
              ? (p.note ? ` — ⚠ ${p.note}` : ' — ⚠ important')
              : ''
            return [`${val}${unit}${tag}${noteLine}`, name]
          }}
        />

        {/* Weight — solid, or one faint dotted line per extra phase */}
        {showWeight && (multiPhase ? selectedPhases.map(p => (
          <Line
            key={p.id}
            yAxisId="left"
            type="monotone"
            dataKey={'w_' + p.id}
            name={`Weight · ${p.name}`}
            stroke="var(--blue)"
            strokeWidth={2}
            strokeDasharray={p.id === 'current' ? undefined : '5 4'}
            strokeOpacity={p.id === 'current' ? 1 : 0.4}
            dot={<NoteDot />}
            activeDot={{ r: 5, fill: 'var(--blue)' }}
          />
        )) : (
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="weight"
            name="Weight"
            stroke="var(--blue)"
            strokeWidth={2}
            dot={<NoteDot />}
            activeDot={{ r: 5, fill: 'var(--blue)' }}
            connectNulls
          />
        ))}

        {/* Optional smoothed weight trend */}
        {showWeight && showTrend && (
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="trend"
            name={`${trendDays}d avg`}
            stroke="var(--blue)"
            strokeWidth={2.5}
            strokeOpacity={0.45}
            dot={false}
            activeDot={false}
            connectNulls
          />
        )}

        {/* Extra metrics on the right axis */}
        {otherMetrics.map(m => (
          <Line
            key={m.key}
            yAxisId="right"
            type="monotone"
            dataKey={m.key}
            name={m.label}
            stroke={m.color}
            strokeWidth={1.8}
            dot={false}
            activeDot={{ r: 4, fill: m.color }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )

  return (
    <Layout
      title="Daily Log"
      right={<button className={styles.addBtn} onClick={() => setShowForm(v => !v)}>+ Entry</button>}
    >
      {/* Graph */}
      <div className={styles.graphCard}>
        <div className={styles.graphTitleRow}>
          <div className={styles.graphTitle}>
            Weight
            <span className={styles.graphLegend}>
              <span className={styles.legendDot} style={{ background: 'var(--red)' }} /> important
            </span>
          </div>
          <button className={styles.expandBtn} onClick={() => setGraphExpanded(true)}>⤢</button>
        </div>

        {/* Phase selector — phases toggle on/off, All time / Custom are exclusive */}
        <div className={styles.phaseScroll}>
          {phaseOptions.map(p => (
            <button
              key={p.id}
              className={`${styles.phaseBtn} ${selectedIds.includes(p.id) ? styles.phaseBtnActive : ''}`}
              onClick={() => togglePhase(p.id)}
            >{p.label}</button>
          ))}
        </div>

        {isCustom && (
          <div className={styles.customRange}>
            <input className={styles.dateInput} type="date" value={customFrom} max={today()} onChange={e => setCustomFrom(e.target.value)} />
            <span className={styles.rangeSep}>–</span>
            <input className={styles.dateInput} type="date" value={customTo} max={today()} onChange={e => setCustomTo(e.target.value)} />
          </div>
        )}

        {/* Metric selector — weight on by default, tap to overlay others */}
        <div className={styles.metricScroll}>
          {METRICS.map(m => {
            const on = activeMetrics.includes(m.key)
            return (
              <button
                key={m.key}
                className={`${styles.metricChip} ${on ? styles.metricOn : ''}`}
                style={on ? { borderColor: m.color, color: m.color, background: 'transparent' } : undefined}
                onClick={() => toggleMetric(m.key)}
              >
                <span className={styles.metricDot} style={{ background: on ? m.color : 'var(--text-dim)' }} />
                {m.label}
              </button>
            )
          })}
        </div>

        <GraphContent height={130} />

        {/* Optional rate of change */}
        {showRate && ratePerWeek != null && (
          <div className={styles.rateRow}>
            <span className={styles.rateVal} style={{ color: ratePerWeek < 0 ? 'var(--green)' : 'var(--amber)' }}>
              {ratePerWeek > 0 ? '+' : ''}{ratePerWeek.toFixed(2)} kg/week
            </span>
            <span className={styles.rateLbl}>
              over {rangeLabel.toLowerCase()} · from {rateWindow}-day averages
            </span>
          </div>
        )}

        {/* Stats bar */}
        <div className={styles.statsBar}>
          <button className={styles.statsBtn} onClick={() => setShowStats(v => !v)}>
            {showStats ? '▲ Averages' : '▼ Averages'}
          </button>
        </div>

        {showStats && (
          <div className={styles.statsPanel}>
            <div className={styles.statsRange}>{rangeLabel} · {stats.total} days</div>
            <div className={styles.statsGrid}>
              <StatCell label="Avg weight" value={fmt(stats.avg.weight, 1)} unit="kg" n={stats.counts.weight} />
              <StatCell label="Avg kcal" value={fmt(stats.avg.kcal)} unit="" n={stats.counts.kcal} />
              <StatCell label="Avg protein" value={fmt(stats.avg.protein)} unit="g" n={stats.counts.protein} />
              <StatCell label="Avg carbs" value={fmt(stats.avg.carbs)} unit="g" n={stats.counts.carbs} />
              <StatCell label="Avg fat" value={fmt(stats.avg.fat)} unit="g" n={stats.counts.fat} />
              <StatCell label="Avg sugar" value={fmt(stats.avg.sugar)} unit="g" n={stats.counts.sugar} />
              <StatCell label="Avg salt" value={fmt(stats.avg.salt, 1)} unit="g" n={stats.counts.salt} />
              <StatCell label="Avg steps" value={fmt(stats.avg.steps)} unit="" n={stats.counts.steps} />
              <StatCell label="Avg sleep" value={fmt(stats.avg.sleep, 1)} unit="h" n={stats.counts.sleep} />
            </div>
          </div>
        )}
      </div>

      {/* Expanded graph modal */}
      {graphExpanded && (
        <div className={styles.graphModal} onClick={() => setGraphExpanded(false)}>
          <div className={styles.graphModalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.graphModalHeader}>
              <span className={styles.graphTitle}>Weight — {rangeLabel}</span>
              <button className={styles.closeBtn} onClick={() => setGraphExpanded(false)}>✕</button>
            </div>
            <GraphContent height={300} showGrid />
          </div>
        </div>
      )}

      {/* Entry form */}
      {showForm && (
        <div className={styles.formCard}>
          {editing ? (
            <div className={styles.editBanner}>
              <span>Editing {formatDate(form.date)}</span>
              <button className={styles.clearLink} onClick={resetForm}>Cancel edit</button>
            </div>
          ) : (
            <div className={styles.modeRow}>
              <button className={`${styles.modeBtn} ${!rangeMode ? styles.modeBtnActive : ''}`} onClick={() => setRangeMode(false)}>Single day</button>
              <button className={`${styles.modeBtn} ${rangeMode ? styles.modeBtnActive : ''}`} onClick={() => setRangeMode(true)}>Date range</button>
            </div>
          )}

          {rangeMode ? (
            <div className={styles.formGrid2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>From</label>
                <input className={styles.dateInput} type="date" max={today()} value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>To</label>
                <input className={styles.dateInput} type="date" max={today()} value={rangeTo} onChange={e => setRangeTo(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className={styles.formHeader}>
              <div className={styles.dateRow}>
                <label className={styles.fieldLabel}>Date</label>
                <input className={styles.dateInput} type="date" value={form.date} max={today()} disabled={editing} onChange={e => handleDateChange(e.target.value)} />
              </div>
              <button className={styles.bfToggle} onClick={() => setShowBF(v => !v)}>{showBF ? '− BF%' : '+ BF%'}</button>
            </div>
          )}

          {dateHasEntry && (
            <div className={styles.mergeNote}>
              This day is already logged — anything you fill in updates it, empty fields keep their current value.
            </div>
          )}

          {!rangeMode && (
            <div className={styles.formGrid3}>
              <Field label="Weight (kg)" value={form.weight} onChange={v => setForm(f => ({ ...f, weight: v }))} placeholder="82.1" step="0.1" />
              <Field label="Sleep (h)" value={form.sleep} onChange={v => setForm(f => ({ ...f, sleep: v }))} placeholder="8.0" step="0.5" />
              <Field label="Steps" value={form.steps} onChange={v => setForm(f => ({ ...f, steps: v }))} placeholder="8000" />
            </div>
          )}

          {rangeMode && <div className={styles.rangeNote}>Macros saved as daily averages. Days already logged are skipped.</div>}

          <div className={styles.macroLabel}>Macros{rangeMode ? ' (averages)' : ''}</div>
          <div className={styles.formGrid3}>
            {MACRO_FIELDS.map(mf => (
              <Field key={mf.key} label={mf.label} value={form[mf.key]} onChange={v => setForm(f => ({ ...f, [mf.key]: v }))} />
            ))}
          </div>

          {!rangeMode && showBF && (
            <div className={styles.formGrid2} style={{ marginTop: 8 }}>
              <Field label="Body fat %" value={form.bf} onChange={v => setForm(f => ({ ...f, bf: v }))} placeholder="18.5" step="0.1" />
            </div>
          )}

          <div className={styles.noteRow}>
            <input className={styles.noteInput} placeholder="Note (optional) — missed workout, travel, illness…" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
            {(() => {
              const isImportant = form.important ?? form.sick ?? false
              return (
                <button className={`${styles.sickBtn} ${isImportant ? styles.sickActive : ''}`} onClick={() => setForm(f => ({ ...f, important: !isImportant }))}>
                  {isImportant ? '🔴 Important' : '+ Important'}
                </button>
              )
            })()}
          </div>

          {savedMsg && <div className={styles.savedMsg}>{savedMsg}</div>}
          <button className={styles.saveBtn} onClick={rangeMode ? handleRangeSave : handleSave} disabled={saving || (rangeMode && (!rangeFrom || !rangeTo))}>
            {saving ? 'Saving…' : rangeMode ? 'Save range' : editing ? 'Save changes' : 'Save entry'}
          </button>
          {!editing && hasTyped(form) && (
            <button className={styles.clearLink} style={{ marginTop: 8 }} onClick={resetForm}>Clear form</button>
          )}
        </div>
      )}

      {/* Log list */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Entries</div>
        {logs.length === 0 && <p className={styles.empty}>No entries in this range.</p>}
        {logs.map(log => (
          <LogEntry
            key={log.date}
            log={log}
            judge={judgeConfigForLog(profile, log)}
            highlighted={highlighted === log.date}
            onEdit={handleEditEntry}
            setRef={el => { if (el) entryRefs.current[log.date] = el; else delete entryRefs.current[log.date] }}
          />
        ))}
      </div>
    </Layout>
  )
}

// judge = the goals + colour rules this day is measured against (its own phase's, not today's)
function LogEntry({ log, judge, highlighted, setRef, onEdit }) {
  const [expanded, setExpanded] = useState(false)
  const goals = judge.goals

  const important = log.important || log.sick

  return (
    <div
      ref={setRef}
      data-date={log.date}
      className={`${styles.entry} ${important ? styles.sickEntry : ''} ${highlighted ? styles.highlighted : ''}`}
      onClick={() => setExpanded(v => !v)}
    >
      <div className={styles.entryRow}>
        <div className={styles.entryLeft}>
          <span className={styles.entryDate}>{formatDate(log.date)}</span>
          {log.note && <span className={styles.noteIndicator}>{important ? '🔴' : '●'} {log.note}</span>}
        </div>
        <div className={styles.entryRight}>
          {important && !log.note && <span className={styles.sickDot}>🔴</span>}
          <span className={styles.entryWeight}>{Number.isFinite(log.weight) ? `${log.weight} kg` : '??'}</span>
          <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className={styles.entryExpanded}>
          <div className={styles.macroRow}>
            {MACRO_FIELDS.map(mf => {
              const val = log[mf.key]
              const goal = goals[mf.key]
              if (val == null) return null
              const color = goal ? macroColor(val, goal, judge.modes[mf.key], judge.green, judge.amber) : 'neutral'
              return <MacroValue key={mf.key} label={mf.label} val={val} goal={goal} unit={mf.unit} color={color} />
            })}
          </div>
          <div className={styles.extraRow}>
            {log.sleep != null && <span className={`${styles.extraVal} ${log.sleep < 8 ? styles.extraWarn : ''}`}>sleep {log.sleep}h</span>}
            {log.steps != null && <span className={styles.extraVal}>👟 {log.steps.toLocaleString()}</span>}
            {log.bf != null && <span className={styles.extraVal}>BF {log.bf}%</span>}
          </div>
          <button
            className={styles.editEntryBtn}
            onClick={(e) => { e.stopPropagation(); onEdit(log) }}
          >Edit this entry</button>
        </div>
      )}
    </div>
  )
}

function MacroValue({ label, val, goal, unit, color }) {
  return (
    <div className={`${styles.macroVal} ${styles[color]}`}>
      <span className={styles.macroLabel2}>{label}</span>
      <span className={styles.macroNum}>{val}{unit}</span>
      {goal && <span className={styles.macroGoal}>/{goal}{unit}</span>}
    </div>
  )
}

function StatCell({ label, value, unit, n }) {
  return (
    <div className={styles.statCell}>
      <div className={styles.statValue}>{value}<span className={styles.statUnit}>{value !== '—' ? unit : ''}</span></div>
      <div className={styles.statName}>{label}</div>
      <div className={styles.statN}>{n} logged</div>
    </div>
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
