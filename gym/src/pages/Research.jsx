import { useState, useEffect } from 'react'
import Layout from '../components/Layout.jsx'
import { getResearch, saveResearch, deleteResearch } from '../db/dal.js'
import { loadDraft, saveDraft, clearDraft } from '../lib/drafts.js'
import styles from './Research.module.css'

const STATUSES = ['researching', 'active', 'dropped']
const EMPTY_NOTE = { title: '', body: '', status: 'researching' }

export default function Research() {
  const [items, setItems] = useState([])
  // A half-written new note survives tab switches and closing the app
  const [addForm, setAddForm] = useState(() => loadDraft('research:new') ?? EMPTY_NOTE)
  const [showAdd, setShowAdd] = useState(() => !!loadDraft('research:new'))

  useEffect(() => {
    if (addForm.title || addForm.body) saveDraft('research:new', addForm)
    else clearDraft('research:new')
  }, [addForm])

  const load = () => getResearch().then(data => setItems(data))
  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    if (!addForm.title.trim()) return
    const all = await getResearch()
    await saveResearch({
      title: addForm.title.trim(),
      body: addForm.body,
      status: addForm.status,
      createdAt: new Date().toISOString(),
      order: all.length,
    })
    clearDraft('research:new')
    setAddForm(EMPTY_NOTE)
    setShowAdd(false)
    load()
  }

  const handleUpdate = async (item) => {
    await saveResearch(item)
    load()
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this note?')) return
    await deleteResearch(id)
    load()
  }

  return (
    <Layout title="Research" right={<button className={styles.addBtn} onClick={() => setShowAdd(v => !v)}>+ Note</button>}>

      {showAdd && (
        <div className={styles.addCard}>
          <input className={styles.input} placeholder="Title" value={addForm.title} onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))} />
          <textarea className={styles.textarea} placeholder="Notes…" value={addForm.body} onChange={e => setAddForm(f => ({ ...f, body: e.target.value }))} rows={3} />
          <select className={styles.input} value={addForm.status} onChange={e => setAddForm(f => ({ ...f, status: e.target.value }))}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className={styles.saveBtn} onClick={handleAdd}>Save note</button>
        </div>
      )}

      <div className={styles.section}>
        {items.length === 0 && <p className={styles.empty}>No notes yet. Tap + Note to add your first.</p>}
        {items.map(item => (
          <NoteCard
            key={item.id}
            item={item}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </Layout>
  )
}

function NoteCard({ item, onUpdate, onDelete }) {
  // An unfinished edit of this note is restored (and the card reopened in edit mode)
  const draftKey = `research:${item.id}`
  const [expanded, setExpanded] = useState(() => !!loadDraft(draftKey))
  const [editing, setEditing] = useState(() => !!loadDraft(draftKey))
  const [form, setForm] = useState(() => loadDraft(draftKey) ?? { ...item })

  useEffect(() => {
    if (editing) saveDraft(draftKey, form)
    else clearDraft(draftKey)
  }, [editing, form, draftKey])

  const handleSave = () => {
    clearDraft(draftKey)
    onUpdate(form)
    setEditing(false)
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader} onClick={() => setExpanded(v => !v)}>
        <div>
          <div className={styles.cardTitle}>{item.title}</div>
          {!expanded && item.body && <div className={styles.cardPreview}>{item.body.slice(0, 80)}{item.body.length > 80 ? '…' : ''}</div>}
        </div>
        <div className={styles.cardRight}>
          <span className={`${styles.status} ${styles[item.status]}`}>{item.status}</span>
          <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className={styles.expanded}>
          {editing ? (
            <>
              <input className={styles.input} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
              <textarea className={styles.textarea} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} rows={5} />
              <select className={styles.input} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className={styles.editBtns}>
                <button className={styles.saveBtn} onClick={handleSave}>Save</button>
                <button className={styles.cancelBtn} onClick={() => { setEditing(false); setForm({ ...item }) }}>Cancel</button>
                <button className={styles.deleteBtn} onClick={() => onDelete(item.id)}>Delete</button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.body}>{item.body || <span className={styles.empty}>No content.</span>}</p>
              <button className={styles.editToggle} onClick={() => setEditing(true)}>Edit note</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
