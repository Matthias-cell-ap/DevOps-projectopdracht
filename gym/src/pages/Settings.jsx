import { useState, useEffect } from 'react'
import Layout from '../components/Layout.jsx'
import { useAppStore } from '../store/useAppStore.js'
import { loadDraft, saveDraft, clearDraft } from '../lib/drafts.js'
import { allPhases, resolvePhase, phaseClass, phaseEnd } from '../lib/phases.js'
import { defaultColorModes, lastPhaseSettings, daysSince } from '../lib/utils.js'
import styles from './Settings.module.css'

const MACRO_KEYS = [
  { key: 'kcal',    label: 'Kcal' },
  { key: 'protein', label: 'Protein' },
  { key: 'carbs',   label: 'Carbs' },
  { key: 'fat',     label: 'Fat' },
  { key: 'sugar',   label: 'Sugar' },
  { key: 'salt',    label: 'Salt' },
]
const COLOR_MODES = [
  { id: 'under', label: 'At or under goal' },
  { id: 'near',  label: 'Close to goal' },
  { id: 'over',  label: 'At or over goal' },
]

// Profile fields this page edits (and therefore keeps as a draft until saved)
const EDITABLE_KEYS = [
  'goalKcal', 'goalProtein', 'goalCarbs', 'goalFat', 'goalSugar', 'goalSalt',
  'height', 'age', 'experience', 'trainingInfo', 'personalPlan',
  'graphYMin', 'graphYMax', 'showTrendLine', 'trendDays', 'showRateOfChange',
  'colorModes', 'colorGreenPct', 'colorAmberPct',
  'weightSuggestions', 'progMinReps', 'progMaxReps',
]

const EXPERIENCES = ['beginner', 'intermediate', 'advanced']
const BASE_TYPES = [
  { id: 'cut', label: 'Cut (red)' },
  { id: 'bulk', label: 'Bulk (green)' },
  { id: 'maintain', label: 'Maintain (blue)' },
  { id: 'neutral', label: 'Neutral (grey)' },
]

