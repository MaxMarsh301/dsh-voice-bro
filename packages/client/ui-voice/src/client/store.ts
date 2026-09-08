import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WakeReadiness } from './wake-word-adapter.ts'

/** User-controlled disclosure mode for the page-global voice window. */
export type VoiceOverlayDisclosure = 'auto' | 'collapsed' | 'expanded'

/**
 * Normalize persisted disclosure values from browser storage.
 * @param value - untrusted whole-value store field.
 * @returns a supported disclosure mode, defaulting legacy and malformed values to auto.
 */
export function voiceOverlayDisclosure(value: unknown): VoiceOverlayDisclosure {
  return value === 'collapsed' || value === 'expanded' ? value : 'auto'
}

/** Reactive disclosure state shared across root and Session-scoped voice entries. */
export interface VoiceWindowSnapshot {
  disclosure: VoiceOverlayDisclosure
}

/** Root-owned presentation observable for the Session-scoped composer panel. */
export class VoiceWindowController implements HostObservable<VoiceWindowSnapshot> {
  private snapshot: VoiceWindowSnapshot = { disclosure: 'auto' }
  private readonly listeners = new Set<() => void>()

  /** Return the stable current disclosure snapshot. */
  getSnapshot = (): VoiceWindowSnapshot => this.snapshot

  /** Subscribe to disclosure changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish one persisted or user-selected disclosure mode. */
  setDisclosure(disclosure: VoiceOverlayDisclosure): void {
    if (this.snapshot.disclosure === disclosure) return
    this.snapshot = { disclosure }
    for (const listener of this.listeners) listener()
  }
}

/** Browser-local voice preferences and page-global voice viewing state. */
export interface VoiceSettingsState {
  handsFreeEnabled: boolean
  wakeReadiness: WakeReadiness
  /** Missing in v1 persisted values and interpreted as auto. */
  overlayDisclosure?: VoiceOverlayDisclosure
}

type VoiceSettingsActions = {
  setHandsFreeEnabled(draft: VoiceSettingsState, enabled: boolean): void
  setWakeReadiness(draft: VoiceSettingsState, readiness: WakeReadiness): void
  setOverlayDisclosure(draft: VoiceSettingsState, disclosure: VoiceOverlayDisclosure): void
}

/**
 * Create the local voice settings store shared by both session slot entries.
 * @returns persisted store handle.
 */
export function createVoiceSettingsStore(): EngineStoreHandle<VoiceSettingsState, VoiceSettingsActions> {
  return defineStore({
    init: (): VoiceSettingsState => ({
      handsFreeEnabled: false,
      wakeReadiness: 'calibration-required',
      overlayDisclosure: 'auto',
    }),
    persist: 'dsh.voice.settings.v1',
    actions: {
      setHandsFreeEnabled: (draft, enabled: boolean) => { draft.handsFreeEnabled = enabled },
      setWakeReadiness: (draft, readiness: WakeReadiness) => { draft.wakeReadiness = readiness },
      setOverlayDisclosure: (draft, disclosure: VoiceOverlayDisclosure) => { draft.overlayDisclosure = disclosure },
    },
  })
}
