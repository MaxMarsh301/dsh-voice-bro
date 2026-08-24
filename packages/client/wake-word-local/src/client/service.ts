import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  MonoPcm,
  WakeWordDetection,
  WakeWordServiceContract,
  WakeWordState,
} from '../types.ts'
import {
  createMatcherWorkerSource,
  type DerivedTemplate,
  type WorkerMatcherConfig,
  type WorkerRequest,
  type WorkerResponse,
} from './worker.ts'

const STORAGE_VERSION = 1
const KEYWORD = 'БРО' as const
const MAX_STORAGE_BYTES = 512 * 1024

/** Browser matcher configuration. */
export interface Config {
  /** Maximum normalized DTW distance accepted as a detection. Lower values reduce false triggers. */
  threshold?: number
  /** Minimum block RMS that VAD treats as speech. */
  vadRms?: number
  /** Minimum time between detections in milliseconds. */
  cooldownMs?: number
  /** Speaker samples required for a usable calibration. */
  minTemplates?: number
  /** Maximum derived speaker templates retained locally. */
  maxTemplates?: number
  /** Minimum VAD-trimmed calibration utterance duration in milliseconds. */
  minSampleMs?: number
  /** Maximum VAD-trimmed candidate duration in milliseconds. */
  maxSampleMs?: number
  /** Maximum duration accepted by one streaming feed call in milliseconds. */
  maxFeedMs?: number
  /** localStorage key for derived templates. */
  storageKey?: string
  /** Initial inference state. */
  enabled?: boolean
}

interface ResolvedConfig extends WorkerMatcherConfig {
  readonly maxFeedMs: number
  readonly storageKey: string
  readonly enabled: boolean
}

interface PendingRequest {
  resolve(value: number): void
  reject(error: Error): void
}

interface StoredTemplates {
  version: number
  keyword: typeof KEYWORD
  templates: DerivedTemplate[]
}

type StatePatch = Partial<Omit<WakeWordState, 'error'>> & { error?: string | undefined }

interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  terminate(): void
}

/** Schemastery validation for browser matcher tunables. */
export const Config: z<Config> = z.object({
  threshold: z.number().min(0.01).max(0.8).default(0.16),
  vadRms: z.number().min(0.001).max(0.25).default(0.018),
  cooldownMs: z.number().step(1).min(100).max(30_000).default(1_500),
  minTemplates: z.number().step(1).min(2).max(12).default(3),
  maxTemplates: z.number().step(1).min(2).max(12).default(8),
  minSampleMs: z.number().step(1).min(150).max(1_000).default(250),
  maxSampleMs: z.number().step(1).min(500).max(4_000).default(2_200),
  maxFeedMs: z.number().step(1).min(10).max(1_000).default(250),
  storageKey: z.string().min(1).max(160).default('dsh:wake-word-local:БРО:v1'),
  enabled: z.boolean().default(true),
})

/**
 * Resolve optional source values and enforce relationships between fields.
 * @param source - schema-validated or directly constructed configuration.
 * @returns complete matcher configuration.
 */
function resolveConfig(source: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    threshold: source.threshold ?? 0.16,
    vadRms: source.vadRms ?? 0.018,
    cooldownMs: source.cooldownMs ?? 1_500,
    minTemplates: source.minTemplates ?? 3,
    maxTemplates: source.maxTemplates ?? 8,
    minSampleMs: source.minSampleMs ?? 250,
    maxSampleMs: source.maxSampleMs ?? 2_200,
    maxFeedMs: source.maxFeedMs ?? 250,
    storageKey: source.storageKey ?? 'dsh:wake-word-local:БРО:v1',
    enabled: source.enabled ?? true,
  }
  if (resolved.minTemplates > resolved.maxTemplates) throw new Error('wake-word-local: minTemplates cannot exceed maxTemplates')
  if (resolved.minSampleMs >= resolved.maxSampleMs) throw new Error('wake-word-local: minSampleMs must be below maxSampleMs')
  return resolved
}

/** @returns whether a durable value is a bounded derived feature template. */
function validTemplate(value: unknown): value is DerivedTemplate {
  return Array.isArray(value)
    && value.length >= 3
    && value.length <= 220
    && value.every(frame => Array.isArray(frame)
      && frame.length === 8
      && frame.every(coefficient => typeof coefficient === 'number'
        && Number.isFinite(coefficient)
        && Math.abs(coefficient) <= 2))
}

/** The browser-local speaker-calibrated `ctx.wakeWord` service. */
export class WakeWordService extends Service implements WakeWordServiceContract {
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly worker: WorkerLike
  private readonly stateListeners = new Set<() => void>()
  private readonly detectionListeners = new Set<(detection: WakeWordDetection) => void>()
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private disposed = false
  private state: WakeWordState

