import { useState, useEffect, useCallback, useRef } from 'react'
import Layout from '../components/Layout.jsx'
import Chip from '../components/Chip.jsx'
import {
  getAllExercises, saveExercise,
  getGoal, saveGoal,
  getSessionsForExercise, saveSessions,
  getPR, savePR, deleteSessionsByIds, getSessionsOnDate, recomputePR,
  getSchedule,
  getSessionTypes, saveSessionType, deleteSessionType,
} from '../db/dal.js'
import { today, formatDate, estimate8RM, estimate8RMDisplay } from '../lib/utils.js'
import { loadDraft, saveDraft, clearDraft } from '../lib/drafts.js'
import { useAppStore } from '../store/useAppStore.js'
import {
  getProgressionConfig, getProgressionMode, suggestNext, sessionHit, beatRecent,
  stallInfo, currentLevel, chronological, prSetIds, RECENT_WINDOW,
} from '../lib/progression.js'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import styles from './Exercises.module.css'

// Which logged sets were saved together (one "Save session" press).
// New sets carry a batchId. Older sets are inferred: within one date, sorted by
// save order, a new batch starts as soon as an exercise repeats.
function batchOf(target, sameDay) {
  if (target.batchId) return sameDay.filter(s => s.batchId === target.batchId)
  const legacy = sameDay.filter(s => !s.batchId).sort((a, b) => a.id - b.id)
  const batches = []
  let cur = [], seen = new Set()
  for (const s of legacy) {
    if (seen.has(s.exerciseId)) { batches.push(cur); cur = []; seen = new Set() }
    cur.push(s)
    seen.add(s.exerciseId)
  }
  if (cur.length) batches.push(cur)
  return batches.find(b => b.some(s => s.id === target.id)) ?? [target]
}

// Subtle vibration for drag feedback; silently does nothing where unsupported
function haptic(kind) {
  try {
    const p = kind === 'pickup' ? Haptics.impact({ style: ImpactStyle.Light }) : Haptics.selectionChanged()
    p?.catch?.(() => {})
  } catch { /* no haptics available */ }
}

// Logical muscle order: upper push → upper pull → legs (front, back, inner, calves) → trunk → other.
// Custom groups not listed here sort to the end alphabetically.
const MUSCLE_ORDER = [
  'Chest', 'Shoulders', 'Traps', 'Triceps',
  'Back', 'Lower Back', 'Biceps', 'Forearms',
  'Quads', 'Hamstrings', 'Glutes', 'Adductors', 'Calves',
  'Core', 'Obliques', 'Neck',
  'Olympic', 'Conditioning', 'Sport', 'Mobility',
]
const muscleRank = (m) => {
  const i = MUSCLE_ORDER.indexOf(m)
  return i === -1 ? MUSCLE_ORDER.length : i
}
const compareMuscle = (a, b) => muscleRank(a) - muscleRank(b) || a.localeCompare(b)

