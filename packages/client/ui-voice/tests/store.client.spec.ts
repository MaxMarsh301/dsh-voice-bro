// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createVoiceSettingsStore, voiceOverlayDisclosure } from '../src/client/store.ts'

describe('voice plaque disclosure store', () => {
  it('normalizes legacy and malformed persisted values to auto', () => {
    expect(voiceOverlayDisclosure(undefined)).toBe('auto')
    expect(voiceOverlayDisclosure('future-mode')).toBe('auto')
    expect(voiceOverlayDisclosure('collapsed')).toBe('collapsed')
    expect(voiceOverlayDisclosure('expanded')).toBe('expanded')
  })

  it('retains explicit collapse and expand choices in the persisted store value', () => {
    const instance = createVoiceSettingsStore().create('voice-disclosure-test')
    expect(instance.store.getSnapshot().overlayDisclosure).toBe('auto')
    instance.actions.setOverlayDisclosure('collapsed')
    expect(instance.store.getSnapshot().overlayDisclosure).toBe('collapsed')
    instance.actions.setOverlayDisclosure('expanded')
    expect(instance.store.getSnapshot().overlayDisclosure).toBe('expanded')
  })
})
