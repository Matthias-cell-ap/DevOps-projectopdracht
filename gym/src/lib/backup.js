import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { exportAll, importAll } from '../db/dal.js'

const isNative = () => Capacitor.isNativePlatform()

function filename() {
  return `gym-backup-${new Date().toISOString().split('T')[0]}.json`
}

// ── EXPORT ────────────────────────────────────────────────
// Returns the saved location (string) so the UI can tell the user where it went.
export async function exportBackup() {
  const data = await exportAll()
  const json = JSON.stringify(data, null, 2)

  if (isNative()) {
    // Save directly into the device's Documents folder
    const name = filename()
    await Filesystem.writeFile({
      path: name,
      data: json,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    })
    return `Documents/${name}`
  } else {
    // Web: classic download
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename()
    a.click()
    URL.revokeObjectURL(url)
    return 'your Downloads folder'
  }
}

// ── IMPORT ────────────────────────────────────────────────
// On both platforms we use a hidden file input — the native WebView
// surfaces the Android document picker for it, which is reliable.
export function importBackup(onDone) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      await importAll(data)
      onDone?.(true)
    } catch (err) {
      onDone?.(false, err)
    }
  }
  input.click()
}
