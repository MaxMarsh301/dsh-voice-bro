import { describe, expect, it, vi } from 'vitest'
import { handleVoiceCreation, openAndWait, type VoiceCreationDeps } from '../src/client/creation.ts'
import type {
  VoiceConsumerId, VoiceCreationId, VoiceCreationRequest, VoiceSessionId,
} from '../src/client/remote-adapter.ts'

const consumerId = 'tab-one' as VoiceConsumerId
const voiceSessionId = 'voice-one' as VoiceSessionId
const request: VoiceCreationRequest = {
  consumerId,
  voiceSessionId,
  creationId: 'creation-one' as VoiceCreationId,
  activationTimeoutMs: 30_000,
  title: 'Roadmap',
}

function dependencies(): VoiceCreationDeps {
  return {
    consumerId,
    ownsVoiceSession: id => id === voiceSessionId,
    create: vi.fn(async () => 'fresh' as never),
    rename: vi.fn(async () => true),
    openAndWait: vi.fn(async () => true),
  }
}

describe('confirmed Session activation', () => {
  it('subscribes before opening and waits for a delayed current-selection publication', async () => {
    const state: { current?: string } = {}
    let listener: (() => void) | undefined
    const order: string[] = []
    const operation = openAndWait('fresh' as never, 1_000, new AbortController().signal, {
      subscribe: (next) => { order.push('subscribe'); listener = next; return vi.fn() },
      open: () => { order.push('open') },
      current: () => state.current as never,
    })
    state.current = 'fresh'; listener?.()
    await expect(operation).resolves.toBe(true)
    expect(order).toEqual(['subscribe', 'open'])
  })

  it('returns false and unsubscribes when the owning effect is disposed', async () => {
    const abort = new AbortController()
    const unsubscribe = vi.fn()
    const operation = openAndWait('fresh' as never, 1_000, abort.signal, {
      subscribe: () => unsubscribe,
      open: vi.fn(),
      current: () => undefined,
    })
    abort.abort()
    await expect(operation).resolves.toBe(false)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('global voice Session creation', () => {
  it('creates, names, waits for activation, and returns the stable acknowledgement payload', async () => {
    const deps = dependencies()

    await expect(handleVoiceCreation(request, deps, new AbortController().signal)).resolves.toEqual({
      creationId: request.creationId,
      created: true,
      activated: true,
      sessionId: 'fresh',
    })

    expect(deps.create).toHaveBeenCalledOnce()
    expect(deps.rename).toHaveBeenCalledWith('fresh', 'Roadmap')
    expect(deps.openAndWait).toHaveBeenCalledWith('fresh', 30_000, expect.any(AbortSignal))
  })

  it('ignores commands addressed to another tab, stale call, or disposed effect', async () => {
    const deps = dependencies()
    await expect(handleVoiceCreation({ ...request, consumerId: 'other' as VoiceConsumerId }, deps, new AbortController().signal)).resolves.toBeUndefined()
    await expect(handleVoiceCreation({ ...request, voiceSessionId: 'stale' as VoiceSessionId }, deps, new AbortController().signal)).resolves.toBeUndefined()
    const disposed = new AbortController(); disposed.abort()
    await expect(handleVoiceCreation(request, deps, disposed.signal)).resolves.toBeUndefined()
    expect(deps.create).not.toHaveBeenCalled()
  })

  it('reports the created but inactive Session when naming fails', async () => {
    const deps = dependencies()
    deps.rename = vi.fn(async () => false)

    await expect(handleVoiceCreation(request, deps, new AbortController().signal)).resolves.toEqual({
      creationId: request.creationId,
      created: true,
      activated: false,
      sessionId: 'fresh',
    })

    expect(deps.openAndWait).not.toHaveBeenCalled()
  })

  it('waits for delayed activation and preserves an inactive result at its deadline', async () => {
    const deps = dependencies()
    let settle!: (activated: boolean) => void
    deps.openAndWait = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    const operation = handleVoiceCreation(request, deps, new AbortController().signal)
    await Promise.resolve(); await Promise.resolve()
    settle(false)
    await expect(operation).resolves.toMatchObject({ created: true, activated: false, sessionId: 'fresh' })
  })
})
