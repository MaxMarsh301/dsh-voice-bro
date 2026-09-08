// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WakeWordState } from '@deepseek-ai/dsh-client-wake-word-local/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, type VoiceInjected } from '../src/client/index.ts'
import type { VoiceRemote } from '../src/client/remote-adapter.ts'
import { VoiceWindowController } from '../src/client/store.ts'

const sid = (value: string): SessionId => value as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))

  let current: SessionId | undefined = sid('s1')
  const sessionListeners = new Set<() => void>()
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({ current }),
      subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    },
    open: (sessionId: SessionId) => { current = sessionId; for (const listener of sessionListeners) listener() },
    binding: () => ({ session: { rename: vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 1 } })) } }),
  } as never)
  const createSession = vi.fn(async () => sid('fresh'))
  ctx.provide('workspaces', { createSession } as never)

  const voice: VoiceRemote = {
    start: vi.fn(), status: vi.fn(), setForeground: vi.fn(), claimResponseEpoch: vi.fn(), ackNavigation: vi.fn(), ackCreation: vi.fn(), stop: vi.fn(),
  }
  const remoteListeners = new Map<string, (payload: unknown) => void>()
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
    readonly $on = (event: string, listener: (payload: unknown) => void) => {
      remoteListeners.set(event, listener)
      return () => { remoteListeners.delete(event) }
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.voice', voice)

  const wakeState: WakeWordState = {
    keyword: 'БРО', enabled: false, workerReady: true, ready: false, templateCount: 0,
    calibration: { active: false, sampleCount: 0, requiredSamples: 3 },
  }
  ctx.provide('wakeWord', {
    getState: () => wakeState,
    subscribe: () => () => {},
    onDetection: () => () => {},
    feed: vi.fn(),
    beginCalibration: vi.fn(),
    addCalibrationSample: vi.fn(async () => 1),
    commitCalibration: vi.fn(async () => 3),
    setEnabled: vi.fn(),
  } as never)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, voice, remoteListeners, createSession }
}

const settingsActions = { setHandsFreeEnabled: vi.fn(), setWakeReadiness: vi.fn(), setOverlayDisclosure: vi.fn() }

describe('global voice browser plugin', () => {
  it('publishes composer-panel disclosure changes through one stable observable', () => {
    const window = new VoiceWindowController()
    const listener = vi.fn()
    const off = window.subscribe(listener)
    expect(window.getSnapshot()).toEqual({ disclosure: 'auto' })
    window.setDisclosure('expanded')
    expect(window.getSnapshot()).toEqual({ disclosure: 'expanded' })
    expect(listener).toHaveBeenCalledTimes(1)
    window.setDisclosure('expanded')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    window.setDisclosure('collapsed')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps voice controls global without adding buttons to the text input', async () => {
    const b = await bench()
    expect(b.ctx.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.ctx.slots.entries('conversation.input.dock')).toHaveLength(1)
    const launcher = b.ctx.slots.entries('sidebar.footer.action')[0]!
    const panel = b.ctx.slots.entries('conversation.input.dock')[0]!
    expect(launcher.options).toMatchObject({ id: 'voice-global-launcher', order: 20 })
    expect(panel.options).toMatchObject({ id: 'voice-global', order: 5 })

    const injectLauncher = launcher.inject as unknown as (actions: typeof settingsActions) => VoiceInjected
    const injectPanel = panel.inject as unknown as (sessionId: SessionId) => VoiceInjected
    const first = injectPanel(sid('s1'))
    const second = injectPanel(sid('s2'))
    const sidebar = injectLauncher(settingsActions)
    expect(first.hooks.voice).toBe(second.hooks.voice)
    expect(first.hooks.voice).toBe(sidebar.hooks.voice)
    expect(b.remoteListeners.has('voice/creation-requested')).toBe(true)
    expect(b.remoteListeners.has('voice/navigation-requested')).toBe(true)
    expect(b.remoteListeners.has('voice/completion-requested')).toBe(true)
    await b.fiber.dispose()
  })

  it('deduplicates repeated addressed creation delivery', async () => {
    const b = await bench()
    const listener = b.remoteListeners.get('voice/creation-requested')!
    const payload = {
      consumerId: sessionStorage.getItem('dsh.voice.consumer-id'),
      voiceSessionId: 'voice-current',
      creationId: 'creation-one',
      title: 'Roadmap',
    }
    // Ownership is false before a live call, so duplicate delivery is ignored without side effects.
    listener(payload); listener(payload)
    await Promise.resolve()
    expect(b.createSession).not.toHaveBeenCalled()
    await b.fiber.dispose()
  })

  it('unwinds every entry and forwarded-event listener on disposal', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(b.ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(b.remoteListeners.has('voice/creation-requested')).toBe(false)
    expect(b.remoteListeners.has('voice/navigation-requested')).toBe(false)
    expect(b.remoteListeners.has('voice/completion-requested')).toBe(false)
  })
})
