import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { VoiceCostAccumulator, type VoiceCostSnapshot } from './cost.ts'
import { clientEvent, parseVoiceEvent } from './events.ts'
import { PcmResampler, pcmBase64, rms } from './pcm.ts'
import type { VoiceRemote, VoiceSessionId } from './remote-adapter.ts'
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

/** Immutable session voice snapshot. */
export interface VoiceSnapshot {
  phase: VoicePhase
  handsFree: boolean
  wakeReadiness: WakeReadiness
  calibration: VoiceCalibrationSnapshot
  transcript: string
  sawToolResponse: boolean
  cost: VoiceCostSnapshot
  errorCode: 'microphone' | 'connection' | 'wake-word' | 'response' | 'calibration' | undefined
}

/** Browser construction hooks replaced by deterministic fakes in tests. */
export interface VoiceBrowserDeps {
  getUserMedia(): Promise<MediaStream>
  createAudioContext(): AudioContext
  createWorkletNode(context: AudioContext): AudioWorkletNode
  createPeerConnection(): RTCPeerConnection
  createAudioElement(): HTMLAudioElement
  createWorkletUrl(): { url: string; revoke: () => void }
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
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle),
  now: () => performance.now(),
}

function genericFailureCode(error: unknown): VoiceSnapshot['errorCode'] {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'NotFoundError')) return 'microphone'
  return 'connection'
}

function sleep(deps: VoiceBrowserDeps, delay: number): Promise<void> {
  return new Promise(resolve => deps.setTimeout(resolve, delay))
}

