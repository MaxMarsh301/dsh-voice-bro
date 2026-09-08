import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { VoiceCostAccumulator, type VoiceCostSnapshot } from './cost.ts'
import { clientEvent, parseVoiceEvent, type VoiceActivityTool } from './events.ts'
import { PcmResampler, pcmBase64, rms } from './pcm.ts'
import type {
  VoiceCompletionRequest, VoiceConsumerId, VoiceRemote, VoiceResponseEpoch, VoiceSessionId,
} from './remote-adapter.ts'
import { wakeReadiness, type WakeReadiness, type WakeWordPort } from './wake-word-adapter.ts'
import { createCaptureWorkletUrl } from './worklet.ts'

/** Deployment-resolved browser voice tunables. */
export interface VoiceRuntimeConfig {
  maxBufferedChunks: number
  channelHighWaterBytes: number
  channelLowWaterBytes: number
  statusAttempts: number
  statusIntervalMs: number
  iceTimeoutMs: number
  channelTimeoutMs: number
  responseTimeoutMs: number
  vadThreshold: number
  vadSilenceMs: number
  wakeSignalDefault: boolean
}

/** Browser voice lifecycle rendered by both slot entries. */
export type VoicePhase =
  | 'idle' | 'interrupting' | 'requesting-microphone' | 'connecting' | 'listening'
  | 'thinking' | 'speaking' | 'stopping' | 'error'

/** Calibration UI state; only derived counts survive each sample. */
export interface VoiceCalibrationSnapshot {
  active: boolean
  recording: boolean
  sampleCount: number
  requiredSamples: number
  pending: boolean
}

/** One safe, user-visible operation selected by the voice model. */
export interface VoiceActivityStep {
  callId: string
  tool: VoiceActivityTool
  status: 'running' | 'completed'
}

/** Bounded activity-panel state for the current or most recent request. */
export interface VoiceActivitySnapshot {
  steps: readonly VoiceActivityStep[]
  plannedText: string
  finalText: string
}

/** Immutable session voice snapshot. */
export interface VoiceSnapshot {
  phase: VoicePhase
  handsFree: boolean
  wakeReadiness: WakeReadiness
  calibration: VoiceCalibrationSnapshot
  transcript: string
  sawToolResponse: boolean
  activity: VoiceActivitySnapshot
  cost: VoiceCostSnapshot
  wakeSignalEnabled: boolean
  errorCode: 'microphone' | 'connection' | 'wake-word' | 'response' | 'calibration' | undefined
}

const MAX_ACTIVITY_STEPS = 6
const MAX_TRACKED_RESPONSE_OWNERS = 128
const MAX_PENDING_COMPLETIONS = 20
const EMPTY_ACTIVITY: VoiceActivitySnapshot = Object.freeze({ steps: Object.freeze([]), plannedText: '', finalText: '' })

const WAKE_SIGNAL_STORAGE_KEY = 'dsh.voice.wake-signal.v1'

function loadWakeSignalPreference(fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(WAKE_SIGNAL_STORAGE_KEY)
    if (stored === 'true') return true
    if (stored === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

function saveWakeSignalPreference(enabled: boolean): void {
  try {
    localStorage.setItem(WAKE_SIGNAL_STORAGE_KEY, String(enabled))
  } catch {
    // Browser storage failures leave the current controller setting runtime-only.
  }
}

function playWakeSignal(context: AudioContext): void {
  const startAt = context.currentTime
  const stopAt = startAt + 0.16
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(880, startAt)
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect()
    gain.disconnect()
  }, { once: true })
  oscillator.start(startAt)
  oscillator.stop(stopAt)
}

/** Browser construction hooks replaced by deterministic fakes in tests. */
export interface VoiceBrowserDeps {
  getUserMedia(): Promise<MediaStream>
  createAudioContext(): AudioContext
  createWorkletNode(context: AudioContext): AudioWorkletNode
  createPeerConnection(): RTCPeerConnection
  createAudioElement(): HTMLAudioElement
  createWorkletUrl(): { url: string; revoke: () => void }
  playWakeSignal(context: AudioContext): void
  loadWakeSignalPreference(fallback: boolean): boolean
  saveWakeSignalPreference(enabled: boolean): void
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
  now(): number
}

/** Default browser capabilities; policy/timing values arrive separately through Config. */
export const browserVoiceDeps: VoiceBrowserDeps = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  }),
  createAudioContext: () => new AudioContext(),
  createWorkletNode: context => new AudioWorkletNode(context, 'dsh-voice-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  }),
  createPeerConnection: () => new RTCPeerConnection(),
  createAudioElement: () => document.createElement('audio'),
  createWorkletUrl: createCaptureWorkletUrl,
  playWakeSignal,
  loadWakeSignalPreference,
  saveWakeSignalPreference,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => { clearTimeout(handle) },
  now: () => performance.now(),
}

function genericFailureCode(error: unknown): VoiceSnapshot['errorCode'] {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'NotFoundError')) return 'microphone'
  return 'connection'
}

class VoiceConnectionStageError extends Error {
  constructor(readonly stage: string, cause: unknown) {
    super(`voice connection failed at ${stage}`, { cause })
  }
}

async function connectionStage<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new VoiceConnectionStageError(stage, error)
  }
}

function sleep(deps: VoiceBrowserDeps, delay: number): Promise<void> {
  return new Promise(resolve => deps.setTimeout(resolve, delay))
}

