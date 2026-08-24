/** Browser voice plugin: session controls, local capture, calibration, and WebRTC playback. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-wake-word-local/client'
import {
  VoiceControllerCoordinator, VoiceSessionController, type VoiceRuntimeConfig,
} from './controller.ts'
import { VoiceControl, VoiceStatus } from './components.tsx'
import { en, zh } from './locales.ts'
import { voiceRemoteFrom } from './remote-adapter.ts'
import { createVoiceSettingsStore } from './store.ts'
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
  }
  if (resolved.channelLowWaterBytes >= resolved.channelHighWaterBytes) {
    throw new Error('ui-voice: channelLowWaterBytes must be below channelHighWaterBytes')
  }
  return resolved
}

/** Plain injected face shared by the compact control and status row. */
export interface VoiceInjected {
  hooks: { voice: HostObservable<ReturnType<VoiceSessionController['getSnapshot']>> }
  beginPushToTalk(): Promise<void>
  endPushToTalk(): void
  setHandsFree(enabled: boolean): Promise<void>
  startCalibration(): Promise<void>
  beginCalibrationSample(): Promise<void>
  endCalibrationSample(): Promise<void>
  cancel(): Promise<void>
}

const NS = 'voice'

/** Required dynamic services for slots, Host voice, local wake, and copy. */
export const inject = ['slots', 'remote', 'remote.voice', 'wakeWord', 'locale']

/** Register both session-scoped entries and one-microphone lifecycle ownership. */
export function apply(ctx: ClientContext, config: Config = {}): void {
  const runtimeConfig = resolveConfig(config)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')
  const remote = voiceRemoteFrom(ctx)
  const wakeWord = wakeWordFrom(ctx.wakeWord)
  const coordinator = new VoiceControllerCoordinator()
  const controllers = new Map<SessionId, VoiceSessionController>()
  const settings = createVoiceSettingsStore()

  const controllerFor = (sessionId: SessionId): VoiceSessionController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new VoiceSessionController(sessionId, remote, wakeWord, coordinator, runtimeConfig)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  const face = (sessionId: SessionId, actions: BoundActions<typeof settings>): VoiceInjected => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { voice: controller },
      beginPushToTalk: () => controller.beginPushToTalk(),
      endPushToTalk: () => { controller.endPushToTalk() },
      setHandsFree: async (enabled) => {
        await controller.setHandsFree(enabled)
        const current = controller.getSnapshot()
        actions.setHandsFreeEnabled(current.handsFree)
        actions.setWakeReadiness(current.wakeReadiness)
      },
      startCalibration: async () => {
        await controller.startCalibration()
        actions.setWakeReadiness(controller.getSnapshot().wakeReadiness)
      },
      beginCalibrationSample: () => controller.beginCalibrationSample(),
      endCalibrationSample: async () => {
        await controller.endCalibrationSample()
        actions.setWakeReadiness(controller.getSnapshot().wakeReadiness)
      },
      cancel: () => controller.cancel(),
    }
  }

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'voice-control', order: 30,
    locale: NS, store: settings, inject: face,
  }, VoiceControl))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'voice-status', order: 30,
    locale: NS, store: settings, inject: face,
  }, VoiceStatus))

  ctx.effect(() => async () => {
    await Promise.all([...controllers.values()].map(controller => controller.dispose()))
    controllers.clear()
  }, 'ui-voice: media teardown')
}
