import { useState, useEffect } from 'react'
import Layout from '../components/Layout.jsx'
import { getSchedule, saveScheduleDay, getSessionTypes } from '../db/dal.js'
import styles from './Schedule.module.css'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Display order: Monday first, Sunday last (day numbers stay JS getDay() compatible)
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const TYPES = ['gym', 'sport', 'rest', 'other']
// Older schedules may use 'karate' (it was a type before 'sport'); it keeps working as-is
const LEGACY_TYPES = ['karate']

export default function Schedule() {
  const [schedule, setSchedule] = useState([])
  const [sessionTypes, setSessionTypes] = useState([])
  const [editing, setEditing] = useState(null)
  const todayDay = new Date().getDay()

  useEffect(() => {
    Promise.all([getSchedule(), getSessionTypes()]).then(([sched, types]) => {
      setSchedule(sched)
      setSessionTypes(types)
    })
  }, [])

  const handleSave = async (day) => {
    await saveScheduleDay(day)
    setSchedule(await getSchedule())
    setEditing(null)
  }

  const sessionName = (id) => sessionTypes.find(t => t.id === id)?.name ?? null

  const orderedDays = DAY_ORDER
    .map(n => schedule.find(s => s.day === n))
    .filter(Boolean)

  return (
    <Layout title="Schedule">
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Weekly template</div>
        {orderedDays.map(day => (
          <div key={day.day} className={`${styles.dayRow} ${day.day === todayDay ? styles.today : ''}`}>
            {editing === day.day ? (
              <DayEditor day={day} sessionTypes={sessionTypes} onSave={handleSave} onCancel={() => setEditing(null)} />
            ) : (
              <>
                <span className={styles.dayName}>{DAY_NAMES[day.day]}</span>
                <span className={styles.dayLabel}>
                  {day.label}
                  {day.type === 'gym' && sessionName(day.sessionTypeId) && (
                    <span className={styles.sessionTag}> → {sessionName(day.sessionTypeId)}</span>
                  )}
                </span>
                <span className={`${styles.badge} ${styles[day.type]}`}>{day.type}</span>
                <button className={styles.editBtn} onClick={() => setEditing(day.day)}>Edit</button>
              </>
            )}
          </div>
        ))}
      </div>
    </Layout>
  )
}

function DayEditor({ day, sessionTypes, onSave, onCancel }) {
  const [form, setForm] = useState({ ...day })

  const handleSave = () => {
    const next = { ...form }
    // Auto-fill label from the linked session if it's empty or still a leftover
    // type/split name (e.g. "Rest" after turning a rest day into a gym day)
    const label = next.label.trim().toLowerCase()
    const leftover = !label || [...TYPES, ...LEGACY_TYPES].includes(label) || sessionTypes.some(t => t.name.toLowerCase() === label)
    if (next.type === 'gym' && next.sessionTypeId && leftover) {
      next.label = sessionTypes.find(t => t.id === next.sessionTypeId)?.name ?? next.label
    }
    if (next.type !== 'gym') next.sessionTypeId = null
    onSave(next)
  }

  return (
    <div className={styles.editor}>
      <select className={styles.select} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
        {(TYPES.includes(day.type) ? TYPES : [...TYPES, day.type]).map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <input className={styles.input} value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Label" />
      {form.type === 'gym' && (
        sessionTypes.length > 0 ? (
          <select
            className={styles.select}
            value={form.sessionTypeId ?? ''}
            onChange={e => setForm(f => ({ ...f, sessionTypeId: e.target.value ? parseInt(e.target.value) : null }))}
          >
            <option value="">No linked session</option>
            {sessionTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : (
          <div className={styles.hint}>Create sessions in the Gym tab first to link one here.</div>
        )
      )}
      <div className={styles.editorBtns}>
        <button className={styles.saveBtn} onClick={handleSave}>Save</button>
        <button className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
