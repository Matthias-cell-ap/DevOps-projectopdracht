import { create } from 'zustand'
import { getProfile, saveProfile, recomputeAllPRs } from '../db/dal.js'
import { estimate8RM, PHASE_SETTING_KEYS, lastPhaseSettings, today } from '../lib/utils.js'
import { resolvePhase } from '../lib/phases.js'

export const useAppStore = create((set, get) => ({
  profile: null,
  profileLoaded: false,

  loadProfile: async () => {
    const profile = await getProfile()
    // One-time migration: recompute PRs that were set with the old raw-weight logic
    if (profile && !profile.prRecomputedV2) {
      await recomputeAllPRs(estimate8RM)
      profile.prRecomputedV2 = true
      await saveProfile(profile)
    }
    set({ profile, profileLoaded: true })
  },

  updateProfile: async (updates) => {
    const current = get().profile
    const next = { ...current, ...updates }
    await saveProfile(next)
    set({ profile: next })
  },

  setPhase: async (phase) => {
    const current = get().profile
    if (current.phase === phase) return
    const date = today()
    // Record the outgoing phase with its readable name, plus its targets + colour rules,
    // so its days keep being judged by them and returning to it restores them
    const outgoing = resolvePhase(current, current.phase)
    const settings = {}
    for (const k of PHASE_SETTING_KEYS) if (current[k] !== undefined) settings[k] = current[k]
    const history = [...(current.phaseHistory ?? []),
      { phase: current.phase, name: outgoing.name, from: current.phaseStartDate, to: date, settings }]
    // Back to a phase you've done before → its settings; new phase → same targets, its type's colour rules
    const restored = lastPhaseSettings({ phaseHistory: history }, phase) ?? { colorModes: undefined }
    const next = { ...current, ...restored, phase, phaseStartDate: date, phaseHistory: history }
    await saveProfile(next)
    set({ profile: next })
  },

  createCustomPhase: async ({ name, description, baseType, progressionMode }) => {
    const current = get().profile
    const id = 'custom-' + Date.now()
    const def = { id, name, description, baseType }
    // Empty = auto (follows baseType: cut → hold, otherwise progress)
    if (progressionMode) def.progressionMode = progressionMode
    const customPhases = [...(current.customPhases ?? []), def]
    const next = { ...current, customPhases }
    await saveProfile(next)
    set({ profile: next })
    return id
  },

  deleteCustomPhase: async (id) => {
    const current = get().profile
    const customPhases = (current.customPhases ?? []).filter(p => p.id !== id)
    const next = { ...current, customPhases }
    await saveProfile(next)
    set({ profile: next })
  },
}))
