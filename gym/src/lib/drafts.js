// Unsaved form input survives tab switches and closing the app.
//
// Two copies are kept:
//  • localStorage — instant, synchronous reads for the forms.
//  • Capacitor Preferences (Android SharedPreferences) — the durable copy. The WebView
//    writes localStorage to disk with a few seconds' delay, so typing a set and closing
//    the app straight away could lose it. SharedPreferences is flushed to disk when the
//    app is left, so on the next launch hydrateDrafts() restores anything localStorage lost.
// Drafts are cleared once the entry is actually saved.
import { Preferences } from '@capacitor/preferences'

const PREFIX = 'gymapp:draft:'

export function loadDraft(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveDraft(key, value) {
  const raw = JSON.stringify(value)
  try { localStorage.setItem(PREFIX + key, raw) } catch { /* storage unavailable */ }
  Preferences.set({ key: PREFIX + key, value: raw }).catch(() => {})
}

export function clearDraft(key) {
  try { localStorage.removeItem(PREFIX + key) } catch { /* ignore */ }
  Preferences.remove({ key: PREFIX + key }).catch(() => {})
}

// Drop every draft — after restoring a backup, old unsaved input could point at the wrong entries
export async function clearAllDrafts() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k?.startsWith(PREFIX)) localStorage.removeItem(k)
  }
  try {
    const { keys } = await Preferences.keys()
    await Promise.all(keys.filter(k => k.startsWith(PREFIX)).map(key => Preferences.remove({ key })))
  } catch { /* best-effort */ }
}

// Run once at startup, before the app renders. The durable copy is the truth both ways:
// restore drafts localStorage lost, and drop drafts that were cleared (an entry was saved)
// but whose localStorage removal didn't reach disk — otherwise a saved set could reappear
// and be logged twice.
export async function hydrateDrafts() {
  try {
    // First launch with durable drafts: adopt any localStorage-only drafts instead of dropping them
    const MARK = 'gymapp:drafts-durable'
    if ((await Preferences.get({ key: MARK })).value == null) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(PREFIX)) await Preferences.set({ key: k, value: localStorage.getItem(k) })
      }
      await Preferences.set({ key: MARK, value: '1' })
      return
    }

    const { keys } = await Preferences.keys()
    const durable = new Set(keys.filter(k => k.startsWith(PREFIX)))
    for (const k of durable) {
      const { value } = await Preferences.get({ key: k })
      if (value != null) localStorage.setItem(k, value)
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX) && !durable.has(k)) localStorage.removeItem(k)
    }
  } catch { /* best-effort: fall back to whatever localStorage has */ }
}