  /**
   * Start the inline Worker and restore bounded derived templates.
   * @param ctx - owning browser Cordis context.
   * @param sourceConfig - validated matcher configuration.
   */
  constructor(ctx: Context, sourceConfig: Config = {}) {
    super(ctx, 'wakeWord')
    this.config = resolveConfig(sourceConfig)
    this.state = {
      keyword: KEYWORD,
      enabled: this.config.enabled,
      workerReady: false,
      ready: false,
      templateCount: 0,
      calibration: { active: false, sampleCount: 0, requiredSamples: this.config.minTemplates },
    }
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('wake-word-local requires browser Worker, Blob, and object URL support')
    }
    const blobUrl = URL.createObjectURL(new Blob([createMatcherWorkerSource()], { type: 'text/javascript' }))
    try {
      this.worker = new Worker(blobUrl) as WorkerLike
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    this.worker.onmessage = event => { this.handleWorkerMessage(event.data) }
    this.worker.onerror = event => {
      this.publish({ error: event.message || 'wake-word Worker failed' })
      this.rejectPending(new Error(this.state.error))
    }
    const templates = this.loadTemplates()
    this.worker.postMessage({ type: 'init', config: this.workerConfig(), templates })
    ctx.effect(() => () => { this.dispose() }, 'wake-word-local: Worker lifetime')
  }

  /** @returns the stable current state snapshot. */
  getState(): WakeWordState {
    return this.state
  }

  /**
   * Subscribe to state replacement.
   * @param listener - notified after state changes.
   * @returns an idempotent unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.ensureLive()
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /**
   * Subscribe to local detections.
   * @param listener - detection callback isolated from other subscribers.
   * @returns an idempotent unsubscribe function.
   */
  onDetection(listener: (detection: WakeWordDetection) => void): () => void {
    this.ensureLive()
    this.detectionListeners.add(listener)
    return () => { this.detectionListeners.delete(listener) }
  }

  /**
   * Feed one mono PCM frame without detaching the caller's buffer.
   * @param pcm - float or signed 16-bit mono PCM.
   * @param sampleRate - integer source rate from 8 kHz through 48 kHz.
   */
  feed(pcm: MonoPcm, sampleRate: number): void {
    this.ensureLive()
    this.validateFrame(pcm, sampleRate, this.config.maxFeedMs)
    if (!this.state.enabled) return
    const copy = pcm.slice()
    this.worker.postMessage({ type: 'feed', pcm: copy, sampleRate }, [copy.buffer])
  }

  /** Start a calibration transaction which replaces templates only on commit. */
  beginCalibration(): void {
    this.ensureLive()
    this.worker.postMessage({ type: 'beginCalibration' })
    this.publish({ calibration: { active: true, sampleCount: 0, requiredSamples: this.config.minTemplates } })
  }

  /**
   * Stage one derived calibration sample.
   * @param pcm - complete isolated keyword pronunciation.
   * @param sampleRate - integer source rate from 8 kHz through 48 kHz.
   * @returns staged sample count.
   */
  addCalibrationSample(pcm: MonoPcm, sampleRate: number): Promise<number> {
    this.ensureLive()
    if (!this.state.calibration.active) return Promise.reject(new Error('wake-word-local: beginCalibration must be called first'))
    this.validateFrame(pcm, sampleRate, this.config.maxSampleMs * 2)
    const copy = pcm.slice()
    return this.request(id => ({ type: 'addCalibration', id, pcm: copy, sampleRate }), [copy.buffer])
  }

  /**
   * Commit the staged derived samples and persist only their feature matrices.
   * @returns committed template count.
   */
  commitCalibration(): Promise<number> {
    this.ensureLive()
    if (!this.state.calibration.active) return Promise.reject(new Error('wake-word-local: beginCalibration must be called first'))
    return this.request(id => ({ type: 'commitCalibration', id }))
  }

  /**
   * Enable or disable inference while retaining calibration.
   * @param enabled - desired inference state.
   */
  setEnabled(enabled: boolean): void {
    this.ensureLive()
    if (this.state.enabled === enabled) return
    this.worker.postMessage({ type: 'enabled', enabled })
    this.publish({ enabled })
  }

