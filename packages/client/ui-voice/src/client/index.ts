/** Browser global voice plugin: global controls, status, local capture, and calibration. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-wake-word-local/client'
import {
  VoiceControllerCoordinator, VoiceSessionController, type VoiceRuntimeConfig,
} from './controller.ts'
import { VoiceCalibrationController } from './calibration-controller.ts'
import { VoiceOverlay, VoiceSidebarLauncher } from './components.tsx'
import { handleVoiceCreation, openAndWait } from './creation.ts'
import { en, zh } from './locales.ts'
import { handleVoiceNavigation } from './navigation.ts'
import {
  createVoiceConsumerId, voiceRemoteFrom, type VoiceCompletionRequest, type VoiceCreationRequest, type VoiceNavigationRequest,
} from './remote-adapter.ts'
import { createVoiceSettingsStore, type VoiceOverlayDisclosure, VoiceWindowController } from './store.ts'
import { VoiceSettingsSection, type VoiceSettingsInjected } from './VoiceSettingsSection.tsx'
import { wakeWordFrom } from './wake-word-adapter.ts'

export type { VoiceKey } from './locales.ts'
export type { VoiceSettingsState } from './store.ts'
export { createVoiceSettingsStore } from './store.ts'

/** Deployment-tunable browser buffering and lifecycle bounds. */
export interface Config {
  maxBufferedChunks?: number
  channelHighWaterBytes?: number
  channelLowWaterBytes?: number
  statusAttempts?: number
  statusIntervalMs?: number
  iceTimeoutMs?: number
  channelTimeoutMs?: number
  responseTimeoutMs?: number
  vadThreshold?: number
  vadSilenceMs?: number
  wakeSignalDefault?: boolean
}

/** Validated browser voice configuration. */
export const Config: z<Config> = z.object({
  maxBufferedChunks: z.number().step(1).min(8).max(4_096).default(512),
  channelHighWaterBytes: z.number().step(1).min(16_384).max(4_194_304).default(524_288),
  channelLowWaterBytes: z.number().step(1).min(4_096).max(1_048_576).default(131_072),
  statusAttempts: z.number().step(1).min(1).max(240).default(40),
  statusIntervalMs: z.number().step(1).min(25).max(5_000).default(250),
  iceTimeoutMs: z.number().step(1).min(1_000).max(60_000).default(10_000),
  channelTimeoutMs: z.number().step(1).min(1_000).max(60_000).default(10_000),
  responseTimeoutMs: z.number().step(1).min(5_000).max(300_000).default(45_000),
  vadThreshold: z.number().min(0.001).max(0.25).default(0.018),
  vadSilenceMs: z.number().step(1).min(200).max(5_000).default(850),
  wakeSignalDefault: z.boolean().default(true),
})

function resolveConfig(config: Config): VoiceRuntimeConfig {
  const resolved: VoiceRuntimeConfig = {
    maxBufferedChunks: config.maxBufferedChunks ?? 512,
    channelHighWaterBytes: config.channelHighWaterBytes ?? 524_288,
    channelLowWaterBytes: config.channelLowWaterBytes ?? 131_072,
    statusAttempts: config.statusAttempts ?? 40,
    statusIntervalMs: config.statusIntervalMs ?? 250,
    iceTimeoutMs: config.iceTimeoutMs ?? 10_000,
    channelTimeoutMs: config.channelTimeoutMs ?? 10_000,
    responseTimeoutMs: config.responseTimeoutMs ?? 45_000,
    vadThreshold: config.vadThreshold ?? 0.018,
    vadSilenceMs: config.vadSilenceMs ?? 850,
    wakeSignalDefault: config.wakeSignalDefault ?? true,
  }
  if (resolved.channelLowWaterBytes >= resolved.channelHighWaterBytes) {
    throw new Error('ui-voice: channelLowWaterBytes must be below channelHighWaterBytes')
  }
  return resolved
}

/** Plain injected face shared by the sidebar launcher and composer panel. */
export interface VoiceInjected {
  hooks: {
    voice: HostObservable<ReturnType<VoiceSessionController['getSnapshot']>>
    voiceWindow: VoiceWindowController
  }
  beginPushToTalk(): Promise<void>
  endPushToTalk(): void
  setHandsFree(enabled: boolean): Promise<void>
  setWakeSignalEnabled(enabled: boolean): void
  setOverlayDisclosure(disclosure: VoiceOverlayDisclosure): void
  cancel(): Promise<void>
}

const NS = 'voice'

/** Required dynamic services for root/session slots, navigation, Host voice, local wake, and copy. */
export const inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.voice', 'wakeWord', 'locale']

