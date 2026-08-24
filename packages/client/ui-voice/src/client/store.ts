import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { WakeReadiness } from './wake-word-adapter.ts'

/** Browser-local voice preferences and wake calibration display state. */
export interface VoiceSettingsState {
  handsFreeEnabled: boolean
  wakeReadiness: WakeReadiness
}

type VoiceSettingsActions = {
  setHandsFreeEnabled(draft: VoiceSettingsState, enabled: boolean): void
  setWakeReadiness(draft: VoiceSettingsState, readiness: WakeReadiness): void
}

/**
 * Create the local voice settings store shared by both session slot entries.
 * @returns persisted store handle.
 */
export function createVoiceSettingsStore(): EngineStoreHandle<VoiceSettingsState, VoiceSettingsActions> {
  return defineStore({
    init: (): VoiceSettingsState => ({ handsFreeEnabled: false, wakeReadiness: 'calibration-required' }),
    persist: 'dsh.voice.settings.v1',
    actions: {
      setHandsFreeEnabled: (draft, enabled: boolean) => { draft.handsFreeEnabled = enabled },
      setWakeReadiness: (draft, readiness: WakeReadiness) => { draft.wakeReadiness = readiness },
    },
  })
}