  /** Terminate the Worker and release all local subscribers and requests. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.postMessage({ type: 'dispose' })
    this.worker.terminate()
    this.worker.onmessage = null
    this.worker.onerror = null
    this.rejectPending(new Error('wake-word-local service was disposed'))
    this.stateListeners.clear()
    this.detectionListeners.clear()
  }

  private workerConfig(): WorkerMatcherConfig {
    return {
      threshold: this.config.threshold,
      vadRms: this.config.vadRms,
      cooldownMs: this.config.cooldownMs,
      minTemplates: this.config.minTemplates,
      maxTemplates: this.config.maxTemplates,
      minSampleMs: this.config.minSampleMs,
      maxSampleMs: this.config.maxSampleMs,
    }
  }

  private validateFrame(pcm: MonoPcm, sampleRate: number, maxDurationMs: number): void {
    if (!(pcm instanceof Float32Array) && !(pcm instanceof Int16Array)) {
      throw new TypeError('wake-word-local: PCM must be Float32Array or Int16Array')
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
      throw new RangeError('wake-word-local: sampleRate must be an integer from 8000 through 48000')
    }
    const maxSamples = Math.ceil(sampleRate * maxDurationMs / 1_000)
    if (pcm.length === 0 || pcm.length > maxSamples) {
      throw new RangeError(`wake-word-local: PCM frame must contain 1-${maxSamples} samples`)
    }
  }

  private request(create: (id: number) => WorkerRequest, transfer: Transferable[] = []): Promise<number> {
    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage(create(id), transfer)
    })
  }

  private handleWorkerMessage(message: WorkerResponse): void {
    if (this.disposed) return
    switch (message.type) {
      case 'ready':
        this.publish({
          workerReady: true,
          templateCount: message.templateCount,
          ready: message.templateCount >= this.config.minTemplates,
        })
        break
      case 'calibrationStaged':
        this.publish({
          calibration: { active: true, sampleCount: message.sampleCount, requiredSamples: this.config.minTemplates },
          error: undefined,
        })
        this.settle(message.id, message.sampleCount)
        break
      case 'calibrationCommitted': {
        const count = message.templates.length
        this.persistTemplates(message.templates)
        this.publish({
          templateCount: count,
          ready: this.state.workerReady && count >= this.config.minTemplates,
          calibration: { active: false, sampleCount: 0, requiredSamples: this.config.minTemplates },
        })
        this.settle(message.id, count)
        break
      }
      case 'detected': {
        const detection: WakeWordDetection = { ...message, detectedAt: Date.now() }
        for (const listener of [...this.detectionListeners]) {
          try {
            listener(detection)
          } catch (error) {
            console.error('[wake-word-local] detection listener threw:', error)
          }
        }
        break
      }
      case 'requestError':
        this.failRequest(message.id, message.message)
        break
      case 'workerError':
        this.publish({ error: message.message })
        break
      default:
        /* v8 ignore next -- closed Worker response union is exhaustively produced by this package. */
        break
    }
  }

  private settle(id: number, value: number): void {
    const request = this.pending.get(id)
    if (request === undefined) return
    this.pending.delete(id)
    request.resolve(value)
  }

  private failRequest(id: number, message: string): void {
    const request = this.pending.get(id)
    if (request === undefined) return
    this.pending.delete(id)
    request.reject(new Error(message))
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private publish(patch: StatePatch): void {
    let next: WakeWordState
    const hasErrorPatch = 'error' in patch
    const { error: patchError, ...patchWithoutError } = patch
    if (hasErrorPatch && patchError === undefined) {
      const { error: _previousError, ...stateWithoutError } = this.state
      next = { ...stateWithoutError, ...patchWithoutError }
    } else if (patchError !== undefined) {
      next = { ...this.state, ...patchWithoutError, error: patchError }
    } else {
      next = { ...this.state, ...patchWithoutError }
    }
    if (Object.keys(patch).every(key => Object.is(this.state[key as keyof WakeWordState], next[key as keyof WakeWordState]))) return
    this.state = next
    for (const listener of [...this.stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[wake-word-local] state listener threw:', error)
      }
    }
  }

  private loadTemplates(): DerivedTemplate[] {
    if (typeof localStorage === 'undefined') return []
    let serialized: string | null
    try {
      serialized = localStorage.getItem(this.config.storageKey)
    } catch (error) {
      this.publish({ error: `template storage read failed: ${String(error)}` })
      return []
    }
    if (serialized === null) return []
    if (serialized.length > MAX_STORAGE_BYTES) {
      this.publish({ error: 'stored template record exceeds the size limit' })
      return []
    }
    try {
      const value = JSON.parse(serialized) as Partial<StoredTemplates>
      if (value.version !== STORAGE_VERSION || value.keyword !== KEYWORD || !Array.isArray(value.templates)) {
        throw new Error('unsupported template record')
      }
      if (value.templates.length > this.config.maxTemplates || !value.templates.every(validTemplate)) {
        throw new Error('invalid template dimensions')
      }
      return value.templates
    } catch (error) {
      this.publish({ error: `stored templates ignored: ${String(error)}` })
      return []
    }
  }

  private persistTemplates(templates: DerivedTemplate[]): void {
    if (typeof localStorage === 'undefined') return
    const record: StoredTemplates = { version: STORAGE_VERSION, keyword: KEYWORD, templates }
    const serialized = JSON.stringify(record)
    if (serialized.length > MAX_STORAGE_BYTES) throw new Error('wake-word-local: derived template record exceeds the storage limit')
    try {
      localStorage.setItem(this.config.storageKey, serialized)
    } catch (error) {
      this.publish({ error: `template storage write failed: ${String(error)}` })
    }
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('wake-word-local service is disposed')
  }
}