function joinFloatChunks(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const joined = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

/** Coordinates exclusive microphone ownership across mounted session entries. */
export class VoiceControllerCoordinator {
  private active: VoiceSessionController | undefined

  /**
   * Tear down the previous session before the next controller acquires media.
   * @param next - controller receiving microphone ownership.
   */
  async activate(next: VoiceSessionController): Promise<void> {
    if (this.active === next) return
    const previous = this.active
    this.active = next
    if (previous !== undefined) await previous.deactivateForNavigation()
  }

  /** Release ownership if the named controller still owns it. */
  release(controller: VoiceSessionController): void {
    if (this.active === controller) this.active = undefined
  }
}

/**
 * Wait until ICE gathering is complete so the Host receives a self-contained
 * offer rather than depending on browser trickle ICE.
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
  private earlyRelease = false
  private ready = false
  private cleared = false
  private commitRequested = false
  private pumping = false
  private disposed = false
  private responseTimer: ReturnType<typeof setTimeout> | undefined
  private readonly generatedResponses = new Set<string>()
  private readonly drainedResponses = new Set<string>()
  private vadSilenceSince: number | undefined
  private vadHeardVoice = false
  private calibrationChunks: Float32Array[] = []

  constructor(
    readonly sessionId: SessionId,
    private readonly remote: VoiceRemote,
    private readonly wakeWord: WakeWordPort,
    private readonly coordinator: VoiceControllerCoordinator,
    private readonly config: VoiceRuntimeConfig,
    private readonly deps: VoiceBrowserDeps = browserVoiceDeps,
  ) {
    const wake = wakeWord.getState()
    this.snapshot = {
      phase: 'idle',
      handsFree: false,
      wakeReadiness: wakeReadiness(wake),
      calibration: { ...wake.calibration, recording: false, pending: false },
      transcript: '',
      sawToolResponse: false,
      cost: this.costs.snapshot(),
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
    this.unsubscribeDetection = wakeWord.onDetection((detection) => {
      if (!this.snapshot.handsFree || detection.keyword !== 'БРО') return
      void this.beginGate('hands-free')
    })
  }

  /** @returns the identity-stable immutable snapshot. */
  getSnapshot = (): VoiceSnapshot => this.snapshot

  /** Subscribe to snapshot replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(patch: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Begin gated push-to-talk capture from pointerdown. */
  async beginPushToTalk(): Promise<void> {
    await this.beginGate('ptt')
  }

  /** Commit a non-empty PTT phrase; release during response interruption abandons the pending gate. */
  endPushToTalk(): void {
    if (this.gateMode !== 'ptt') return
    if (this.gateStarting) {
      this.earlyRelease = true
      return
    }
    this.endGate()
  }

  /** Enable or disable local hands-free inference after a user gesture. */
  async setHandsFree(enabled: boolean): Promise<void> {
    if (enabled === this.snapshot.handsFree) return
    if (!enabled) {
      this.wakeWord.setEnabled(false)
      this.publish({ handsFree: false, phase: this.gateOpen ? this.snapshot.phase : 'idle' })
      if (!this.gateOpen && this.peer === undefined) await this.stopCapture()
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

  /** Begin a replacing three-or-provider-required-sample calibration transaction. */
  async startCalibration(): Promise<void> {
    try {
      await this.coordinator.activate(this)
      await this.ensureCapture()
      this.wakeWord.setEnabled(false)
      this.wakeWord.beginCalibration()
      const state = this.wakeWord.getState().calibration
      this.publish({ calibration: { ...state, recording: false, pending: false }, errorCode: undefined })
    } catch {
      this.publish({ phase: 'error', errorCode: 'calibration' })
    }
  }

  /** Start collecting one isolated local БРО pronunciation. */
  async beginCalibrationSample(): Promise<void> {
    if (!this.snapshot.calibration.active || this.snapshot.calibration.pending) return
    await this.coordinator.activate(this)
    await this.ensureCapture()
    this.calibrationChunks = []
    this.publish({ calibration: { ...this.snapshot.calibration, recording: true } })
  }

  /** Derive one template, discard raw PCM, and commit after the required count. */
  async endCalibrationSample(): Promise<void> {
    if (!this.snapshot.calibration.recording) return
    const chunks = this.calibrationChunks
    this.calibrationChunks = []
    this.publish({ calibration: { ...this.snapshot.calibration, recording: false, pending: true } })
    const sample = joinFloatChunks(chunks)
    try {
      if (sample.length === 0) throw new Error('empty calibration sample')
      const count = await this.wakeWord.addCalibrationSample(sample, this.audioContext?.sampleRate ?? 24_000)
      const required = this.wakeWord.getState().calibration.requiredSamples
      if (count >= required) await this.wakeWord.commitCalibration()
      const state = this.wakeWord.getState()
      this.publish({
        wakeReadiness: wakeReadiness(state),
        calibration: { ...state.calibration, recording: false, pending: false },
      })
      if (!state.calibration.active && !this.snapshot.handsFree) await this.stopCapture()
    } catch {
      this.publish({
        calibration: { ...this.snapshot.calibration, recording: false, pending: false },
        errorCode: 'calibration',
      })
    } finally {
      sample.fill(0)
      for (const chunk of chunks) chunk.fill(0)
    }
  }

  private async beginGate(mode: 'ptt' | 'hands-free'): Promise<void> {
    if (this.disposed || this.gateOpen || this.gateStarting) return
    const interruptsResponse = this.snapshot.phase === 'thinking' || this.snapshot.phase === 'speaking'
    if (this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'error' && !interruptsResponse) return

    const revision = ++this.gateRevision
    this.gateStarting = true
    this.gateMode = mode
    this.earlyRelease = false
    if (interruptsResponse) {
      this.publish({ phase: 'interrupting', transcript: '', sawToolResponse: false, errorCode: undefined })
      this.send(clientEvent.cancelResponse())
      this.send(clientEvent.clearOutput())
      const failed = await this.stopTransport(this.snapshot.handsFree)
      if (this.disposed || revision !== this.gateRevision) return
      if (failed) {
        this.gateStarting = false
        return
      }
      if (this.earlyRelease) {
        this.gateStarting = false
        this.publish({ phase: 'idle' })
        return
      }
    }

    this.gateStarting = false
    this.gateOpen = true
    this.gateHadAudio = false
    this.commitRequested = false
    this.cleared = false
    this.queuedPcm = []
    this.generatedResponses.clear()
    this.drainedResponses.clear()
    this.vadHeardVoice = false
    this.vadSilenceSince = undefined
    this.publish({ phase: 'requesting-microphone', transcript: '', sawToolResponse: false, errorCode: undefined })
    try {
      await this.coordinator.activate(this)
      await this.ensureCapture()
      if (this.disposed || revision !== this.gateRevision) return
      if (this.earlyRelease) {
        const failed = await this.stopTransport(false)
        if (!failed && revision === this.gateRevision) this.publish({ phase: 'idle' })
        return
      }
      this.publish({ phase: 'connecting' })
      await this.ensureTransport()
      if (this.disposed || revision !== this.gateRevision) return
      if (this.earlyRelease) {
        const failed = await this.stopTransport(false)
        if (!failed && revision === this.gateRevision) this.publish({ phase: 'idle' })
      } else if (this.gateOpen) {
        this.publish({ phase: 'listening' })
      }
    } catch (error) {
      if (revision !== this.gateRevision) return
      this.gateOpen = false
      this.gateStarting = false
      this.publish({ phase: 'error', errorCode: genericFailureCode(error) })
      await this.stopTransport(false)
    }
  }

  private endGate(): void {
    if (!this.gateOpen) return
    this.gateOpen = false
    if (!this.gateHadAudio) {
      this.earlyRelease = true
      this.publish({ phase: 'stopping' })
      return
    }
    this.commitRequested = true
    this.publish({ phase: 'thinking' })
    void this.pump()
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

  /** Accept one worklet chunk; wake gets original Float32 before voice resampling. */
  acceptSamples(samples: Float32Array): void {
    if (this.snapshot.calibration.recording) {
      this.calibrationChunks.push(samples.slice())
      return
    }
    if (this.snapshot.handsFree) this.wakeWord.feed(samples, this.audioContext?.sampleRate ?? 24_000)
    if (!this.gateOpen) return
    const pcm = this.resampler?.push(samples)
    if (pcm === undefined || pcm.length === 0) return
    this.gateHadAudio = true
    this.queuedPcm.push(pcm)
    if (this.queuedPcm.length > this.config.maxBufferedChunks) this.queuedPcm.shift()
    if (this.gateMode === 'hands-free') this.updateVad(samples)
    void this.pump()
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
    this.connectPromise ??= this.connect()
    return this.connectPromise
  }

  private async connect(): Promise<void> {
    const peer = this.deps.createPeerConnection()
    this.peer = peer
    peer.addTransceiver('audio', { direction: 'recvonly' })
    const channel = peer.createDataChannel('oai-events', { ordered: true })
    channel.bufferedAmountLowThreshold = this.config.channelLowWaterBytes
    channel.onmessage = event => { this.handleChannelMessage(event.data) }
    channel.onbufferedamountlow = () => { void this.pump() }
    this.channel = channel

    const remoteAudio = this.deps.createAudioElement()
    remoteAudio.autoplay = true
    remoteAudio.hidden = true
    remoteAudio.dataset.dshVoice = this.sessionId
    document.body.append(remoteAudio)
    this.remoteAudio = remoteAudio
    peer.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void remoteAudio.play().catch(() => {})
    }

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await waitForCompleteIce(peer, this.deps, this.config.iceTimeoutMs)
    const sdp = peer.localDescription?.sdp
    if (sdp === undefined) throw new Error('complete local SDP unavailable')
    const started = await this.remote.start(this.sessionId, { sdp })
    if (!started.ok) throw new Error('voice start rejected')
    this.voiceSessionId = started.value.sessionId
    await peer.setRemoteDescription({ type: 'answer', sdp: started.value.answerSdp })
    await Promise.all([this.waitForChannel(channel), this.waitForSideband(started.value.sessionId)])
    if (this.disposed || this.peer !== peer) return
    this.ready = true
    await this.pump()
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
      const result = await this.remote.status(this.sessionId, voiceSessionId)
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

  private async pump(): Promise<void> {
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
      if (this.commitRequested && this.queuedPcm.length === 0) {
        this.commitRequested = false
        this.send(clientEvent.commit())
        this.send(clientEvent.createResponse())
        this.costs.beginRequest()
        this.publish({ cost: this.costs.snapshot() })
        this.armResponseTimeout()
      }
    } finally {
      this.pumping = false
    }
  }

  private handleChannelMessage(raw: unknown): void {
    const event = parseVoiceEvent(raw)
    if (event.kind === 'transcription-usage') {
      if (this.costs.addTranscription(event.usage, event.eventId)) this.publish({ cost: this.costs.snapshot() })
      return
    }
    if (
      (event.kind === 'response-tool' || event.kind === 'response-generation-final' || event.kind === 'response-error')
      && event.usage !== undefined
      && this.costs.addRealtime(event.usage, event.responseId)
    ) this.publish({ cost: this.costs.snapshot() })
    if (event.kind === 'transcript-delta') {
      this.publish({ phase: 'speaking', transcript: this.snapshot.transcript + event.text })
    } else if (event.kind === 'transcript-final') {
      this.publish({ phase: 'speaking', transcript: event.text })
    } else if (event.kind === 'response-started') {
      this.publish({ phase: 'thinking' })
    } else if (event.kind === 'response-tool') {
      if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
      this.responseTimer = undefined
      this.publish({ phase: 'thinking', sawToolResponse: true })
    } else if (event.kind === 'response-generation-final') {
      this.generatedResponses.add(event.responseId)
      this.finishDrainedResponse(event.responseId)
    } else if (event.kind === 'response-playback-stopped') {
      this.drainedResponses.add(event.responseId)
      this.finishDrainedResponse(event.responseId)
    } else if (event.kind === 'response-error') {
      this.publish({ phase: 'error', errorCode: 'response' })
      void this.stopTransport(false)
    }
  }

  private armResponseTimeout(): void {
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    this.responseTimer = this.deps.setTimeout(() => { void this.cancel() }, this.config.responseTimeoutMs)
  }

  private finishDrainedResponse(responseId: string): void {
    if (!this.generatedResponses.has(responseId) || !this.drainedResponses.has(responseId)) return
    this.generatedResponses.delete(responseId)
    this.drainedResponses.delete(responseId)
    void this.finishResponse()
  }

  private async finishResponse(): Promise<void> {
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    this.responseTimer = undefined
    const failed = await this.stopTransport(true)
    if (!failed) this.publish({ phase: 'idle' })
  }

  /** Cancel capture/response, clear playback, and keep explicitly armed hands-free capture local. */
  async cancel(): Promise<void> {
    if (this.disposed) return
    this.gateRevision += 1
    this.gateStarting = false
    this.gateOpen = false
    this.queuedPcm = []
    this.commitRequested = false
    this.publish({ phase: 'stopping' })
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
    this.calibrationChunks = []
    this.wakeWord.setEnabled(false)
    this.publish({ handsFree: false, phase: 'stopping' })
    this.send(clientEvent.cancelResponse())
    this.send(clientEvent.clearOutput())
    const failed = await this.stopTransport(false)
    if (!failed) this.publish({ phase: 'idle', transcript: '' })
  }

  private async stopTransport(preserveCapture: boolean): Promise<boolean> {
    if (this.responseTimer !== undefined) this.deps.clearTimeout(this.responseTimer)
    this.responseTimer = undefined
    const voiceSessionId = this.voiceSessionId
    const channel = this.channel
    const peer = this.peer
    const remoteAudio = this.remoteAudio
    this.voiceSessionId = undefined
    this.ready = false
    this.connectPromise = undefined
    this.cleared = false
    this.generatedResponses.clear()
    this.drainedResponses.clear()
    this.channel = undefined
    this.peer = undefined
    this.remoteAudio = undefined
    let failed = false
    try {
      channel?.close()
    } catch {
      failed = true
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
    try {
      if (voiceSessionId !== undefined) {
        const result = await this.remote.stop(this.sessionId, voiceSessionId)
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
    for (const chunk of this.calibrationChunks) chunk.fill(0)
    this.calibrationChunks = []
  }
}
