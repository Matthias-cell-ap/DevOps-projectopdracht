// Built-in phase presets. Custom phases live in profile.customPhases.
// progressionMode drives gym weight suggestions: 'progress' | 'hold' | 'off'
export const BUILTIN_PHASES = [
  { id: 'cut',      name: 'Cut',      baseType: 'cut',      progressionMode: 'hold',     description: 'Lose fat, preserve muscle' },
  { id: 'bulk',     name: 'Bulk',     baseType: 'bulk',     progressionMode: 'progress', description: 'Gain lean muscle, minimise fat' },
  { id: 'maintain', name: 'Maintain', baseType: 'maintain', progressionMode: 'progress', description: 'Maintain composition' },
]

// Map a baseType to a CSS color variable used for banners/dots.
export function phaseColor(baseType) {
  switch (baseType) {
    case 'cut':      return 'var(--red)'
    case 'bulk':     return 'var(--green)'
    case 'maintain': return 'var(--blue)'
    default:         return 'var(--text-muted)'
  }
}

// CSS class suffix used by Dashboard/Settings banner styling.
export function phaseClass(baseType) {
  if (baseType === 'cut' || baseType === 'bulk' || baseType === 'maintain') return baseType
  return 'neutral'
}

// Resolve an active phase id (built-in or custom) to its full definition.
export function resolvePhase(profile, id = profile?.phase) {
  if (!id) return BUILTIN_PHASES[0]
  const builtin = BUILTIN_PHASES.find(p => p.id === id)
  if (builtin) return builtin
  const custom = (profile?.customPhases ?? []).find(p => p.id === id)
  if (custom) return custom
  // Fallback for an unknown/deleted id — show the raw id as the name
  return { id, name: id, baseType: 'neutral', description: '' }
}

// Last day of a past phase. History stores the switch date as `to`, but that day already
// belongs to the next phase — so a phase ends the day before (unless it lasted only that day).
export function phaseEnd(h) {
  if (!h?.to || !h.from || h.to <= h.from) return h?.to
  const [y, m, d] = h.to.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

// Display name of a past phase entry
export const historyName = (h) => h.name ?? (h.phase.charAt(0).toUpperCase() + h.phase.slice(1))

// Date ranges to pick from: the current phase, then every past phase (newest first).
export function phaseRanges(profile, todayStr) {
  if (!profile) return []
  const active = resolvePhase(profile)
  const out = [{ id: 'current', name: `${active.name} (current)`, label: `${active.name} (current)`, from: profile.phaseStartDate, to: todayStr }]
  ;[...(profile.phaseHistory ?? [])].reverse().forEach((h, i) => {
    const name = historyName(h)
    const to = phaseEnd(h)
    out.push({ id: `h${i}`, name, label: `${name} (${h.from} – ${to})`, from: h.from, to })
  })
  return out
}

// All phases available to pick from (built-ins + custom).
export function allPhases(profile) {
  return [...BUILTIN_PHASES, ...(profile?.customPhases ?? [])]
}
