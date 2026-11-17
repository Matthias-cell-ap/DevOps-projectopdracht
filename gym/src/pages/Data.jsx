import { useState, useEffect } from 'react'
import Layout from '../components/Layout.jsx'
import CopyPanel from '../components/CopyPanel.jsx'
import { useAppStore } from '../store/useAppStore.js'
import { exportBackup, importBackup } from '../lib/backup.js'
import { copyToClipboard } from '../lib/clipboard.js'
import { buildImportPrompt, parseImport, analyzeImport, applyImport } from '../lib/notesImport.js'
import { loadDraft, saveDraft, clearDraft, clearAllDrafts } from '../lib/drafts.js'
import { formatDate } from '../lib/utils.js'
import styles from './Data.module.css'

// Everything for getting data in and out: copy as text, backups, and importing old notes.
export default function Data() {
  const { profile } = useAppStore()

  const handleExport = async () => {
    try {
      const location = await exportBackup()
      alert('Backup saved to ' + location)
    } catch (e) {
      alert('Export failed: ' + (e?.message ?? e))
    }
  }

  const handleImport = () => {
    if (!confirm('Restore from a backup file?\n\nThis REPLACES everything in the app with what\'s in the backup. Anything logged after that backup was made is lost.\n\nNot sure? Export a backup of the current data first.')) return
    importBackup(async (ok, err) => {
      if (ok) {
        // Old unsaved input could point at entries that no longer exist — start clean
        await clearAllDrafts()
        alert('Backup restored.')
        window.location.reload()
      } else {
        alert('Import failed — not a valid backup file.' + (err ? '\n' + err.message : ''))
      }
    })
  }

  if (!profile) return null

  return (
    <Layout title="Data">
      {/* Copy as text */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Copy data</div>
        <div className={styles.noteHint}>Copy your data as text — for a spreadsheet, your notes, or to ask an AI chat about it.</div>
        <div className={styles.card}>
          <CopyPanel profile={profile} />
        </div>
      </div>

      {/* Backups */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Backup</div>
        <div className={styles.noteHint}>
          A backup file holds everything in the app. Export one regularly and always before updating the app.
          It's your personal data — keep it somewhere private.
        </div>
        <div className={styles.dataRow}>
          <button className={styles.dataBtn} onClick={handleExport}>⤓ Export backup</button>
          <button className={styles.dataBtn} onClick={handleImport}>⤒ Restore backup</button>
        </div>
      </div>

      {/* Old notes → app data, via any AI chat */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Import from old notes</div>
        <div className={styles.noteHint}>
          Kept your weight, food or lifts in a notes app? An AI chat can turn those notes into data for this app.
        </div>
        <div className={styles.card}>
          <NotesImport />
        </div>
      </div>
    </Layout>
  )
}

function NotesImport() {
  // The pasted answer survives tab switches and closing the app, like every other input
  const [text, setText] = useState(() => loadDraft('import:json') ?? '')
  const [result, setResult] = useState(null)   // { error } | { plan }
  const [promptMsg, setPromptMsg] = useState('')
  const [doneMsg, setDoneMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (text) saveDraft('import:json', text)
    else clearDraft('import:json')
  }, [text])

  const copyPrompt = async () => {
    try {
      await copyToClipboard(await buildImportPrompt())
      setPromptMsg('✓ Prompt copied')
    } catch (e) {
      setPromptMsg('Copy failed: ' + (e?.message ?? e))
    }
  }

  const check = async () => {
    setDoneMsg('')
    const parsed = parseImport(text)
    if (parsed.error) { setResult({ error: parsed.error }); return }
    setResult({ plan: await analyzeImport(parsed) })
  }

  const doImport = async () => {
    setBusy(true)
    try {
      const r = await applyImport(result.plan)
      setDoneMsg(`✓ Imported ${r.days} day${r.days === 1 ? '' : 's'} and ${r.sets} set${r.sets === 1 ? '' : 's'}` +
        (r.exercises ? ` (${r.exercises} new exercise${r.exercises === 1 ? '' : 's'})` : '') +
        '. Find them in Log → All time, and in each exercise\'s History on the Gym tab.')
      setResult(null)
      setText('')
    } catch (e) {
      setDoneMsg('Import failed: ' + (e?.message ?? e))
    }
    setBusy(false)
  }

  const plan = result?.plan
  const nothingToDo = plan && plan.newDays + plan.filledDays + plan.setPlan.length === 0

  return (
    <div className={styles.steps}>
      <div className={styles.step}>
        <span className={styles.stepNum}>1</span>
        <div className={styles.stepBody}>
          <button className={styles.copyBtn} onClick={copyPrompt}>⧉ Copy prompt</button>
          {promptMsg && <span className={styles.ok}> {promptMsg}</span>}
          <div className={styles.stepText}>
            Paste it into ChatGPT, Claude, Gemini, … put your notes underneath it, and send.
            Lots of notes? Do a few months at a time.
          </div>
        </div>
      </div>

      <div className={styles.step}>
        <span className={styles.stepNum}>2</span>
        <div className={styles.stepBody}>
          <div className={styles.stepText}>Copy the AI's whole answer and paste it here:</div>
          <textarea
            className={styles.textarea}
            rows={5}
            placeholder={'{ "days": [ … ], "sets": [ … ] }'}
            value={text}
            onChange={e => { setText(e.target.value); setResult(null) }}
          />
          <button className={styles.checkBtn} onClick={check} disabled={!text.trim()}>Check</button>
        </div>
      </div>

      {result?.error && <div className={styles.error}>{result.error}</div>}

      {plan && (
        <div className={styles.preview}>
          <div className={styles.previewTitle}>
            Found data from {formatDate(plan.from)} to {formatDate(plan.to)}
          </div>
          <ul className={styles.previewList}>
            {plan.newDays > 0 && <li>{plan.newDays} new day{plan.newDays === 1 ? '' : 's'} (weight, food, …)</li>}
            {plan.filledDays > 0 && <li>{plan.filledDays} day{plan.filledDays === 1 ? '' : 's'} already in the app — only empty fields get filled, nothing is overwritten</li>}
            {plan.sameDays > 0 && <li className={styles.dim}>{plan.sameDays} day{plan.sameDays === 1 ? '' : 's'} already complete — skipped</li>}
            {plan.setPlan.length > 0 && (
              <li>
                {plan.setPlan.length} set{plan.setPlan.length === 1 ? '' : 's'}
                {plan.matchedExercises > 0 && ` · ${plan.matchedExercises} exercise${plan.matchedExercises === 1 ? '' : 's'} matched to your list`}
              </li>
            )}
            {plan.duplicates > 0 && <li className={styles.dim}>{plan.duplicates} set{plan.duplicates === 1 ? '' : 's'} already logged — skipped</li>}
          </ul>

          {plan.newExercises.length > 0 && (
            <div className={styles.newEx}>
              <div className={styles.newExTitle}>New exercises that will be created — check the spelling:</div>
              {plan.newExercises.map(n => (
                <div key={n.key} className={styles.newExRow}>{n.name} <span className={styles.dim}>· {n.muscleGroup} · {n.count} set{n.count === 1 ? '' : 's'}</span></div>
              ))}
              <div className={styles.dim}>Misspelled? Fix it in the answer above and press Check again.</div>
            </div>
          )}

          {plan.skipped.length > 0 && (
            <details className={styles.skipped}>
              <summary>{plan.skipped.length} entr{plan.skipped.length === 1 ? 'y' : 'ies'} skipped (unreadable or unrealistic)</summary>
              {plan.skipped.slice(0, 30).map((s, i) => <div key={i}>{s}</div>)}
              {plan.skipped.length > 30 && <div>…and {plan.skipped.length - 30} more</div>}
            </details>
          )}

          {nothingToDo ? (
            <div className={styles.dim}>Nothing new to import — all of this is already in the app.</div>
          ) : (
            <>
              <div className={styles.dim} style={{ margin: '8px 0' }}>Tip: export a backup first, so you can go back if something looks off.</div>
              <button className={styles.importBtn} onClick={doImport} disabled={busy}>
                {busy ? 'Importing…' : 'Import'}
              </button>
            </>
          )}
        </div>
      )}

      {doneMsg && <div className={styles.ok}>{doneMsg}</div>}
    </div>
  )
}