export default function Exercises() {
  const { profile } = useAppStore()
  const progCfg = getProgressionConfig(profile)
  const progMode = getProgressionMode(profile)

  // Library + session types
  const [library, setLibrary] = useState([])
  const [sessionTypes, setSessionTypes] = useState([])
  const [activeId, setActiveId] = useState(null)

  // Per-exercise data for the active session
  const [goalMap, setGoalMap] = useState({})
  const [lastMap, setLastMap] = useState({})
  const [prMap, setPrMap] = useState({})
  const [prevMap, setPrevMap] = useState({})     // the few sets before the last one
  const [lastPRMap, setLastPRMap] = useState({}) // was the last set a PR when logged?
  const [stallMap, setStallMap] = useState({})   // { stalled, count, days } per exercise
  const [levelMap, setLevelMap] = useState({})   // { weight, reps, since } per exercise
  const [sessionInputs, setSessionInputs] = useState({})
  const [sessionNote, setSessionNote] = useState('') // saved on every set of this workout (e.g. "elbow pain")

  // Logging state
  const [sessionDate, setSessionDate] = useState(today())
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [newPRs, setNewPRs] = useState([])
  const savingRef = useRef(false)
  const draftReady = useRef(null) // session id whose inputs are loaded (guards draft writes)

  // Manage / picker state
  const [manage, setManage] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [muscleFilter, setMuscleFilter] = useState('')
  const [customForm, setCustomForm] = useState({ name: '', muscleGroup: '' })
  const [showCustom, setShowCustom] = useState(false)
  const [showNewType, setShowNewType] = useState(false)
  const [newTypeName, setNewTypeName] = useState('')

  // Drag to reorder: `drag` drives rendering, dragRef holds per-frame values
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const rowRefs = useRef({})

  // Carry-over prompt, edit sheet, swap mode
  const [carryPrompt, setCarryPrompt] = useState(null)
  const [editEx, setEditEx] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', muscleGroup: '' })
  const [editError, setEditError] = useState('')
  const [swapTargetId, setSwapTargetId] = useState(null)

  // History modal
  const [historyEx, setHistoryEx] = useState(null)
  const [historyData, setHistoryData] = useState([])
  const [historySessions, setHistorySessions] = useState([])
  const [historyPRs, setHistoryPRs] = useState(new Set())
  const [deleteChoice, setDeleteChoice] = useState(null) // { session, ex, batch, others }
  const [editSet, setEditSet] = useState(null)           // logged set being corrected in the history
  const [noteOpen, setNoteOpen] = useState({})           // which cards show the exercise-note field

  // Always-current copies for async handlers. Rapid taps each start before the previous
  // save re-renders, so they must read the latest list from here, not a stale closure.
  const typesRef = useRef([])
  const activeIdRef = useRef(null)
  activeIdRef.current = activeId
  const setTypes = (types) => { typesRef.current = types; setSessionTypes(types) }
  const currentActive = () => typesRef.current.find(t => t.id === activeIdRef.current) ?? null

  const exMap = Object.fromEntries(library.map(e => [e.id, e]))
  const active = sessionTypes.find(st => st.id === activeId) ?? null
  const activeExercises = active ? active.exerciseIds.map(id => exMap[id]).filter(Boolean) : []
  const muscleGroups = [...new Set(library.map(e => e.muscleGroup))].sort(compareMuscle)

  // Initial load: library, session types, schedule auto-select
  useEffect(() => {
    const init = async () => {
      const [lib, types, schedule] = await Promise.all([getAllExercises(), getSessionTypes(), getSchedule()])
      setLibrary(lib)
      setTypes(types)
      const todaySched = schedule.find(s => s.day === new Date().getDay())
      if (todaySched?.sessionTypeId && types.some(t => t.id === todaySched.sessionTypeId)) {
        setActiveId(todaySched.sessionTypeId)
      } else if (types.length > 0) {
        setActiveId(types[0].id)
      }
    }
    init()
  }, [])

  // Load per-exercise data whenever the active session changes
  const load = useCallback(async () => {
    if (!active) {
      setGoalMap({}); setLastMap({}); setPrevMap({}); setLastPRMap({}); setPrMap({}); setStallMap({}); setLevelMap({})
      setSessionInputs({}); setSessionNote('')
      return
    }
    const ids = active.exerciseIds
    const goals = {}, lasts = {}, prevs = {}, lastPRs = {}, prs = {}, stalls = {}, levels = {}
    await Promise.all(ids.map(async id => {
      const [g, raw, pr] = await Promise.all([getGoal(id), getSessionsForExercise(id), getPR(id)])
      const history = chronological(raw)
      if (g) goals[id] = g
      if (history.length) {
        lasts[id] = history[history.length - 1]
        lastPRs[id] = prSetIds(history).has(lasts[id].id)
      }
      if (history.length > 1) prevs[id] = history.slice(-1 - RECENT_WINDOW, -1)
      if (pr) prs[id] = pr
      stalls[id] = stallInfo(history)
      levels[id] = currentLevel(history)
    }))
    setGoalMap(goals)
    setLastMap(lasts)
    setPrevMap(prevs)
    setLastPRMap(lastPRs)
    setPrMap(prs)
    setStallMap(stalls)
    setLevelMap(levels)
    // Inputs start empty (last set shows as a grey hint), unless there's an unsaved draft
    const draft = loadDraft(`gym:${active.id}`)
    const inputs = {}
    for (const id of ids) inputs[id] = draft?.inputs?.[id] ?? { weight: '', reps: '' }
    setSessionInputs(inputs)
    setSessionNote(draft?.note ?? '')
    if (draft?.date) setSessionDate(draft.date)
    draftReady.current = active.id
  }, [activeId, sessionTypes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  // Keep unsaved inputs as a draft so they survive tab switches and closing the app
  useEffect(() => {
    if (!active || draftReady.current !== active.id) return
    const key = `gym:${active.id}`
    const typed = Object.values(sessionInputs).some(v => v.weight !== '' || v.reps !== '' || !!v.note) || sessionNote !== ''
    const backdated = sessionDate !== today()
    if (typed || backdated) saveDraft(key, { inputs: sessionInputs, note: sessionNote, date: backdated ? sessionDate : null })
    else clearDraft(key)
  }, [sessionInputs, sessionNote, sessionDate]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshTypes = async () => {
    const types = await getSessionTypes()
    setTypes(types)
    return types
  }

  // ── Session type management ─────────────────────────────
  const handleCreateType = async () => {
    const name = newTypeName.trim()
    if (!name) return
    const id = await saveSessionType({ name, exerciseIds: [] })
    await refreshTypes()
    setActiveId(id)
    setNewTypeName('')
    setShowNewType(false)
    setManage(true)
    setPickerOpen(true)
  }

  const handleDeleteType = async () => {
    if (!active) return
    if (!confirm(`Delete session "${active.name}"? Exercise history stays intact.`)) return
    await deleteSessionType(active.id)
    const types = await refreshTypes()
    setActiveId(types[0]?.id ?? null)
    setManage(false)
  }

  // Save a new exercise order for the active session (optimistic so the list doesn't flicker)
  const saveOrder = async (exerciseIds) => {
    const cur = currentActive()
    if (!cur) return
    const next = { ...cur, exerciseIds }
    setTypes(typesRef.current.map(t => (t.id === cur.id ? next : t)))
    await saveSessionType(next)
  }

  // Put an exercise into the session: append, or replace another in the same slot
  const placeExercise = async (exerciseId, replaceId = null) => {
    const cur = currentActive()
    if (!cur || cur.exerciseIds.includes(exerciseId)) return
    const ids = replaceId
      ? cur.exerciseIds.map(id => (id === replaceId ? exerciseId : id))
      : [...cur.exerciseIds, exerciseId]
    await saveOrder(ids)
  }

  // Adding an exercise that already has progress asks whether to carry it over
  const requestAdd = async (exerciseId, replaceId = null) => {
    if (currentActive()?.exerciseIds.includes(exerciseId)) return
    if (!active) return
    const [history, goal] = await Promise.all([getSessionsForExercise(exerciseId), getGoal(exerciseId)])
    if (history.length || goal) {
      setCarryPrompt({
        exerciseId,
        replaceId,
        count: history.length,
        last: history[history.length - 1] ?? null,
        goal: goal ?? null,
        inSplits: sessionTypes
          .filter(t => t.id !== active.id && t.exerciseIds.includes(exerciseId))
          .map(t => t.name),
      })
      return
    }
    await placeExercise(exerciseId, replaceId)
    if (replaceId) { setPickerOpen(false); setSwapTargetId(null) }
  }

  const carryOver = async () => {
    const p = carryPrompt
    setCarryPrompt(null)
    await placeExercise(p.exerciseId, p.replaceId)
    if (p.replaceId) { setPickerOpen(false); setSwapTargetId(null) }
  }

  // Start fresh: a separate copy of the exercise with its own clean history
  const startFresh = async () => {
    const p = carryPrompt
    setCarryPrompt(null)
    const src = exMap[p.exerciseId]
    const taken = new Set(library.map(e => e.name.toLowerCase()))
    let name = `${src.name} (${active.name})`
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${src.name} (${active.name} ${n})`
    const newId = await saveExercise({ name, muscleGroup: src.muscleGroup })
    setLibrary(await getAllExercises())
    await placeExercise(newId, p.replaceId)
    if (p.replaceId) { setPickerOpen(false); setSwapTargetId(null) }
  }

  const removeExerciseFromSession = async (exerciseId) => {
    const cur = currentActive()
    if (!cur) return
    await saveOrder(cur.exerciseIds.filter(id => id !== exerciseId))
  }

  // ── Drag to reorder (pointer events: works for touch and mouse) ─────
  // The list is NOT re-ordered while dragging. The held row follows the finger via a
  // transform, the rows it passes slide out of the way, and the new order is only
  // committed after the held row has eased into its slot — so nothing ever jumps.
  const scrollPos = () => (document.querySelector('main')?.scrollTop ?? 0) + window.scrollY

  const onDragStart = (e, exerciseId) => {
    const cur = currentActive()
    if (!cur || dragRef.current || drag) return   // ignore while a previous drop is settling
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not all pointers can be captured */ }

    // Snapshot the layout once; offsetTop ignores transforms and scrolling
    const ids = cur.exerciseIds.filter(id => rowRefs.current[id])
    const rows = ids.map(id => ({ id, top: rowRefs.current[id].offsetTop, height: rowRefs.current[id].offsetHeight }))
    const index = ids.indexOf(exerciseId)
    if (index < 0) return
    const gap = rows.length > 1 ? rows[1].top - rows[0].top - rows[0].height : 0

    dragRef.current = {
      id: exerciseId, ids, rows, index, gap,
      step: rows[index].height + gap,        // how far other rows move to make room
      startY: e.clientY, y: e.clientY, startScroll: scrollPos(),
      target: index,
    }
    setDrag({ id: exerciseId, index, target: index, step: rows[index].height + gap, settleY: null })
    haptic('pickup')

    // Pointer moves drive the row directly (onDragMove). This loop only handles
    // auto-scrolling while the finger rests near the top/bottom edge.
    const frame = () => {
      const d = dragRef.current
      if (!d) return
      const edge = 80
      const dy = d.y < edge ? -8 : d.y > window.innerHeight - edge ? 8 : 0
      if (dy) {
        document.querySelector('main')?.scrollBy(0, dy)
        window.scrollBy(0, dy)
        updateDrag()
      }
      d.raf = requestAnimationFrame(frame)
    }
    dragRef.current.raf = requestAnimationFrame(frame)
  }

  const updateDrag = () => {
    const d = dragRef.current
    if (!d) return
    const delta = (d.y - d.startY) + (scrollPos() - d.startScroll)
    const el = rowRefs.current[d.id]
    if (el) el.style.transform = `translateY(${delta}px) scale(1.02)`

    // Target slot = how many other rows the held row's centre has passed
    const held = d.rows[d.index]
    const centre = held.top + held.height / 2 + delta
    let target = 0
    d.rows.forEach((r, k) => { if (k !== d.index && r.top + r.height / 2 < centre) target++ })
    if (target !== d.target) {
      d.target = target
      setDrag(s => (s ? { ...s, target } : s))
      haptic('tick')
    }
  }

  const onDragMove = (e) => {
    if (!dragRef.current) return
    dragRef.current.y = e.clientY
    updateDrag()
  }

  const onDragEnd = () => {
    const d = dragRef.current
    if (!d) return
    cancelAnimationFrame(d.raf)
    dragRef.current = null

    const others = d.ids.filter(id => id !== d.id)
    const order = [...others]
    order.splice(d.target, 0, d.id)

    // Ease the held row into its final slot, then commit the new order
    const othersRows = d.rows.filter((_, k) => k !== d.index)
    let finalTop = d.rows[0].top
    for (let k = 0; k < d.target; k++) finalTop += othersRows[k].height + d.gap
    setDrag(s => (s ? { ...s, settleY: finalTop - d.rows[d.index].top } : s))

    setTimeout(() => {
      const cur = currentActive()
      // Keep any ids that weren't rendered (e.g. a deleted exercise) at the end
      const rest = cur ? cur.exerciseIds.filter(id => !order.includes(id)) : []
      const full = [...order, ...rest]
      setDrag(null)
      if (cur && full.join() !== cur.exerciseIds.join()) saveOrder(full)
    }, 180)
  }

  // Slots a non-held row shifts by: +1 down, -1 up, 0 stays (original index k)
  const shiftFor = (k) => {
    if (!drag) return 0
    const { index: i, target: t } = drag
    if (k < i) return k >= t ? 1 : 0
    if (k > i) return k - 1 < t ? -1 : 0
    return 0
  }

  // ── Edit an exercise (rename / muscle group / swap) ─────
  const openEdit = (ex) => {
    setEditEx(ex)
    setEditForm({ name: ex.name, muscleGroup: ex.muscleGroup })
    setEditError('')
  }

  const saveEdit = async () => {
    const name = editForm.name.trim()
    const muscleGroup = editForm.muscleGroup.trim() || 'Other'
    if (!name) { setEditError('Name can\'t be empty.'); return }
    const clash = library.find(e => e.id !== editEx.id && e.name.toLowerCase() === name.toLowerCase())
    if (clash) { setEditError('Another exercise already has that name.'); return }
    // Remember the original library name so future library updates still recognise it
    await saveExercise({ ...editEx, name, muscleGroup, seedName: editEx.seedName ?? editEx.name })
    setLibrary(await getAllExercises())
    setEditEx(null)
  }

  const startSwap = () => {
    setSwapTargetId(editEx.id)
    setEditEx(null)
    setSearch('')
    setPickerOpen(true)
  }

  const handleCreateCustomExercise = async () => {
    const name = customForm.name.trim()
    if (!name) return
    const id = await saveExercise({ name, muscleGroup: customForm.muscleGroup.trim() || 'Other' })
    setLibrary(await getAllExercises())
    await placeExercise(id, swapTargetId)
    if (swapTargetId) { setPickerOpen(false); setSwapTargetId(null) }
    setCustomForm({ name: '', muscleGroup: '' })
    setShowCustom(false)
  }

  // ── Next-set suggestion (local math only, never AI) ─────
  // Based on the exercise's level (best reps at its current weight) and the session date,
  // so the next step only comes once that level has held for a week.
  const suggestionFor = (ex) =>
    progCfg.enabled ? suggestNext(levelMap[ex.id], progMode, progCfg, ex.muscleGroup, sessionDate) : null

  const SUGGEST_LABEL = {
    rep: 'Next: +1 rep',
    jump: 'Next: add weight',
    reset: 'Next: lighter, back in range',
    recover: 'Next: back to your level',
    hold: 'Hold strength',
    bodyweight: 'Next: +1 rep',
  }
  const suggestLabel = (s) =>
    s.kind === 'wait'
      ? `Same reps · ${s.next === 'jump' ? 'more weight' : 'extra rep'} in ${s.dueIn} day${s.dueIn === 1 ? '' : 's'}`
      : SUGGEST_LABEL[s.kind]

  // Fill the inputs with a set (the suggestion or the goal)
  const fillSet = (ex, weight, reps) => {
    setSessionInputs(prev => ({ ...prev, [ex.id]: { ...prev[ex.id], weight: String(weight), reps: String(reps) } }))
  }

  // ── Logging ─────────────────────────────────────────────
  const handleSave = async () => {
    if (savingRef.current || !active) return
    const dateStr = sessionDate
    const prs = []
    const sessions = []

    // Only exercises you actually filled in get logged
    const validSets = activeExercises.flatMap(ex => {
      const inp = sessionInputs[ex.id]
      if (inp?.weight === '' || inp?.weight == null || inp?.reps === '' || inp?.reps == null) return []
      return [{ ex, weight: parseFloat(inp.weight), reps: parseInt(inp.reps), exNote: (inp.note ?? '').trim() }]
    })
    if (validSets.length === 0) {
      setSavedMsg('Nothing to save — enter at least one set.')
      setTimeout(() => setSavedMsg(''), 3000)
      return
    }
    if (!dateStr || dateStr > today()) {
      setSavedMsg('Pick a valid date (today or earlier).')
      setTimeout(() => setSavedMsg(''), 4000)
      return
    }
    // Impossible sets would break PRs and suggestions — catch them before anything is saved
    const bad = validSets.find(({ weight, reps }) => !(weight >= 0 && weight <= 1000) || !(reps >= 1 && reps <= 200))
    if (bad) {
      setSavedMsg(`Check ${bad.ex.name}: weight 0 kg or more, at least 1 rep.`)
      setTimeout(() => setSavedMsg(''), 5000)
      return
    }

    savingRef.current = true
    setSaving(true)

    // Guard against double-logging: ask if any of these exercises is already logged that day
    const sameDay = await getSessionsOnDate(dateStr)
    const dupes = validSets.filter(({ ex }) => sameDay.some(s => s.exerciseId === ex.id)).map(({ ex }) => ex.name)
    if (dupes.length && !confirm(`Already logged on ${formatDate(dateStr)}:\n${dupes.join(', ')}\n\nSave again anyway?`)) {
      savingRef.current = false
      setSaving(false)
      return
    }

    // Everything saved by this one press shares a batchId, so it can be deleted as one unit
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const note = sessionNote.trim()
    const existingPRs = await Promise.all(validSets.map(({ ex }) => getPR(ex.id)))
    await Promise.all(validSets.map(async ({ ex, weight, reps, exNote }, i) => {
      const entry = { exerciseId: ex.id, date: dateStr, weight, reps, batchId }
      if (note) entry.note = note       // workout note goes on every set of this save
      if (exNote) entry.exNote = exNote // this exercise only (e.g. "form upgrade") — marked on its graph
      // Record the target this set was aiming for, so misses can be tracked.
      // Only when logging after the last session — a backdated set wasn't aiming at it.
      const last = lastMap[ex.id]
      const target = suggestionFor(ex)
      if (target && last && dateStr > last.date) {
        entry.targetWeight = target.weight
        entry.targetReps = target.reps
        entry.targetKind = target.kind
      }
      sessions.push(entry)
      const existingPR = existingPRs[i]
      const newScore = estimate8RM(weight, reps)
      const oldScore = existingPR ? estimate8RM(existingPR.weight, existingPR.reps) : 0
      if (newScore > oldScore) {
        await savePR({ exerciseId: ex.id, date: dateStr, weight, reps })
        prs.push(ex.name)
      }
    }))

    await saveSessions(sessions)

    // Clear the inputs so it's obvious the session went through, and drop the draft
    clearDraft(`gym:${active.id}`)
    setSessionInputs(Object.fromEntries(activeExercises.map(ex => [ex.id, { weight: '', reps: '' }])))
    setSessionNote('')
    setNoteOpen({})
    setSessionDate(today())   // a backdate shouldn't silently carry over to the next session

    setNewPRs(prs)
    setSavedMsg(`✓ Saved ${sessions.length} exercise${sessions.length > 1 ? 's' : ''} for ${formatDate(dateStr)}`)
    setSaving(false)
    savingRef.current = false
    await load()
    setTimeout(() => setNewPRs([]), 5000)
    setTimeout(() => setSavedMsg(''), 5000)
  }

  const handleGoalUpdate = async (exerciseId, targetWeight, targetReps) => {
    await saveGoal({ exerciseId, targetWeight: parseFloat(targetWeight), targetReps: parseInt(targetReps) })
    await load()
  }

  // ── History ─────────────────────────────────────────────
  const openHistory = async (ex) => {
    setHistoryEx(ex)
    const sessions = chronological(await getSessionsForExercise(ex.id))
    setHistorySessions([...sessions].reverse())
    setHistoryPRs(prSetIds(sessions))
    // Plotted as estimated 8RM so sets with different reps compare fairly
    setHistoryData(sessions.map(s => ({
      date: s.date.slice(5), e8: estimate8RMDisplay(s.weight, s.reps), weight: s.weight, reps: s.reps, exNote: s.exNote,
    })))
  }

  // ── Edit a logged set (fix a typo instead of delete + re-log) ──
  const startEditSet = (s) =>
    setEditSet({ id: s.id, date: s.date, weight: String(s.weight), reps: String(s.reps), exNote: s.exNote ?? '', note: s.note ?? '' })

  const saveEditSet = async () => {
    const weight = parseFloat(editSet.weight)
    const reps = parseInt(editSet.reps)
    if (!(weight >= 0 && weight <= 1000) || !(reps >= 1 && reps <= 200) || !editSet.date || editSet.date > today()) return
    const orig = historySessions.find(s => s.id === editSet.id)
    if (!orig) { setEditSet(null); return }
    const next = { ...orig, date: editSet.date, weight, reps }
    // Empty notes are removed rather than stored as ''
    const exNote = editSet.exNote.trim(), note = editSet.note.trim()
    if (exNote) next.exNote = exNote; else delete next.exNote
    if (note) next.note = note; else delete next.note
    await saveSessions([next])
    await recomputePR(orig.exerciseId, estimate8RM)
    setEditSet(null)
    await openHistory(historyEx)
    await load()
  }

  // Ask what to delete: just this exercise's set, or the whole workout it was saved with
  const handleDeleteSession = async (session, ex) => {
    const sameDay = await getSessionsOnDate(session.date)
    const batch = batchOf(session, sameDay)
    setDeleteChoice({ session, ex, batch, others: sameDay.length - batch.length })
  }

  const confirmDelete = async (whole) => {
    const { session, ex, batch } = deleteChoice
    setDeleteChoice(null)
    const ids = whole ? batch.map(s => s.id) : [session.id]
    const affected = await deleteSessionsByIds(ids)
    await Promise.all(affected.map(id => recomputePR(id, estimate8RM)))
    await openHistory(ex)
    await load()
  }

  const exName = (id) => library.find(e => e.id === id)?.name ?? '?'

  const goalProgress = (exerciseId) => {
    const goal = goalMap[exerciseId]
    const last = lastMap[exerciseId]
    if (!goal || !last) return null
    const lastScore = estimate8RM(last.weight, last.reps)
    const goalScore = estimate8RM(goal.targetWeight, goal.targetReps)
    if (!goalScore) return null
    const pct = (lastScore / goalScore) * 100
    if (pct >= 100) return 'green'
    if (pct >= 90) return 'amber'
    return 'red'
  }

  // Library picker filtering
  const filteredLibrary = library
    .filter(e => {
      if (muscleFilter && e.muscleGroup !== muscleFilter) return false
      if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    .sort((a, b) => compareMuscle(a.muscleGroup, b.muscleGroup) || a.name.localeCompare(b.name))

  // Group consecutive exercises under their muscle heading for the picker list
  const groupedLibrary = []
  for (const ex of filteredLibrary) {
    const last = groupedLibrary[groupedLibrary.length - 1]
    if (last && last.muscle === ex.muscleGroup) last.items.push(ex)
    else groupedLibrary.push({ muscle: ex.muscleGroup, items: [ex] })
  }

  return (
    <Layout title="Gym" right={
      <button className={styles.addBtn} onClick={() => { setShowNewType(v => !v); setNewTypeName('') }}>
        + Session
      </button>
    }>

      {/* New session type form */}
      {showNewType && (
        <div className={styles.newTypeForm}>
          <input
            className={styles.input}
            placeholder="Session name (e.g. Push, Upper, Arnold 1…)"
            value={newTypeName}
            onChange={e => setNewTypeName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateType()}
            autoFocus
          />
          <button className={styles.saveBtn} onClick={handleCreateType}>Create</button>
        </div>
      )}

      {/* Session type tabs */}
      {sessionTypes.length > 0 ? (
        <div className={styles.typeScroll}>
          {sessionTypes.map(st => (
            <button
              key={st.id}
              className={`${styles.typeBtn} ${activeId === st.id ? styles.active : ''}`}
              onClick={() => { setActiveId(st.id); setManage(false) }}
            >{st.name}</button>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <p>No sessions yet.</p>
          <p className={styles.emptyHint}>Tap <strong>+ Session</strong> to create your first workout day (e.g. Push, Upper, Legs) and add exercises from the library.</p>
        </div>
      )}

      {active && (
        <>
          {/* Session date + manage toggle */}
          <div className={styles.dateBar}>
            <span className={styles.dateLabel}>Date</span>
            <input
              className={styles.dateInput}
              type="date"
              max={today()}
              value={sessionDate}
              onChange={e => setSessionDate(e.target.value)}
            />
            {sessionDate !== today() && <span className={styles.backdateTag}>backdating</span>}
            <button className={`${styles.manageBtn} ${manage ? styles.manageActive : ''}`} onClick={() => setManage(v => !v)}>
              {manage ? 'Done' : 'Edit'}
            </button>
          </div>


          {/* Manage mode: drag to reorder / edit / remove / add / delete session */}
          {manage && (
            <div className={styles.managePanel}>
              {activeExercises.length > 1 && (
                <div className={styles.dragHint}>Hold ⠿ and drag to reorder</div>
              )}
              {active.exerciseIds.map(id => exMap[id]).filter(Boolean).map((ex, k) => {
                const isHeld = drag?.id === ex.id
                let style
                if (drag && isHeld && drag.settleY != null) {
                  // Released: glide into the final slot
                  style = { transform: `translateY(${drag.settleY}px)`, transition: 'transform 180ms cubic-bezier(.2,.8,.2,1)' }
                } else if (drag && !isHeld) {
                  // Rows the held one passes slide out of its way
                  style = { transform: `translateY(${shiftFor(k) * drag.step}px)`, transition: 'transform 200ms cubic-bezier(.2,.8,.2,1)' }
                }
                return (
                <div
                  key={ex.id}
                  ref={el => { if (el) rowRefs.current[ex.id] = el; else delete rowRefs.current[ex.id] }}
                  className={`${styles.manageRow} ${isHeld ? styles.dragging : ''}`}
                  style={style}
                >
                  <span
                    className={styles.dragHandle}
                    onPointerDown={e => onDragStart(e, ex.id)}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragEnd}
                    onPointerCancel={onDragEnd}
                  >⠿</span>
                  <span className={styles.manageName}>{ex.name}</span>
                  <span className={styles.manageMuscle}>{ex.muscleGroup}</span>
                  <button className={styles.moveBtn} onClick={() => openEdit(ex)} title="Edit">✎</button>
                  <button className={styles.removeBtn} onClick={() => removeExerciseFromSession(ex.id)}>×</button>
                </div>
                )
              })}
              <button className={styles.addExBtn} onClick={() => { setSwapTargetId(null); setPickerOpen(true) }}>+ Add exercise</button>
              <button className={styles.deleteTypeBtn} onClick={handleDeleteType}>Delete this session</button>
            </div>
          )}

          {/* Exercise cards (logging) */}
          {!manage && (
            <div className={styles.section}>
              {activeExercises.length === 0 && (
                <p className={styles.empty}>No exercises in this session yet. Tap <strong>Edit</strong> to add some.</p>
              )}
              {activeExercises.map(ex => {
                const goal = goalMap[ex.id]
                const last = lastMap[ex.id]
                const inp = sessionInputs[ex.id] ?? { weight: '', reps: '' }
                const color = goalProgress(ex.id)

                return (
                  <div key={ex.id} className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div>
                        <div className={styles.exName}>{ex.name}</div>
                        <div className={styles.exMeta}>{ex.muscleGroup}</div>
                      </div>
                      <div className={styles.cardRight}>
                        {goal && (
                          <button className={styles.goalChipBtn} onClick={() => fillSet(ex, goal.targetWeight, goal.targetReps)} title="Tap to fill in">
                            <Chip color={color ?? 'neutral'}>
                              Goal: {goal.targetWeight}kg × {goal.targetReps}
                            </Chip>
                          </button>
                        )}
                        <button className={styles.histBtn} onClick={() => openHistory(ex)}>History</button>
                      </div>
                    </div>

                    <div className={styles.estRow}>
                      {prMap[ex.id] && (
                        <span className={styles.estBest}>🏆 Best 8RM: {estimate8RMDisplay(prMap[ex.id].weight, prMap[ex.id].reps)}kg</span>
                      )}
                      {last && (
                        <span className={styles.estLast}>Last 8RM: {estimate8RMDisplay(last.weight, last.reps)}kg</span>
                      )}
                    </div>

                    {last && (
                      <div className={styles.lastRow}>
                        Last: {last.weight}kg × {last.reps} reps
                        {lastPRMap[ex.id] && <span className={styles.prTag}>🏆 PR</span>}
                        {(() => {
                          // Hitting the target, or simply beating the time before, both count as progress
                          const hit = sessionHit(last)
                          if (hit) return <span className={styles.up}> ✓ {{ wait: 'matched', recover: 'back on track' }[last.targetKind] ?? 'target'}</span>
                          if (beatRecent(last, prevMap[ex.id])) return <span className={styles.up}> ✓ improved</span>
                          if (hit === null) return null
                          return <span className={styles.down}> ✗ missed {last.targetWeight > 0 ? `${last.targetWeight}kg × ` : ''}{last.targetReps}</span>
                        })()}
                        {(() => {
                          const w = parseFloat(inp.weight)
                          const r = parseInt(inp.reps)
                          if (inp.weight === '' || inp.weight == null || inp.reps === '' || inp.reps == null || !Number.isFinite(w) || !Number.isFinite(r)) return null
                          const lastScore = estimate8RM(last.weight, last.reps)
                          const nowScore = estimate8RM(w, r)
                          const diff = estimate8RMDisplay(w, r) - estimate8RMDisplay(last.weight, last.reps)
                          if (Math.abs(diff) < 0.1) return <span className={styles.same}> — same (8RM)</span>
                          return <span className={nowScore > lastScore ? styles.up : styles.down}> {diff > 0 ? '+' : ''}{diff.toFixed(1)}kg (8RM)</span>
                        })()}
                        {last.exNote && <div className={styles.lastExNote}>✎ {last.exNote}</div>}
                        {last.note && <div className={styles.lastNote}>📝 {last.note}</div>}
                      </div>
                    )}

                    {/* Next-set suggestion — tap to fill the inputs */}
                    {(() => {
                      const s = suggestionFor(ex)
                      if (!s) return null
                      return (
                        <button className={styles.suggestRow} onClick={() => fillSet(ex, s.weight, s.reps)}>
                          <span className={styles.suggestLabel}>{suggestLabel(s)}</span>
                          <span className={styles.suggestVal}>
                            {s.weight > 0 ? `${s.weight}kg × ${s.reps}` : `${s.reps} reps`}
                          </span>
                          <span className={styles.suggestHint}>tap to use</span>
                        </button>
                      )
                    })()}

                    {/* Stall warning: a whole week of missing what was asked */}
                    {progCfg.enabled && stallMap[ex.id]?.stalled && (
                      <div className={styles.stallWarn}>
                        {progMode === 'hold'
                          ? `⚠ Couldn't match ${levelMap[ex.id]?.weight}kg × ${levelMap[ex.id]?.reps} for a week (${stallMap[ex.id].count} tries). Strength is slipping on this cut — check protein, deficit size and sleep.`
                          : `⚠ Stalling: no step forward for a week (${stallMap[ex.id].count} tries). Check sleep, food and recovery, or consider a deload week.`}
                      </div>
                    )}

                    <div className={styles.inputRow}>
                      {/* Empty by default — the grey hint is last time's set */}
                      <input
                        className={styles.setInput}
                        type="number"
                        inputMode="decimal"
                        placeholder={last ? String(last.weight) : 'kg'}
                        value={inp.weight}
                        onChange={e => setSessionInputs(s => ({ ...s, [ex.id]: { ...s[ex.id], weight: e.target.value } }))}
                      />
                      <span className={styles.x}>kg ×</span>
                      <input
                        className={styles.setInput}
                        type="number"
                        inputMode="numeric"
                        placeholder={last ? String(last.reps) : 'reps'}
                        value={inp.reps}
                        onChange={e => setSessionInputs(s => ({ ...s, [ex.id]: { ...s[ex.id], reps: e.target.value } }))}
                      />
                      <span className={styles.x}>reps</span>
                    </div>

                    {/* Note for this exercise only — shows as a dashed line on its graph */}
                    {noteOpen[ex.id] || inp.note ? (
                      <input
                        className={styles.exNoteInput}
                        placeholder="Note for this exercise (e.g. form upgrade)"
                        value={inp.note ?? ''}
                        onChange={e => setSessionInputs(s => ({ ...s, [ex.id]: { ...s[ex.id], note: e.target.value } }))}
                      />
                    ) : null}

                    <div className={styles.cardActions}>
                      {!noteOpen[ex.id] && !inp.note && (
                        <button className={styles.goalToggle} onClick={() => setNoteOpen(o => ({ ...o, [ex.id]: true }))}>+ Note</button>
                      )}
                      <GoalEditor exerciseId={ex.id} current={goal} onSave={handleGoalUpdate} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {!manage && activeExercises.length > 0 && (
            <div className={styles.saveRow}>
              <input
                className={styles.sessionNoteInput}
                placeholder="Workout note for all exercises (e.g. elbow pain) — optional"
                value={sessionNote}
                onChange={e => setSessionNote(e.target.value)}
              />
              {/* Confirmation sits right at the button, where you're looking when you save */}
              {savedMsg && <div className={styles.savedToast}>{savedMsg}</div>}
              {newPRs.length > 0 && (
                <div className={styles.prToast}>🏆 New PR{newPRs.length > 1 ? 's' : ''}: {newPRs.join(', ')}</div>
              )}
              <button className={styles.saveSessionBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save session'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Exercise library picker */}
      {pickerOpen && active && (
        <div className={styles.modal} onClick={() => setPickerOpen(false)}>
          <div className={styles.pickerCard} onClick={e => e.stopPropagation()}>
            <div className={styles.pickerHeader}>
              <span className={styles.modalTitle}>
                {swapTargetId
                  ? `Swap "${exMap[swapTargetId]?.name}" for…`
                  : `Add to "${active.name}"`}
              </span>
              <button className={styles.closeX} onClick={() => { setPickerOpen(false); setSwapTargetId(null) }}>✕</button>
            </div>

            <input
              className={styles.input}
              placeholder="Search exercises…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />

            <div className={styles.muscleScroll}>
              <button
                className={`${styles.muscleChip} ${muscleFilter === '' ? styles.muscleActive : ''}`}
                onClick={() => setMuscleFilter('')}
              >All</button>
              {muscleGroups.map(m => (
                <button
                  key={m}
                  className={`${styles.muscleChip} ${muscleFilter === m ? styles.muscleActive : ''}`}
                  onClick={() => setMuscleFilter(m)}
                >{m}</button>
              ))}
            </div>

            <div className={styles.pickerList}>
              {groupedLibrary.map(group => (
                <div key={group.muscle} className={styles.pickerGroup}>
                  <div className={styles.pickerGroupHeader}>{group.muscle}</div>
                  {group.items.map(ex => {
                    const inSession = active.exerciseIds.includes(ex.id)
                    return (
                      <button
                        key={ex.id}
                        className={`${styles.pickerRow} ${inSession ? styles.pickerAdded : ''}`}
                        disabled={swapTargetId != null && inSession}
                        onClick={() => {
                          if (swapTargetId) return requestAdd(ex.id, swapTargetId)
                          return inSession ? removeExerciseFromSession(ex.id) : requestAdd(ex.id)
                        }}
                      >
                        <span className={styles.pickerName}>{ex.name}</span>
                        <span className={styles.pickerMark}>{inSession ? '✓' : '+'}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
              {filteredLibrary.length === 0 && <p className={styles.empty}>No matches.</p>}
            </div>

            {/* Custom exercise */}
            {showCustom ? (
              <div className={styles.customForm}>
                <input className={styles.input} placeholder="Exercise name" value={customForm.name} onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))} />
                <input className={styles.input} placeholder="Muscle group" value={customForm.muscleGroup} onChange={e => setCustomForm(f => ({ ...f, muscleGroup: e.target.value }))} />
                <button className={styles.saveBtn} onClick={handleCreateCustomExercise}>Add custom exercise</button>
              </div>
            ) : (
              <button className={styles.customToggle} onClick={() => setShowCustom(true)}>
                Can't find it? Create a custom exercise
              </button>
            )}
          </div>
        </div>
      )}

      {/* Carry-over prompt: exercise already has progress */}
      {carryPrompt && active && (
        <div className={styles.modal} onClick={() => setCarryPrompt(null)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{exMap[carryPrompt.exerciseId]?.name}</div>
            <div className={styles.carryInfo}>
              You already have progress on this exercise
              {carryPrompt.inSplits.length > 0 && <> (in <strong>{carryPrompt.inSplits.join(', ')}</strong>)</>}:
              <ul className={styles.carryList}>
                <li>{carryPrompt.count} logged session{carryPrompt.count === 1 ? '' : 's'}</li>
                {carryPrompt.last && <li>Last: {carryPrompt.last.weight}kg × {carryPrompt.last.reps} ({formatDate(carryPrompt.last.date)})</li>}
                {carryPrompt.goal && <li>Goal: {carryPrompt.goal.targetWeight}kg × {carryPrompt.goal.targetReps}</li>}
              </ul>
              Carry it over to <strong>{active.name}</strong>?
            </div>
            <button className={styles.saveSessionBtn} onClick={carryOver}>Carry over progress</button>
            <button className={styles.freshBtn} onClick={startFresh}>
              Start fresh — separate copy "{exMap[carryPrompt.exerciseId]?.name} ({active.name})"
            </button>
            <button className={styles.closeBtn} onClick={() => setCarryPrompt(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Edit exercise: rename, change muscle group, or swap for another */}
      {editEx && (
        <div className={styles.modal} onClick={() => setEditEx(null)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Edit exercise</div>
            <div className={styles.editFields}>
              <label className={styles.editLabel}>Name</label>
              <input
                className={styles.input}
                value={editForm.name}
                onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
              />
              <label className={styles.editLabel}>Muscle group</label>
              <input
                className={styles.input}
                list="muscle-groups"
                value={editForm.muscleGroup}
                onChange={e => setEditForm(f => ({ ...f, muscleGroup: e.target.value }))}
              />
              <datalist id="muscle-groups">
                {muscleGroups.map(m => <option key={m} value={m} />)}
              </datalist>
              <div className={styles.editNote}>Renaming keeps all history — it applies everywhere this exercise is used.</div>
              {editError && <div className={styles.editError}>{editError}</div>}
            </div>
            <button className={styles.saveSessionBtn} onClick={saveEdit}>Save changes</button>
            <button className={styles.freshBtn} onClick={startSwap}>⇄ Swap for a different exercise</button>
            <button className={styles.closeBtn} onClick={() => setEditEx(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* History modal */}
      {historyEx && (
        <div className={styles.modal} onClick={() => setHistoryEx(null)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{historyEx.name} — history</div>
            {historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={historyData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis domain={['auto','auto']} tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12 }}
                    formatter={(v, _n, p) => [`${v}kg (set: ${p.payload.weight}kg × ${p.payload.reps})`, 'Est. 8RM']}
                    labelFormatter={(label, payload) => {
                      const n = payload?.[0]?.payload?.exNote
                      return n ? `${label} — ✎ ${n}` : label
                    }}
                  />
                  {/* Exercise notes (e.g. a form change) as dashed markers, so a drop after them makes sense */}
                  {historyData.filter(d => d.exNote).map((d, i) => (
                    <ReferenceLine key={i} x={d.date} stroke="var(--amber)" strokeDasharray="4 4" />
                  ))}
                  <Line type="monotone" dataKey="e8" stroke="var(--blue)" strokeWidth={2} dot={{ r: 3, fill: 'var(--blue)' }} />
                </LineChart>
              </ResponsiveContainer>
            ) : <p className={styles.empty}>No sessions logged yet.</p>}
            {historyData.length > 0 && <div className={styles.chartNote}>Graph shows estimated 8RM</div>}
            {historyData.some(d => d.exNote) && (
              <div className={styles.markerList}>
                {historyData.filter(d => d.exNote).map((d, i) => (
                  <div key={i}><span className={styles.markerDash}>┆</span> {d.date}: {d.exNote}</div>
                ))}
              </div>
            )}

            {historySessions.length > 0 && (
              <div className={styles.sessionList}>
                {historySessions.map(s => editSet?.id === s.id ? (
                  <div key={s.id} className={styles.editSetBox}>
                    <div className={styles.editSetRow}>
                      <input className={styles.dateInput} type="date" max={today()} value={editSet.date} onChange={e => setEditSet(v => ({ ...v, date: e.target.value }))} />
                      <input className={styles.goalInput} type="number" inputMode="decimal" value={editSet.weight} onChange={e => setEditSet(v => ({ ...v, weight: e.target.value }))} />
                      <span className={styles.x}>kg ×</span>
                      <input className={styles.goalInput} type="number" inputMode="numeric" value={editSet.reps} onChange={e => setEditSet(v => ({ ...v, reps: e.target.value }))} />
                    </div>
                    <input className={styles.exNoteInput} placeholder="Exercise note (e.g. form upgrade)" value={editSet.exNote} onChange={e => setEditSet(v => ({ ...v, exNote: e.target.value }))} />
                    <input className={styles.exNoteInput} placeholder="Workout note (e.g. elbow pain)" value={editSet.note} onChange={e => setEditSet(v => ({ ...v, note: e.target.value }))} />
                    <div className={styles.editSetRow}>
                      <button className={styles.goalSave} onClick={saveEditSet}>Save</button>
                      <button className={styles.goalCancel} onClick={() => setEditSet(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div key={s.id} className={styles.sessionRow}>
                    <span className={styles.sessionDate}>{formatDate(s.date)}</span>
                    <span className={styles.sessionVal}>{s.weight}kg × {s.reps}{historyPRs.has(s.id) && <span className={styles.prTag}>🏆 PR</span>}</span>
                    <span className={styles.sessionEst}>≈{estimate8RMDisplay(s.weight, s.reps)}kg×8</span>
                    <button className={styles.sessionEdit} onClick={() => startEditSet(s)}>Edit</button>
                    <button className={styles.sessionDel} onClick={() => handleDeleteSession(s, historyEx)}>Delete</button>
                    {s.exNote && <span className={styles.sessionExNote}>✎ {s.exNote}</span>}
                    {s.note && <span className={styles.sessionNote}>📝 {s.note}</span>}
                  </div>
                ))}
              </div>
            )}

            <button className={styles.closeBtn} onClick={() => setHistoryEx(null)}>Close</button>
          </div>
        </div>
      )}

      {/* Delete: just this exercise's set, or the whole workout saved with it */}
      {deleteChoice && (
        <div className={styles.modal} style={{ zIndex: 60 }} onClick={() => setDeleteChoice(null)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Delete from {formatDate(deleteChoice.session.date)}</div>
            <button className={styles.deleteOneBtn} onClick={() => confirmDelete(false)}>
              Only this set — {deleteChoice.ex.name}: {deleteChoice.session.weight}kg × {deleteChoice.session.reps}
            </button>
            {deleteChoice.batch.length > 1 && (
              <button className={styles.deleteAllBtn} onClick={() => confirmDelete(true)}>
                Whole workout — all {deleteChoice.batch.length} exercises saved together
                <span className={styles.deleteList}>
                  {deleteChoice.batch.map(s => `${exName(s.exerciseId)} ${s.weight}kg × ${s.reps}`).join(' · ')}
                </span>
              </button>
            )}
            {deleteChoice.others > 0 && (
              <div className={styles.editNote}>
                {deleteChoice.others} other set{deleteChoice.others > 1 ? 's' : ''} logged that day (a separate save) stay either way.
              </div>
            )}
            <button className={styles.closeBtn} onClick={() => setDeleteChoice(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Layout>
  )
}

function GoalEditor({ exerciseId, current, onSave }) {
  const [open, setOpen] = useState(false)
  const [w, setW] = useState(current?.targetWeight?.toString() ?? '')
  const [r, setR] = useState(current?.targetReps?.toString() ?? '')

  if (!open) return (
    <button className={styles.goalToggle} onClick={() => setOpen(true)}>
      {current ? 'Edit goal' : 'Set goal'}
    </button>
  )

  return (
    <div className={styles.goalEditor}>
      <input className={styles.goalInput} type="number" placeholder="Target kg" value={w} onChange={e => setW(e.target.value)} />
      <span className={styles.x}>×</span>
      <input className={styles.goalInput} type="number" placeholder="Reps" value={r} onChange={e => setR(e.target.value)} />
      <button className={styles.goalSave} onClick={() => { if (!(parseFloat(w) >= 0) || !(parseInt(r) >= 1)) return; onSave(exerciseId, w, r); setOpen(false) }}>Save</button>
      <button className={styles.goalCancel} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}