/** One owner that can yield browser microphone resources before transfer. */
export interface VoiceCaptureOwner {
  deactivateForNavigation(): Promise<void>
}

/** Coordinates exclusive microphone ownership across Session voice and Settings calibration. */
export class VoiceControllerCoordinator {
  private active: VoiceCaptureOwner | undefined

  /**
   * Tear down the previous owner before the next controller acquires media.
   * @param next - controller receiving microphone ownership.
   */
  async activate(next: VoiceCaptureOwner): Promise<void> {
    if (this.active === next) return
    const previous = this.active
    this.active = next
    if (previous !== undefined) await previous.deactivateForNavigation()
  }

  /**
   * Release ownership if the named controller still owns it.
   * @param controller - Controller releasing microphone ownership.
   */
  release(controller: VoiceCaptureOwner): void {
    if (this.active === controller) this.active = undefined
  }
}

/**
 * Wait until ICE gathering is complete so the Host receives a self-contained
 * offer rather than depending on browser trickle ICE.
 * @param peer - Browser peer whose ICE state is observed.
 * @param deps - Browser timing dependencies.
 * @param timeoutMs - Maximum gathering time.
 */
export async function waitForCompleteIce(
  peer: RTCPeerConnection,
  deps: VoiceBrowserDeps,
  timeoutMs: number,
): Promise<void> {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (peer.iceGatheringState !== 'complete') return
      deps.clearTimeout(timeout)
      peer.removeEventListener('icegatheringstatechange', changed)
      resolve()
    }
    const timeout = deps.setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', changed)
      reject(new Error('ICE gathering timed out'))
    }, timeoutMs)
    peer.addEventListener('icegatheringstatechange', changed)
  })
}

/** One session's browser media, WebRTC, buffering, wake, and calibration owner. */
export class VoiceSessionController {
  private snapshot: VoiceSnapshot
  private readonly costs = new VoiceCostAccumulator()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeWakeState: () => void
  private readonly unsubscribeDetection: () => void
  private media: MediaStream | undefined
  private audioContext: AudioContext | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private worklet: AudioWorkletNode | undefined
  private silentGain: GainNode | undefined
  private workletRevoke: (() => void) | undefined
  private resampler: PcmResampler | undefined
  private peer: RTCPeerConnection | undefined
  private channel: RTCDataChannel | undefined
  private remoteAudio: HTMLAudioElement | undefined
  private voiceSessionId: VoiceSessionId | undefined
  private connectPromise: Promise<void> | undefined
  private queuedPcm: Uint8Array[] = []
  private gateOpen = false
  private gateStarting = false
  private gateRevision = 0
  private gateMode: 'ptt' | 'hands-free' = 'ptt'
  private gateHadAudio = false
  private gateHeardVoice = false
  private earlyRelease = false
  private ready = false
  private cleared = false
  private commitRequested = false
  private pumping = false
  private disposed = false
  private responseTimer: ReturnType<typeof setTimeout> | undefined
  private transportStopPromise: Promise<boolean> | undefined
  private responseCounter = 0
  private gateResponseEpoch: VoiceResponseEpoch | undefined
  private activeResponseEpoch: VoiceResponseEpoch | undefined
  private completingResponseEpoch: VoiceResponseEpoch | undefined
  private currentCostEpoch: VoiceResponseEpoch | undefined
  private readonly responseOwners = new Map<string, VoiceResponseEpoch>()
  private readonly inputOwners = new Map<string, VoiceResponseEpoch>()
  private readonly openResponses = new Set<string>()
  private readonly generatedResponses = new Set<string>()
  private readonly drainedResponses = new Set<string>()
  private vadSilenceSince: number | undefined
  private vadHeardVoice = false
  private foregroundTail: Promise<void> = Promise.resolve()
  private responseEpochTail: Promise<void> = Promise.resolve()
  private readonly pendingCompletions: VoiceCompletionRequest[] = []
  private activeCompletion: VoiceCompletionRequest | undefined
  private completionStarting = false

  constructor(
    readonly consumerId: VoiceConsumerId,
    private readonly foregroundSessionId: () => SessionId | undefined,
    private readonly remote: VoiceRemote,
    private readonly wakeWord: WakeWordPort,
    private readonly coordinator: VoiceControllerCoordinator,
    private readonly config: VoiceRuntimeConfig,
    private readonly deps: VoiceBrowserDeps = browserVoiceDeps,
  ) {
    const wake = wakeWord.getState()
    const wakeSignalEnabled = deps.loadWakeSignalPreference(config.wakeSignalDefault)
    this.snapshot = {
      phase: 'idle',
      handsFree: false,
      wakeReadiness: wakeReadiness(wake),
      calibration: { ...wake.calibration, recording: false, pending: false },
      transcript: '',
      sawToolResponse: false,
      activity: EMPTY_ACTIVITY,
      cost: this.costs.snapshot(),
      wakeSignalEnabled,
      errorCode: undefined,
    }
    this.unsubscribeWakeState = wakeWord.subscribe(() => {
      const state = wakeWord.getState()
      this.publish({
        wakeReadiness: wakeReadiness(state),
        calibration: {
          ...this.snapshot.calibration,
          active: state.calibration.active,
          sampleCount: state.calibration.sampleCount,
          requiredSamples: state.calibration.requiredSamples,
        },
      })
    })
    this.unsubscribeDetection = wakeWord.onDetection(() => {
      if (!this.snapshot.handsFree) return
      void this.beginGate('hands-free')
    })
  }