export default function Settings() {
  const { profile, updateProfile, setPhase, loadProfile, createCustomPhase, deleteCustomPhase } = useAppStore()
  const [form, setForm] = useState(null)
  const [saved, setSaved] = useState(false)
  const [showNewPhase, setShowNewPhase] = useState(false)
  const [newPhase, setNewPhase] = useState({ name: '', description: '', baseType: 'neutral', progressionMode: '' })
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Unsaved edits survive tab switches, closing the app and phase changes.
  // Only the editable fields are kept, so restoring can't overwrite newer profile data.
  useEffect(() => {
    if (profile) setForm({ ...profile, ...(loadDraft('settings') ?? {}) })
  }, [profile])

  const changes = {}
  if (form && profile) {
    for (const k of EDITABLE_KEYS) {
      if (JSON.stringify(form[k] ?? null) !== JSON.stringify(profile[k] ?? null)) changes[k] = form[k]
    }
  }
  const hasChanges = Object.keys(changes).length > 0

  useEffect(() => {
    if (!form || !profile) return
    if (hasChanges) saveDraft('settings', changes)
    else clearDraft('settings')
  }, [form]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) return null

  const handleSave = async () => {
    clearDraft('settings')
    await updateProfile(changes)   // only what was edited — never stale copies of other fields
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handlePhaseChange = async (phaseId) => {
    const p = useAppStore.getState().profile   // fresh — a just-created phase isn't in this render's profile yet
    if (p.phase === phaseId) return
    const def = resolvePhase(p, phaseId)
    const restores = !!lastPhaseSettings(p, phaseId)
    const msg = `Switch to "${def.name}"? Today becomes its start date.\n\n` +
      `Your current targets and colour rules stay saved with "${resolvePhase(p).name}", so its days keep their colours.\n` +
      (restores
        ? `"${def.name}" gets back the targets and colour rules you had last time.`
        : `"${def.name}" starts with your current targets and its own default colour rules — adjust them under Daily targets.`) +
      (hasChanges ? '\n\nYour unsaved changes are saved first.' : '')
    if (!confirm(msg)) return
    if (hasChanges) { clearDraft('settings'); await updateProfile(changes) }
    await setPhase(phaseId)
    await loadProfile()
  }

  const handleCreatePhase = async () => {
    if (!newPhase.name.trim()) return
    const id = await createCustomPhase({
      name: newPhase.name.trim(),
      description: newPhase.description.trim(),
      baseType: newPhase.baseType,
      progressionMode: newPhase.progressionMode,
    })
    setNewPhase({ name: '', description: '', baseType: 'neutral', progressionMode: '' })
    setShowNewPhase(false)
    await loadProfile()
    // Optionally switch to it right away (same flow as tapping it)
    await handlePhaseChange(id)
  }

  const handleDeletePhase = async (id, name) => {
    if (profile.phase === id) { alert('Cannot delete the phase you are currently in.'); return }
    if (!confirm(`Delete custom phase "${name}"? (History entries stay intact.)`)) return
    await deleteCustomPhase(id)
    await loadProfile()
  }

  const phases = allPhases(profile)
  const activePhase = resolvePhase(profile)

  const f = (key) => ({ value: form[key] ?? '', onChange: e => setForm(p => ({ ...p, [key]: e.target.value })) })

  const daysInPhase = daysSince(profile?.phaseStartDate)

  return (
    <Layout title="Settings">

      {/* Phase */}
      <div className={styles.section}>
        <div className={styles.sectionLabelRow}>
          <span className={styles.sectionLabel}>Phase</span>
          <button className={styles.aiGoalBtn} onClick={() => setShowNewPhase(v => !v)}>
            {showNewPhase ? 'Cancel' : '+ New phase'}
          </button>
        </div>
        <div className={styles.card}>
          <div className={styles.phaseGrid}>
            {phases.map(p => (
              <div key={p.id} className={styles.phaseWrap}>
                <button
                  className={`${styles.phaseBtn} ${profile?.phase === p.id ? styles[phaseClass(p.baseType)] : ''}`}
                  onClick={() => handlePhaseChange(p.id)}
                >
                  {p.name}
                </button>
                {p.id.startsWith('custom-') && (
                  <button className={styles.phaseDel} onClick={() => handleDeletePhase(p.id, p.name)}>×</button>
                )}
              </div>
            ))}
          </div>

          {/* New custom phase form */}
          {showNewPhase && (
            <div className={styles.newPhaseForm}>
              <input className={styles.input} placeholder="Phase name (e.g. Recomp week)" value={newPhase.name} onChange={e => setNewPhase(p => ({ ...p, name: e.target.value }))} />
              <textarea className={styles.textareaSmall} rows={2} placeholder="Description (e.g. eat at maintenance for a week to gauge where I stand)" value={newPhase.description} onChange={e => setNewPhase(p => ({ ...p, description: e.target.value }))} />
              <select className={styles.select} value={newPhase.baseType} onChange={e => setNewPhase(p => ({ ...p, baseType: e.target.value }))}>
                {BASE_TYPES.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
              <label className={styles.fieldLabel}>Gym weight suggestions during this phase</label>
              <select className={styles.select} value={newPhase.progressionMode} onChange={e => setNewPhase(p => ({ ...p, progressionMode: e.target.value }))}>
                <option value="">Auto (cut colour = hold, otherwise progress)</option>
                <option value="progress">Progress — push for more reps / weight</option>
                <option value="hold">Hold — maintain current strength</option>
                <option value="off">Off — no suggestions</option>
              </select>
              <button className={styles.saveBtn} onClick={handleCreatePhase}>Create phase</button>
            </div>
          )}

          <div className={styles.phaseMeta}>
            <strong>{activePhase.name}</strong> · started {profile?.phaseStartDate} — {daysInPhase} days ago
          </div>
          {activePhase.description && <div className={styles.phaseDesc}>{activePhase.description}</div>}

          {profile?.phaseHistory?.length > 0 && (
            <div className={styles.phaseHistory}>
              <div className={styles.histLabel}>History</div>
              {profile.phaseHistory.map((h, i) => (
                <div key={i} className={styles.histRow}>
                  {h.name ?? h.phase} · {h.from} → {phaseEnd(h)}
                  {h.settings?.goalKcal ? ` · ${h.settings.goalKcal} kcal` : ''}
                  {h.settings?.goalProtein ? ` / ${h.settings.goalProtein}g protein` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Macro goals */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Daily targets — {activePhase.name}</div>
        <div className={styles.noteHint}>Saved per phase: switching phase keeps these with {activePhase.name}, so its days keep their colours.</div>
        <div className={styles.card}>
          <div className={styles.grid2}>
            <Field label="Kcal goal" {...f('goalKcal')} type="number" />
            <Field label="Protein (g)" {...f('goalProtein')} type="number" />
            <Field label="Carbs (g)" {...f('goalCarbs')} type="number" />
            <Field label="Fat (g)" {...f('goalFat')} type="number" />
            <Field label="Sugar (g)" {...f('goalSugar')} type="number" />
            <Field label="Salt (g)" {...f('goalSalt')} type="number" />
          </div>
        </div>
      </div>

      {/* Profile */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Profile</div>
        <div className={styles.card}>
          <div className={styles.grid2}>
            <Field label="Height (cm)" {...f('height')} type="number" />
            <Field label="Age" {...f('age')} type="number" />
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Experience</label>
              <select className={styles.select} value={form.experience ?? ''} onChange={e => setForm(p => ({ ...p, experience: e.target.value }))}>
                <option value="">—</option>
                {EXPERIENCES.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Training info */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Training info</div>
        <div className={styles.noteHint}>Injuries, limitations, dietary notes, training context — anything worth knowing about you. Included when you copy your profile (e.g. for an AI chat on the Data tab).</div>
        <textarea
          className={styles.textarea}
          rows={5}
          placeholder="e.g. Left shoulder impingement — avoid heavy overhead pressing. Karate twice a week (Tue + Sat), affects leg recovery. No dairy. Tracking macros in Yazio."
          {...f('trainingInfo')}
        />
      </div>

      {/* Personal plan */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Personal plan</div>
        <div className={styles.noteHint}>Your goals, intentions, and what you want to achieve. Included when you copy your profile for an AI chat.</div>
        <textarea
          className={styles.textarea}
          rows={5}
          placeholder="e.g. Currently cutting to get lean before summer. Want to hit 100kg bench by end of year. Priority is keeping strength while losing fat. After the cut, planning a 12-week lean bulk."
          {...f('personalPlan')}
        />
      </div>

      {/* Save */}
      <div className={styles.section}>
        <button className={styles.saveBtn} onClick={handleSave}>
          {saved ? '✓ Saved' : hasChanges ? 'Save changes • unsaved' : 'Save profile'}
        </button>
      </div>

      {/* Advanced — set-once options, collapsed by default */}
      <div className={styles.section}>
        <button className={styles.advancedToggle} onClick={() => setShowAdvanced(v => !v)}>
          <span>Advanced</span>
          <span className={styles.advancedChevron}>{showAdvanced ? '▲' : '▼'}</span>
        </button>
      </div>

      {showAdvanced && (
        <>
          {/* Graph settings */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Graph</div>
            <div className={styles.card}>
              <div className={styles.grid2}>
                <Field label="Y-axis min (kg)" {...f('graphYMin')} type="number" step="0.1" />
                <Field label="Y-axis max (kg)" {...f('graphYMax')} type="number" step="0.1" />
              </div>
              <div className={styles.noteHint} style={{ marginTop: 6 }}>Leave blank for auto-scale. Example: min 70, max 80 to zoom into that range.</div>

              <div className={styles.divider} />

              <div className={styles.toggleRow}>
                <div>
                  <div className={styles.toggleLabel}>Smoothed trend line</div>
                  <div className={styles.toggleHint}>Adds a rolling-average line over the raw weight — cuts through daily water noise.</div>
                </div>
                <div
                  className={`${styles.toggle} ${form.showTrendLine ? '' : styles.toggleOff}`}
                  onClick={() => setForm(p => ({ ...p, showTrendLine: !p.showTrendLine }))}
                />
              </div>

              <div className={styles.toggleRow}>
                <div>
                  <div className={styles.toggleLabel}>Rate of change</div>
                  <div className={styles.toggleHint}>Shows kg/week under the graph: your average weight over the first few days of the range vs the last few days, so water weight doesn't skew it.</div>
                </div>
                <div
                  className={`${styles.toggle} ${form.showRateOfChange ? '' : styles.toggleOff}`}
                  onClick={() => setForm(p => ({ ...p, showRateOfChange: !p.showRateOfChange }))}
                />
              </div>

              {(form.showTrendLine || form.showRateOfChange) && (
                <div className={styles.grid2} style={{ marginTop: 8 }}>
                  <Field label="Smoothing window (days)" {...f('trendDays')} type="number" step="1" />
                </div>
              )}
            </div>
          </div>

          {/* Color rules */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Color rules — {activePhase.name}</div>
            <div className={styles.noteHint}>Per macro: when does it show green? E.g. set Kcal to "At or under goal" during a cut so under-eating is green, only going over gets flagged.</div>
            <div className={styles.card}>
              {MACRO_KEYS.map(m => (
                <div key={m.key} className={styles.colorRow}>
                  <span className={styles.colorLabel}>{m.label} — green when</span>
                  <select
                    className={styles.select}
                    style={{ width: 'auto', flex: 1 }}
                    value={form.colorModes?.[m.key] ?? defaultColorModes(activePhase.baseType)[m.key]}
                    onChange={e => setForm(p => ({ ...p, colorModes: { ...(p.colorModes ?? {}), [m.key]: e.target.value } }))}
                  >
                    {COLOR_MODES.map(cm => <option key={cm.id} value={cm.id}>{cm.label}</option>)}
                  </select>
                </div>
              ))}
              <div className={styles.grid2} style={{ marginTop: 10 }}>
                <Field label="Green margin (%)" {...f('colorGreenPct')} type="number" step="1" />
                <Field label="Amber margin (%)" {...f('colorAmberPct')} type="number" step="1" />
              </div>
              <div className={styles.noteHint} style={{ marginTop: 6 }}>Defaults: green within 5%, amber within 15%, red beyond. Margins apply in the penalised direction only.</div>
            </div>
          </div>

          {/* Gym — next-set weight suggestions */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Gym</div>
            <div className={styles.card}>
              <div className={styles.toggleRow} style={{ marginTop: 0 }}>
                <div>
                  <div className={styles.toggleLabel}>Next-set weight suggestions</div>
                  <div className={styles.toggleHint}>Suggests your next top set from your last one. Calculated in the app itself.</div>
                </div>
                <div
                  className={`${styles.toggle} ${form.weightSuggestions ? '' : styles.toggleOff}`}
                  onClick={() => setForm(p => ({ ...p, weightSuggestions: !p.weightSuggestions }))}
                />
              </div>

              {form.weightSuggestions && (
                <>
                  <div className={styles.grid2} style={{ marginTop: 10 }}>
                    <Field label="Rep range min" {...f('progMinReps')} type="number" step="1" />
                    <Field label="Rep range max" {...f('progMaxReps')} type="number" step="1" />
                  </div>
                  <div className={styles.noteHint} style={{ marginTop: 6 }}>
                    Default range: 6–10 reps.
                    Held the same reps for a week → +1 rep. A week at the top of the range → add weight (sized to your strength, with a 1-rep buffer). Dropped below your reps → back to your level first, and the week restarts. Too heavy → lighter right away. Can't make the step for a whole week → stalling.
                    Cut = hold strength, Bulk/Maintain = progress, custom phases = whatever you chose when creating them.
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Save (advanced changes still need saving) */}
          <div className={styles.section}>
            <button className={styles.saveBtn} onClick={handleSave}>
              {saved ? '✓ Saved' : hasChanges ? 'Save changes • unsaved' : 'Save advanced settings'}
            </button>
          </div>
        </>
      )}

    </Layout>
  )
}

function Field({ label, type = 'text', step, value, onChange, placeholder }) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>{label}</label>
      <input className={styles.input} type={type} step={step} value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  )
}
