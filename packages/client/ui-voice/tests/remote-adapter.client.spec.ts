// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceConsumerId } from '../src/client/remote-adapter.ts'

const PAGE_KEY = Symbol.for('@deepseek-ai/dsh-client-ui-voice/consumer-id')
const STORAGE_KEY = 'dsh.voice.consumer-id'

function clearPageIdentity(): void {
  ;(globalThis as unknown as Record<PropertyKey, unknown>)[PAGE_KEY] = undefined
}

function navigation(type: NavigationTimingType): void {
  vi.stubGlobal('performance', { getEntriesByType: () => [{ type }] })
}

describe('voice consumer identity', () => {
  afterEach(() => {
    clearPageIdentity()
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('keeps one identity across HMR and a reload of the same browser tab', () => {
    navigation('navigate')
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'fresh-tab') })
    sessionStorage.setItem(STORAGE_KEY, 'copied-tab')

    expect(createVoiceConsumerId()).toBe('fresh-tab')
    expect(createVoiceConsumerId()).toBe('fresh-tab')

    clearPageIdentity()
    navigation('reload')
    expect(createVoiceConsumerId()).toBe('fresh-tab')
  })

  it('rotates a sessionStorage value copied into a new tab navigation', () => {
    navigation('navigate')
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-tab') })
    sessionStorage.setItem(STORAGE_KEY, 'other-tab')

    expect(createVoiceConsumerId()).toBe('new-tab')
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('new-tab')
  })
})
