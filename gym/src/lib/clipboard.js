import { Capacitor } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'

export async function copyToClipboard(text) {
  if (Capacitor.isNativePlatform()) {
    await Clipboard.write({ string: text })
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
  } else {
    // Fallback for older browsers
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}