  /**
   * Read the current identity-stable immutable controller snapshot.
   * @returns Current controller snapshot.
   */
  getSnapshot = (): VoiceSnapshot => this.snapshot

  /** Subscribe to snapshot replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Check whether one addressed navigation belongs to the currently live call.
   * @param sessionId - Addressed logical voice call.
   * @returns Whether the controller owns that call.
   */
  ownsVoiceSession(sessionId: VoiceSessionId): boolean {
    return this.voiceSessionId === sessionId
  }

  /**
   * Publish the browser's current foreground Session to an already-live global call.
   * @param foregroundSessionId - Visible Session, or undefined for the empty state.
   */
  setForeground(foregroundSessionId: SessionId | undefined): Promise<void> {
    const voiceSessionId = this.voiceSessionId
    if (voiceSessionId === undefined) return Promise.resolve()
    const update = this.foregroundTail.then(async () => {
      if (this.disposed || this.voiceSessionId !== voiceSessionId) return
      const result = await this.remote.setForeground(voiceSessionId, foregroundSessionId)
      if (!result.ok) throw new Error('voice foreground update rejected')
    })
    this.foregroundTail = update.catch(() => {})
    return update
  }

  /**
   * Queue one addressed Session completion for spoken delivery on the persistent call.
   * @param request - Settled request identity and Session label from the Host.
   */
  queueCompletion(request: VoiceCompletionRequest): void {
    if (request.consumerId !== this.consumerId || !this.ownsVoiceSession(request.voiceSessionId)) return
    if (this.activeCompletion?.requestId === request.requestId || this.pendingCompletions.some(item => item.requestId === request.requestId)) return
    this.pendingCompletions.push(request)
    if (this.pendingCompletions.length > MAX_PENDING_COMPLETIONS) this.pendingCompletions.shift()
    void this.drainCompletions()
  }

  private async drainCompletions(): Promise<void> {
    if (this.completionStarting || this.disposed || !this.ready || this.snapshot.phase !== 'idle' || this.gateOpen || this.gateStarting) return
    const request = this.pendingCompletions.shift()
    const voiceSessionId = this.voiceSessionId
    if (request === undefined || voiceSessionId === undefined) return
    const revision = this.gateRevision
    const epoch = `${this.consumerId}:${++this.responseCounter}` as VoiceResponseEpoch
    this.completionStarting = true
    try {
      await this.claimResponseEpoch(voiceSessionId, epoch)
      if (this.disposed || this.voiceSessionId !== voiceSessionId || revision !== this.gateRevision || this.snapshot.phase !== 'idle' || this.gateOpen || this.gateStarting) {
        this.pendingCompletions.unshift(request)
        return
      }
      this.activeCompletion = request
      this.activeResponseEpoch = epoch
      this.completingResponseEpoch = undefined
      this.currentCostEpoch = epoch
      this.generatedResponses.clear()
      this.drainedResponses.clear()
      this.send(clientEvent.completion(request.requestId, request.sessionId, request.title, request.state))
      this.send(clientEvent.createResponse(epoch))
      this.costs.beginRequest()
      this.publish({ phase: 'thinking', transcript: '', sawToolResponse: false, activity: EMPTY_ACTIVITY, errorCode: undefined, cost: this.costs.snapshot() })
      this.armResponseTimeout()
    } catch {
      if (!this.disposed && this.voiceSessionId === voiceSessionId) this.pendingCompletions.unshift(request)
    } finally {
      this.completionStarting = false
    }
  }