/** Register one page-global voice controller, sidebar launcher, dock panel, and Settings calibration. */
export function apply(ctx: ClientContext, config: Config = {}): void {
  const runtimeConfig = resolveConfig(config)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')
  const remote = voiceRemoteFrom(ctx)
  const wakeWord = wakeWordFrom(ctx.wakeWord)
  const coordinator = new VoiceControllerCoordinator()
  const calibration = new VoiceCalibrationController(wakeWord, coordinator)
  const consumerId = createVoiceConsumerId()
  const currentSessionId = (): SessionId | undefined => ctx.sessions.list.getSnapshot().current
  const controller = new VoiceSessionController(
    consumerId, currentSessionId, remote, wakeWord, coordinator, runtimeConfig,
  )
  const settings = createVoiceSettingsStore()
  const voiceWindow = new VoiceWindowController()
  let settingsActions: BoundActions<typeof settings> | undefined

  const faceFor = (): VoiceInjected => ({
    hooks: { voice: controller, voiceWindow },
    beginPushToTalk: () => controller.beginPushToTalk(),
    endPushToTalk: () => { controller.endPushToTalk() },
    setHandsFree: async (enabled) => {
      await controller.setHandsFree(enabled)
      const current = controller.getSnapshot()
      settingsActions?.setHandsFreeEnabled(current.handsFree)
      settingsActions?.setWakeReadiness(current.wakeReadiness)
    },
    setWakeSignalEnabled: (enabled) => { controller.setWakeSignalEnabled(enabled) },
    setOverlayDisclosure: (disclosure) => {
      voiceWindow.setDisclosure(disclosure)
      settingsActions?.setOverlayDisclosure(disclosure)
    },
    cancel: () => controller.cancel(),
  })
  const sessionFace = (_sessionId: SessionId): VoiceInjected => faceFor()
  const overlayFace = (actions: BoundActions<typeof settings>): VoiceInjected => {
    settingsActions = actions
    return faceFor()
  }
  const calibrationFace = (): VoiceSettingsInjected => ({
    hooks: { calibration, voice: controller },
    startCalibration: () => calibration.startCalibration(),
    beginCalibrationSample: () => calibration.beginCalibrationSample(),
    endCalibrationSample: () => calibration.endCalibrationSample(),
    setWakeSignalEnabled: (enabled) => { controller.setWakeSignalEnabled(enabled) },
  })
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'voice-global-launcher', order: 20,
    locale: NS, store: settings, inject: overlayFace,
  }, VoiceSidebarLauncher))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'voice-global', order: 5,
    locale: NS, inject: sessionFace,
  }, VoiceOverlay))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'voice', order: 25,
    label: () => t('settings.nav'), locale: NS, inject: calibrationFace,
  }, VoiceSettingsSection))

  ctx.effect(() => {
    let foreground = currentSessionId()
    const off = ctx.sessions.list.subscribe(() => {
      const next = currentSessionId()
      if (next === foreground) return
      foreground = next
      void controller.setForeground(next).catch(() => {})
    })
    return off
  }, 'ui-voice: foreground synchronization')

  ctx.effect(() => {
    interface ClientCreationRecord {
      voiceSessionId: VoiceCreationRequest['voiceSessionId']
      outcome?: Awaited<ReturnType<typeof handleVoiceCreation>>
      acknowledged: boolean
      ackTask?: Promise<void>
    }
    const lifetime = new AbortController()
    const creations = new Map<string, ClientCreationRecord>()
    const acknowledge = (record: ClientCreationRecord): void => {
      if (record.outcome === undefined || record.acknowledged || record.ackTask !== undefined) return
      const outcome = record.outcome
      record.ackTask = remote.ackCreation(record.voiceSessionId, outcome)
        .then((result) => { if (result.ok) record.acknowledged = true })
        .catch(() => {})
        .finally(() => { delete record.ackTask })
    }
    const off = ctx.remote.$on('voice/creation-requested', (raw) => {
      const request = raw as unknown as VoiceCreationRequest
      const existing = creations.get(request.creationId)
      if (existing !== undefined) { acknowledge(existing); return }
      for (const [creationId, record] of creations) {
        if (!record.acknowledged) continue
        creations.delete(creationId)
        if (creations.size < 128) break
      }
      if (creations.size >= 128) return
      const record: ClientCreationRecord = { voiceSessionId: request.voiceSessionId, acknowledged: false }
      creations.set(request.creationId, record)
      void handleVoiceCreation(request, {
        consumerId,
        ownsVoiceSession: sessionId => controller.ownsVoiceSession(sessionId),
        create: () => ctx.workspaces.createSession(),
        rename: async (sessionId, title) => {
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) return false
          const result = await binding.session.rename(title)
          return result.ok
        },
        openAndWait: (sessionId, timeoutMs, signal) => openAndWait(sessionId, timeoutMs, signal, {
          subscribe: listener => ctx.sessions.list.subscribe(listener),
          open: (id) => { ctx.sessions.open(id) },
          current: currentSessionId,
        }),
      }, lifetime.signal).then((outcome) => {
        record.outcome = outcome
        acknowledge(record)
      }).catch(() => {})
    })
    return () => { lifetime.abort(); off() }
  }, 'ui-voice: addressed creation')

  ctx.effect(() => ctx.remote.$on('voice/navigation-requested', (request) => {
    void handleVoiceNavigation(request as unknown as VoiceNavigationRequest, {
      consumerId,
      ownsVoiceSession: sessionId => controller.ownsVoiceSession(sessionId),
      open: (sessionId) => { ctx.sessions.open(sessionId) },
      current: currentSessionId,
      remote,
    }).catch(() => {})
  }), 'ui-voice: addressed navigation')

  ctx.effect(() => ctx.remote.$on('voice/completion-requested', (request) => {
    controller.queueCompletion(request as unknown as VoiceCompletionRequest)
  }), 'ui-voice: addressed completion')

  ctx.effect(() => async () => {
    await calibration.dispose()
    await controller.dispose()
  }, 'ui-voice: media teardown')
}
