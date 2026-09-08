import { browserVoiceDeps, type VoiceBrowserDeps, type VoiceCaptureOwner, VoiceControllerCoordinator } from './controller.ts'
import { wakeReadiness, type WakeReadiness, type WakeWordPort } from './wake-word-adapter.ts'

/** Root-scoped Settings snapshot for browser-local wake calibration. */
export interface VoiceCalibrationSettingsSnapshot {
  wakeReadiness: WakeReadiness
  calibration: {
    active: boolean
    recording: boolean
    sampleCount: number
    requiredSamples: number
    pending: boolean
  }
  error: boolean
}

type CalibrationDeps = Pick<VoiceBrowserDeps,
  'getUserMedia' | 'createAudioContext' | 'createWorkletNode' | 'createWorkletUrl'>

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

/** Owns Settings microphone capture and replacing wake-template transactions. */
export class VoiceCalibrationController implements VoiceCaptureOwner {
  private snapshot: VoiceCalibrationSettingsSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeWakeState: () => void
  private media: MediaStream | undefined
  private audioContext: AudioContext | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private worklet: AudioWorkletNode | undefined
  private silentGain: GainNode | undefined
  private workletRevoke: (() => void) | undefined
  private chunks: Float32Array[] = []
  private disposed = false

  constructor(
    private readonly wakeWord: WakeWordPort,
    private readonly coordinator: VoiceControllerCoordinator,
    private readonly deps: CalibrationDeps = browserVoiceDeps,
  ) {
    const state = wakeWord.getState()
    this.snapshot = {
      wakeReadiness: wakeReadiness(state),
      calibration: { ...state.calibration, recording: false, pending: false },
      error: false,
    }
    this.unsubscribeWakeState = wakeWord.subscribe(() => {
      const current = wakeWord.getState()
      this.publish({
        wakeReadiness: wakeReadiness(current),
        calibration: {
          ...this.snapshot.calibration,
          active: current.calibration.active,
          sampleCount: current.calibration.sampleCount,
          requiredSamples: current.calibration.requiredSamples,
        },
      })
    })
  }

  /**
   * Read the current immutable Settings snapshot.
   * @returns Current calibration Settings snapshot.
   */
  getSnapshot = (): VoiceCalibrationSettingsSnapshot => this.snapshot

  /**
   * Subscribe to calibration snapshot replacements.
   * @param listener - Callback invoked after snapshot replacement.
   * @returns Subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Begin an initial or replacing calibration transaction from a user gesture. */
  async startCalibration(): Promise<void> {
    try {
      await this.coordinator.activate(this)
      await this.ensureCapture()
      this.wakeWord.setEnabled(false)
      this.wakeWord.beginCalibration()
      const calibration = this.wakeWord.getState().calibration
      this.publish({ calibration: { ...calibration, recording: false, pending: false }, error: false })
    } catch {
      this.publish({ error: true })
      await this.stopCapture()
    }
  }

  /** Start collecting one isolated БРО pronunciation. */
  async beginCalibrationSample(): Promise<void> {
    if (!this.snapshot.calibration.active || this.snapshot.calibration.pending) return
    try {
      await this.coordinator.activate(this)
      await this.ensureCapture()
      this.chunks = []
      this.publish({ calibration: { ...this.snapshot.calibration, recording: true }, error: false })
    } catch {
      this.publish({ error: true })
      await this.stopCapture()
    }
  }

  /** Derive one template, wipe raw PCM, and commit after the required count. */
  async endCalibrationSample(): Promise<void> {
    if (!this.snapshot.calibration.recording) return
    const chunks = this.chunks
    this.chunks = []
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
        error: false,
      })
      if (!state.calibration.active) await this.stopCapture()
    } catch {
      this.publish({
        calibration: { ...this.snapshot.calibration, recording: false, pending: false },
        error: true,
      })
    } finally {
      sample.fill(0)
      for (const chunk of chunks) chunk.fill(0)
    }
  }

  /** Yield microphone ownership while preserving an unfinished template transaction. */
  async deactivateForNavigation(): Promise<void> {
    for (const chunk of this.chunks) chunk.fill(0)
    this.chunks = []
    this.publish({ calibration: { ...this.snapshot.calibration, recording: false, pending: false } })
    await this.stopCapture()
  }

  /** Stop capture and unsubscribe; the wake provider remains Cordis-owned. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeWakeState()
    await this.deactivateForNavigation()
    this.listeners.clear()
  }

  private publish(patch: Partial<VoiceCalibrationSettingsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
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
        if (event.data instanceof Float32Array && this.snapshot.calibration.recording) this.chunks.push(event.data.slice())
      }
      this.media = media
      this.audioContext = context
      this.source = source
      this.worklet = worklet
      this.silentGain = silentGain
      this.workletRevoke = workletUrl.revoke
    } catch (error) {
      workletUrl.revoke()
      for (const track of media.getTracks()) track.stop()
      await context.close()
      throw error
    }
  }

  private async stopCapture(): Promise<void> {
    const { worklet, source, silentGain, media, audioContext: context } = this
    const revoke = this.workletRevoke
    this.worklet = undefined
    this.source = undefined
    this.silentGain = undefined
    this.media = undefined
    this.audioContext = undefined
    this.workletRevoke = undefined
    try { worklet?.port.close() } catch { /* Only browser cleanup failure is contained. */ }
    try { source?.disconnect() } catch { /* Only browser cleanup failure is contained. */ }
    try { worklet?.disconnect() } catch { /* Only browser cleanup failure is contained. */ }
    try { silentGain?.disconnect() } catch { /* Only browser cleanup failure is contained. */ }
    for (const track of media?.getTracks() ?? []) {
      try { track.stop() } catch { /* Only browser cleanup failure is contained. */ }
    }
    try { revoke?.() } catch { /* Only browser cleanup failure is contained. */ }
    try {
      if (context !== undefined && context.state !== 'closed') await context.close()
    } catch { /* Only browser cleanup failure is contained. */ }
    this.coordinator.release(this)
  }
}