  private publish(patch: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Begin gated push-to-talk capture from pointerdown. */
  async beginPushToTalk(): Promise<void> {
    await this.beginGate('ptt')
  }

  /** Commit a voiced PTT phrase; release abandons only a gate that has not captured speech. */
  endPushToTalk(): void {
    if (this.gateMode !== 'ptt') return
    if (this.gateStarting && !this.gateOpen) {
      this.earlyRelease = true
      return
    }
    this.endGate()
  }

  /**
   * Enable or disable local hands-free inference after a user gesture.
   * @param enabled - Requested hands-free state.
   */
  async setHandsFree(enabled: boolean): Promise<void> {
    if (enabled === this.snapshot.handsFree) return
    if (!enabled) {
      this.wakeWord.setEnabled(false)
      this.publish({ handsFree: false, phase: this.gateOpen ? this.snapshot.phase : 'idle' })
      if (!this.gateOpen) await this.stopCapture()
      return
    }
    try {
      await this.coordinator.activate(this)
      await this.ensureCapture()
      this.wakeWord.setEnabled(true)
      this.publish({ handsFree: true, wakeReadiness: wakeReadiness(this.wakeWord.getState()) })
    } catch {
      this.publish({ handsFree: false, phase: 'error', errorCode: 'wake-word' })
    }
  }

  /**
   * Enable or disable the local confirmation signal for accepted wake detections.
   * @param enabled - Requested signal state persisted for this browser profile.
   */
  setWakeSignalEnabled(enabled: boolean): void {
    if (enabled === this.snapshot.wakeSignalEnabled) return
    this.deps.saveWakeSignalPreference(enabled)
    this.publish({ wakeSignalEnabled: enabled })
  }

  private gateInvalid(revision: number): boolean {
    return this.disposed || revision !== this.gateRevision
  }

  private gateReleased(): boolean { return this.earlyRelease }

  private gateEpochClaimed(): boolean { return this.gateResponseEpoch !== undefined }

  private peerInvalid(peer: RTCPeerConnection): boolean { return this.disposed || this.peer !== peer }

  private async beginGate(mode: 'ptt' | 'hands-free'): Promise<void> {
    if (this.disposed || this.gateOpen || this.gateStarting) return
    const interruptsResponse = this.snapshot.phase === 'thinking' || this.snapshot.phase === 'speaking'
    if (this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'error' && !interruptsResponse) return

    const revision = ++this.gateRevision
    this.gateStarting = true
    this.gateMode = mode
    this.earlyRelease = false
    const captureDuringInterruption = interruptsResponse && this.media !== undefined
    if (captureDuringInterruption) this.openGate()
    if (mode === 'hands-free' && this.snapshot.wakeSignalEnabled && this.audioContext !== undefined) {
      try {
        this.deps.playWakeSignal(this.audioContext)
      } catch {
        // Confirmation playback is best-effort and never blocks an accepted wake detection.
      }
    }
    try {
      if (interruptsResponse) {
        this.publish({ phase: 'interrupting', transcript: '', sawToolResponse: false, activity: EMPTY_ACTIVITY, errorCode: undefined })
        const cancelProviderResponse = this.hasOpenActiveResponse()
        this.activeCompletion = undefined
        this.retireActiveResponse()
        this.pauseRemotePlayback()
        if (cancelProviderResponse) this.send(clientEvent.cancelResponse())
        this.send(clientEvent.clearOutput())
        await this.claimGateResponseEpoch(revision)
        if (this.gateInvalid(revision)) return
        this.send(clientEvent.clearOutput())
        if (this.gateReleased()) {
          this.gateStarting = false
          this.gateResponseEpoch = undefined
          this.publish({ phase: 'idle' })
          void this.drainCompletions()
          return
        }
      }

      this.gateStarting = false
      if (!captureDuringInterruption) this.openGate()
      this.publish({ phase: 'requesting-microphone', transcript: '', sawToolResponse: false, activity: EMPTY_ACTIVITY, errorCode: undefined })
      await this.coordinator.activate(this)
      await this.ensureCapture()
      if (this.gateInvalid(revision)) return
      if (this.gateReleased()) {
        await this.settleEmptyGate(revision)
        return
      }
      this.publish({ phase: 'connecting' })
      await this.ensureTransport()
      if (this.gateInvalid(revision)) return
      if (!this.gateEpochClaimed()) await this.claimGateResponseEpoch(revision)
      if (this.gateInvalid(revision)) return
      if (this.gateReleased()) {
        await this.settleEmptyGate(revision)
      } else if (this.commitRequested) {
        this.pump()
      } else {
        this.publish({ phase: 'listening' })
      }
    } catch (error) {
      if (revision !== this.gateRevision) return
      const diagnostic = error instanceof VoiceConnectionStageError ? error.stage : 'capture'
      console.warn('[ui-voice] voice connection stage failed:', diagnostic, error)
      this.gateOpen = false
      this.gateStarting = false
      this.publish({ phase: 'error', errorCode: genericFailureCode(error), transcript: '' })
      await this.stopTransport(false)
    }
  }

  private openGate(): void {
    this.gateOpen = true
    this.gateHadAudio = false
    this.gateHeardVoice = false
    this.commitRequested = false
    this.gateResponseEpoch = undefined
    this.cleared = false
    this.queuedPcm = []
    this.generatedResponses.clear()
    this.drainedResponses.clear()
    this.vadHeardVoice = false
    this.vadSilenceSince = undefined
  }

  private pauseRemotePlayback(): void {
    try {
      this.remoteAudio?.pause()
    } catch {
      // Browser media controls may reject a best-effort local playback stop.
    }
  }

  private resumeRemotePlayback(): void {
    void this.remoteAudio?.play().catch(() => {})
  }

  private async claimGateResponseEpoch(revision: number): Promise<void> {
    const voiceSessionId = this.voiceSessionId
    if (voiceSessionId === undefined) throw new Error('voice transport has no Host session')
    const epoch = `${this.consumerId}:${++this.responseCounter}` as VoiceResponseEpoch
    await this.claimResponseEpoch(voiceSessionId, epoch)
    if (!this.disposed && revision === this.gateRevision && this.voiceSessionId === voiceSessionId) {
      this.gateResponseEpoch = epoch
      this.pump()
    }
  }

  private claimResponseEpoch(voiceSessionId: VoiceSessionId, epoch: VoiceResponseEpoch): Promise<void> {
    const claim = this.responseEpochTail.then(async () => {
      const result = await this.remote.claimResponseEpoch(voiceSessionId, epoch)
      if (!result.ok || result.value.epoch !== epoch) throw new Error('voice response epoch claim rejected')
    })
    this.responseEpochTail = claim.catch(() => {})
    return claim
  }

  private async settleEmptyGate(revision: number): Promise<void> {
    this.gateResponseEpoch = undefined
    const failed = !this.snapshot.handsFree && await this.stopCapture()
    if (this.gateInvalid(revision)) return
    if (failed) this.publish({ phase: 'error', errorCode: 'connection' })
    else {
      this.publish({ phase: 'idle' })
      void this.drainCompletions()
    }
  }

  private endGate(): void {
    if (!this.gateOpen) return
    this.gateOpen = false
    if (!this.gateHadAudio || !this.gateHeardVoice) {
      this.earlyRelease = true
      this.queuedPcm = []
      this.publish({ phase: 'stopping' })
      void this.settleEmptyGate(this.gateRevision)
      return
    }
    this.commitRequested = true
    this.publish({ phase: 'thinking' })
    this.pump()
  }

  private async ensureCapture(): Promise<void> {
    if (this.media !== undefined) return
    const media = await this.deps.getUserMedia()
    if (this.disposed) {
      for (const track of media.getTracks()) track.stop()
      return
    }
    const context = this.deps.createAudioContext()
    const workletUrl = this.deps.createWorkletUrl()
    try {
      await context.audioWorklet.addModule(workletUrl.url)
      const source = context.createMediaStreamSource(media)
      const worklet = this.deps.createWorkletNode(context)
      const silentGain = context.createGain()
      silentGain.gain.value = 0
      source.connect(worklet)
      worklet.connect(silentGain)
      silentGain.connect(context.destination)
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof Float32Array) this.acceptSamples(event.data)
      }
      this.media = media
      this.audioContext = context
      this.source = source
      this.worklet = worklet
      this.silentGain = silentGain
      this.workletRevoke = workletUrl.revoke
      this.resampler = new PcmResampler(context.sampleRate)
    } catch (error) {
      workletUrl.revoke()
      for (const track of media.getTracks()) track.stop()
      await context.close()
      throw error
    }
  }

  /**
   * Accept one worklet chunk; wake gets original Float32 before voice resampling.
   * @param samples - One mono Float32 worklet chunk.
   */
  acceptSamples(samples: Float32Array): void {
    if (this.snapshot.handsFree) this.wakeWord.feed(samples, this.audioContext?.sampleRate ?? 24_000)
    if (!this.gateOpen) return
    const pcm = this.resampler?.push(samples)
    if (pcm === undefined || pcm.length === 0) return
    this.gateHadAudio = true
    if (rms(samples) >= this.config.vadThreshold) this.gateHeardVoice = true
    this.queuedPcm.push(pcm)
    if (this.queuedPcm.length > this.config.maxBufferedChunks) this.queuedPcm.shift()
    if (this.gateMode === 'hands-free') this.updateVad(samples)
    this.pump()
  }

  private updateVad(samples: Float32Array): void {
    const now = this.deps.now()
    if (rms(samples) >= this.config.vadThreshold) {
      this.vadHeardVoice = true
      this.vadSilenceSince = undefined
      return
    }
    if (!this.vadHeardVoice) return
    this.vadSilenceSince ??= now
    if (now - this.vadSilenceSince >= this.config.vadSilenceMs) this.endGate()
  }

  private ensureTransport(): Promise<void> {
    const stopping = this.transportStopPromise
    if (stopping !== undefined) return this.ensureTransportAfterStop(stopping)
    this.connectPromise ??= this.connect()
    return this.connectPromise
  }

  private async ensureTransportAfterStop(stopping: Promise<boolean>): Promise<void> {
    if (await stopping) throw new Error('previous voice transport failed to stop')
    return this.ensureTransport()
  }

  private async connect(): Promise<void> {
    const peer = this.deps.createPeerConnection()
    this.peer = peer
    peer.addTransceiver('audio', { direction: 'recvonly' })
    const channel = peer.createDataChannel('oai-events', { ordered: true })
    channel.bufferedAmountLowThreshold = this.config.channelLowWaterBytes
    channel.onmessage = (event) => { this.handleChannelMessage(event.data) }
    channel.onbufferedamountlow = () => { this.pump() }
    this.channel = channel

    const remoteAudio = this.deps.createAudioElement()
    remoteAudio.autoplay = true
    remoteAudio.hidden = true
    remoteAudio.dataset.dshVoice = this.consumerId
    document.body.append(remoteAudio)
    this.remoteAudio = remoteAudio
    peer.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void remoteAudio.play().catch(() => {})
    }

    const offer = await connectionStage('offer', () => peer.createOffer())
    await connectionStage('local-description', () => peer.setLocalDescription(offer))
    await connectionStage('ice', () => waitForCompleteIce(peer, this.deps, this.config.iceTimeoutMs))
    const sdp = peer.localDescription?.sdp
    if (sdp === undefined) throw new Error('complete local SDP unavailable')
    const foregroundSessionId = this.foregroundSessionId()
    const started = await connectionStage('host-start', () => this.remote.start({
      sdp,
      consumerId: this.consumerId,
      ...(foregroundSessionId === undefined ? {} : { foregroundSessionId }),
    }))
    if (!started.ok) {
      console.warn('[ui-voice] Host rejected voice start:', started.error.code, started.error.message)
      throw new VoiceConnectionStageError(`host-rejected:${started.error.code}`, started.error)
    }
    if (this.peerInvalid(peer)) {
      await this.remote.stop(started.value.sessionId).catch(() => undefined)
      return
    }
    this.voiceSessionId = started.value.sessionId
    await connectionStage('remote-description', () => peer.setRemoteDescription({ type: 'answer', sdp: started.value.answerSdp }))
    await connectionStage('transport-ready', () => Promise.all([this.waitForChannel(channel), this.waitForSideband(started.value.sessionId)]))
    channel.onerror = () => { this.failLiveTransport(channel) }
    channel.onclose = () => { this.failLiveTransport(channel) }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.failLiveTransport(channel)
    }
    const latestForeground = this.foregroundSessionId()
    if (latestForeground !== foregroundSessionId) await this.setForeground(latestForeground)
    if (this.peerInvalid(peer)) return
    this.ready = true
    this.pump()
    void this.drainCompletions()
  }

  private failLiveTransport(channel: RTCDataChannel): void {
    if (this.disposed || this.channel !== channel || this.transportStopPromise !== undefined) return
    this.publish({ phase: 'error', errorCode: 'connection' })
    void this.stopTransport(false)
  }

  private waitForChannel(channel: RTCDataChannel): Promise<void> {
    if (channel.readyState === 'open') return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.deps.clearTimeout(timeout)
        channel.onopen = null
        channel.onerror = null
        channel.onclose = null
      }
      const succeed = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (message: string) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(message))
      }
      const timeout = this.deps.setTimeout(() => { fail('voice data channel timed out') }, this.config.channelTimeoutMs)
      channel.onopen = succeed
      channel.onerror = () => { fail('voice data channel failed') }
      channel.onclose = () => { fail('voice data channel closed before opening') }
    })
  }

  private async waitForSideband(voiceSessionId: VoiceSessionId): Promise<void> {
    for (let attempt = 0; attempt < this.config.statusAttempts; attempt += 1) {
      const result = await this.remote.status(voiceSessionId)
      if (!result.ok) throw new Error('voice status rejected')
      const state: string = result.value.state
      if (state === 'failed') throw new Error('voice host session failed')
      if (result.value.sidebandReady) return
      if (attempt + 1 < this.config.statusAttempts) await sleep(this.deps, this.config.statusIntervalMs)
    }
    throw new Error('voice sideband timed out')
  }

  private send(payload: object): void {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(payload))
  }

  private pump(): void {
    if (this.pumping || !this.ready) return
    this.pumping = true
    try {
      const channel = this.channel
      if (channel?.readyState !== 'open') return
      if (!this.cleared) {
        this.send(clientEvent.clear())
        this.cleared = true
      }
      while (this.queuedPcm.length > 0 && channel.bufferedAmount <= this.config.channelHighWaterBytes) {
        const chunk = this.queuedPcm.shift()
        if (chunk !== undefined) this.send(clientEvent.append(pcmBase64(chunk)))
      }
      if (this.commitRequested && this.queuedPcm.length === 0 && this.gateResponseEpoch !== undefined) {
        const epoch = this.gateResponseEpoch
        this.gateResponseEpoch = undefined
        this.commitRequested = false
        this.send(clientEvent.commit())
        this.activeResponseEpoch = epoch
        this.completingResponseEpoch = undefined
        this.currentCostEpoch = epoch
        this.send(clientEvent.createResponse(epoch))
        this.costs.beginRequest()
        this.publish({ cost: this.costs.snapshot() })
        this.armResponseTimeout()
      }
    } finally {
      this.pumping = false
    }
  }

  private startActivityStep(callId: string, tool: VoiceActivityTool, plannedText: string | undefined): void {
    if (this.snapshot.activity.steps.some(step => step.callId === callId)) return
    const completed = this.snapshot.activity.steps.map(step => step.status === 'running' ? { ...step, status: 'completed' as const } : step)
    const steps = [...completed, { callId, tool, status: 'running' as const }].slice(-MAX_ACTIVITY_STEPS)
    this.publish({
      activity: {
        steps,
        plannedText: plannedText ?? this.snapshot.activity.plannedText,
        finalText: this.snapshot.activity.finalText,
      },
    })
  }

  private completeActivityStep(): void {
    const index = this.snapshot.activity.steps.findLastIndex(step => step.status === 'running')
    if (index < 0) return
    const steps = this.snapshot.activity.steps.map((step, stepIndex) => stepIndex === index ? { ...step, status: 'completed' as const } : step)
    this.publish({ activity: { ...this.snapshot.activity, steps } })
  }

  private handleChannelMessage(raw: unknown): void {
    const event = parseVoiceEvent(raw)
    if (event.kind === 'input-committed') {
      const epoch = this.activeResponseEpoch
      if (epoch === undefined) return
      this.inputOwners.set(event.itemId, epoch)
      if (this.inputOwners.size > MAX_TRACKED_RESPONSE_OWNERS) this.inputOwners.delete(this.inputOwners.keys().next().value!)
      return
    }
    if (event.kind === 'transcription-usage') {
      const owner = event.itemId === undefined ? this.activeResponseEpoch : this.inputOwners.get(event.itemId)
      const includeCurrent = owner !== undefined && owner === this.currentCostEpoch
      if (this.costs.addTranscription(event.usage, event.eventId, includeCurrent)) this.publish({ cost: this.costs.snapshot() })
      if (event.itemId !== undefined) this.inputOwners.delete(event.itemId)
      return
    }
    if (
      (event.kind === 'response-tool' || event.kind === 'response-generation-final' || event.kind === 'response-error')
      && event.usage !== undefined
    ) {
      const owner = event.responseId === undefined ? this.activeResponseEpoch : this.responseOwners.get(event.responseId)
      const includeCurrent = owner !== undefined && owner === this.currentCostEpoch
      if (this.costs.addRealtime(event.usage, event.responseId, includeCurrent)) this.publish({ cost: this.costs.snapshot() })
    }
    if (event.kind === 'response-started') {
      const epoch = this.activeResponseEpoch
      if (epoch === undefined || event.epoch !== epoch) return
      this.responseOwners.set(event.responseId, epoch)
      this.openResponses.add(event.responseId)
      this.resumeRemotePlayback()
      if (this.responseOwners.size > MAX_TRACKED_RESPONSE_OWNERS) {
        const oldest = this.responseOwners.keys().next().value
        if (oldest !== undefined) {
          this.responseOwners.delete(oldest)
          this.openResponses.delete(oldest)
        }
      }
      this.publish({ phase: 'thinking' })
    } else if (event.kind === 'transcript-delta') {
      if (!this.ownsActiveResponse(event.responseId)) return
      this.publish({ phase: 'speaking', transcript: this.snapshot.transcript + event.text })
    } else if (event.kind === 'transcript-final') {
      if (!this.ownsActiveResponse(event.responseId)) return
      this.publish({
        phase: 'speaking', transcript: event.text,
        activity: { ...this.snapshot.activity, finalText: event.text },
      })
    } else if (event.kind === 'activity-step') {
      if (event.responseId !== undefined && !this.ownsActiveResponse(event.responseId)) return
      this.startActivityStep(event.callId, event.tool, event.plannedText)
    } else if (event.kind === 'response-tool') {
      if (!this.ownsActiveResponse(event.responseId)) return
      this.openResponses.delete(event.responseId)
      if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
      this.responseTimer = undefined
      this.completeActivityStep()
      this.publish({ phase: 'thinking', sawToolResponse: true })
    } else if (event.kind === 'response-generation-final') {
      if (!this.ownsActiveResponse(event.responseId)) return
      this.openResponses.delete(event.responseId)
      this.completeActivityStep()
      if (this.snapshot.activity.finalText === '' && this.snapshot.transcript !== '') {
        this.publish({ activity: { ...this.snapshot.activity, finalText: this.snapshot.transcript } })
      }
      this.generatedResponses.add(event.responseId)
      this.finishDrainedResponse(event.responseId)
    } else if (event.kind === 'response-playback-stopped') {
      if (!this.ownsActiveResponse(event.responseId)) return
      this.drainedResponses.add(event.responseId)
      this.finishDrainedResponse(event.responseId)
    } else if (event.kind === 'response-error') {
      if (event.detail === 'response_cancel_not_active') return
      if (event.responseId !== undefined && !this.ownsActiveResponse(event.responseId)) return
      if (event.responseId !== undefined) this.openResponses.delete(event.responseId)
      const diagnostic = `response:${event.detail ?? event.code}`
      console.warn('[ui-voice] provider response failed:', diagnostic)
      this.publish({ phase: 'error', errorCode: 'response' })
      void this.stopTransport(false)
    }
  }

  private armResponseTimeout(): void {
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    const epoch = this.activeResponseEpoch
    this.responseTimer = this.deps.setTimeout(() => {
      if (epoch !== undefined && this.activeResponseEpoch === epoch) void this.cancel()
    }, this.config.responseTimeoutMs)
  }

  private ownsActiveResponse(responseId: string): boolean {
    const epoch = this.activeResponseEpoch
    return epoch !== undefined && this.responseOwners.get(responseId) === epoch
  }

  private hasOpenActiveResponse(): boolean {
    for (const responseId of this.openResponses) if (this.ownsActiveResponse(responseId)) return true
    return false
  }

  private retireActiveResponse(): void {
    this.activeResponseEpoch = undefined
    this.completingResponseEpoch = undefined
    this.openResponses.clear()
    this.generatedResponses.clear()
    this.drainedResponses.clear()
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    this.responseTimer = undefined
  }

  private finishDrainedResponse(responseId: string): void {
    if (!this.generatedResponses.has(responseId) || !this.drainedResponses.has(responseId)) return
    const epoch = this.activeResponseEpoch
    if (epoch === undefined || this.responseOwners.get(responseId) !== epoch || this.completingResponseEpoch === epoch) return
    this.generatedResponses.delete(responseId)
    this.drainedResponses.delete(responseId)
    this.completingResponseEpoch = epoch
    void this.finishResponse(epoch)
  }

  private async finishResponse(epoch: VoiceResponseEpoch): Promise<void> {
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    this.responseTimer = undefined
    const failed = !this.snapshot.handsFree && await this.stopCapture()
    if (this.activeResponseEpoch !== epoch || this.completingResponseEpoch !== epoch) return
    this.activeResponseEpoch = undefined
    this.completingResponseEpoch = undefined
    this.activeCompletion = undefined
    if (failed) this.publish({ phase: 'error', errorCode: 'connection' })
    else {
      this.publish({ phase: 'idle' })
      void this.drainCompletions()
    }
  }

  /** Cancel capture/response, clear playback, and keep explicitly armed hands-free capture local. */
  async cancel(): Promise<void> {
    if (this.disposed) return
    this.gateRevision += 1
    this.gateStarting = false
    this.gateOpen = false
    this.queuedPcm = []
    this.commitRequested = false
    this.publish({ phase: 'stopping', transcript: '', activity: EMPTY_ACTIVITY })
    this.send(clientEvent.cancelResponse())
    this.send(clientEvent.clearOutput())
    const failed = await this.stopTransport(this.snapshot.handsFree)
    if (!failed) this.publish({ phase: 'idle', transcript: '' })
  }

  /** Stop this session when another mounted session takes microphone ownership. */
  async deactivateForNavigation(): Promise<void> {
    this.gateRevision += 1
    this.gateStarting = false
    this.gateOpen = false
    this.wakeWord.setEnabled(false)
    this.publish({ handsFree: false, phase: 'stopping', transcript: '', activity: EMPTY_ACTIVITY })
    this.send(clientEvent.cancelResponse())
    this.send(clientEvent.clearOutput())
    const failed = await this.stopTransport(false)
    if (!failed) this.publish({ phase: 'idle', transcript: '' })
  }

  private stopTransport(preserveCapture: boolean): Promise<boolean> {
    const active = this.transportStopPromise
    if (active !== undefined) return this.joinTransportStop(active, preserveCapture)
    const operation = this.performStopTransport(preserveCapture)
    this.transportStopPromise = operation
    const clear = () => { if (this.transportStopPromise === operation) this.transportStopPromise = undefined }
    void operation.then(clear, clear)
    return operation
  }

  private async joinTransportStop(active: Promise<boolean>, preserveCapture: boolean): Promise<boolean> {
    let failed = await active
    if (!preserveCapture || !this.snapshot.handsFree) failed = (await this.stopCapture()) || failed
    if (failed) this.publish({ phase: 'error', errorCode: 'connection' })
    return failed
  }

  private async performStopTransport(preserveCapture: boolean): Promise<boolean> {
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    this.responseTimer = undefined
    const voiceSessionId = this.voiceSessionId
    const connecting = this.connectPromise
    const channel = this.channel
    const peer = this.peer
    const remoteAudio = this.remoteAudio
    this.voiceSessionId = undefined
    this.ready = false
    this.pendingCompletions.length = 0
    this.activeCompletion = undefined
    this.connectPromise = undefined
    this.cleared = false
    this.gateResponseEpoch = undefined
    this.activeResponseEpoch = undefined
    this.completingResponseEpoch = undefined
    this.responseOwners.clear()
    this.inputOwners.clear()
    this.openResponses.clear()
    this.generatedResponses.clear()
    this.drainedResponses.clear()
    this.channel = undefined
    this.peer = undefined
    this.remoteAudio = undefined
    let failed = false
    const channelOpening = channel !== undefined && channel.readyState !== 'open'
    if (channelOpening) {
      try {
        channel.close()
      } catch {
        failed = true
      }
    }
    if (channel !== undefined) {
      channel.onmessage = null
      channel.onbufferedamountlow = null
      channel.onopen = null
      channel.onerror = null
      channel.onclose = null
    }
    if (peer !== undefined) {
      peer.ontrack = null
      peer.onconnectionstatechange = null
    }
    if (!channelOpening) {
      try {
        channel?.close()
      } catch {
        failed = true
      }
    }
    try {
      peer?.close()
    } catch {
      failed = true
    }
    if (remoteAudio !== undefined) {
      try {
        remoteAudio.pause()
      } catch {
        failed = true
      }
      try {
        remoteAudio.srcObject = null
        remoteAudio.remove()
      } catch {
        failed = true
      }
    }
    if (connecting !== undefined && voiceSessionId === undefined) {
      try {
        await connecting
      } catch {
        // The connection path reports its own stage; teardown still releases any accepted Host call.
      }
    }
    try {
      if (voiceSessionId !== undefined) {
        const result = await this.remote.stop(voiceSessionId)
        if (!result.ok) failed = true
      }
    } catch {
      failed = true
    } finally {
      if (!preserveCapture || !this.snapshot.handsFree) {
        failed = (await this.stopCapture()) || failed
      }
    }
    if (failed) this.publish({ phase: 'error', errorCode: 'connection' })
    return failed
  }

  private async stopCapture(): Promise<boolean> {
    const worklet = this.worklet
    const source = this.source
    const silentGain = this.silentGain
    const media = this.media
    const revoke = this.workletRevoke
    const context = this.audioContext
    this.media = undefined
    this.source = undefined
    this.worklet = undefined
    this.silentGain = undefined
    this.resampler = undefined
    this.workletRevoke = undefined
    this.audioContext = undefined
    let failed = false
    try {
      worklet?.port.close()
    } catch {
      failed = true
    }
    try {
      source?.disconnect()
    } catch {
      failed = true
    }
    try {
      worklet?.disconnect()
    } catch {
      failed = true
    }
    try {
      silentGain?.disconnect()
    } catch {
      failed = true
    }
    for (const track of media?.getTracks() ?? []) {
      try {
        track.stop()
      } catch {
        failed = true
      }
    }
    try {
      revoke?.()
    } catch {
      failed = true
    }
    try {
      if (context !== undefined && context.state !== 'closed') await context.close()
    } catch {
      failed = true
    } finally {
      this.coordinator.release(this)
    }
    return failed
  }

  /** Stop every owned resource; provider lifetime remains with Cordis. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.gateRevision += 1
    this.gateStarting = false
    this.gateOpen = false
    if (this.snapshot.handsFree) this.wakeWord.setEnabled(false)
    this.unsubscribeWakeState()
    this.unsubscribeDetection()
    this.listeners.clear()
    this.send(clientEvent.cancelResponse())
    this.send(clientEvent.clearOutput())
    await this.stopTransport(false)
    this.queuedPcm = []
  }
}
