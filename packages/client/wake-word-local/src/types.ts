/** Literal keyword recognized by the calibrated matcher. */
export type WakeKeyword = 'БРО'

/** PCM accepted by feed and calibration operations. */
export type MonoPcm = Float32Array | Int16Array

/** Current calibration transaction summary. */
export interface WakeWordCalibrationState {
  /** Whether a calibration transaction is accepting samples. */
  readonly active: boolean
  /** Valid derived samples staged in the current transaction. */
  readonly sampleCount: number
  /** Samples required before the transaction can be committed. */
  readonly requiredSamples: number
}

/** Observable matcher state. */
export interface WakeWordState {
  /** The only keyword this implementation can calibrate. */
  readonly keyword: WakeKeyword
  /** Whether inference frames are accepted. */
  readonly enabled: boolean
  /** Whether the Worker acknowledged initialization. */
  readonly workerReady: boolean
  /** Whether enough speaker templates exist for inference. */
  readonly ready: boolean
  /** Number of committed derived feature templates. */
  readonly templateCount: number
  /** Current calibration transaction. */
  readonly calibration: WakeWordCalibrationState
  /** Latest storage or Worker failure, absent in normal operation. */
  readonly error?: string
}

/** One local speaker-template match. */
export interface WakeWordDetection {
  /** The matched literal keyword. */
  readonly keyword: WakeKeyword
  /** Normalized DTW distance; lower values are closer to calibration. */
  readonly score: number
  /** Duration of the VAD-delimited candidate utterance. */
  readonly durationMs: number
  /** Main-thread receipt time from `Date.now()`. */
  readonly detectedAt: number
}

/** Public `ctx.wakeWord` API. */
export interface WakeWordServiceContract {
  /** @returns the stable current state snapshot. */
  getState(): WakeWordState
  /**
   * Subscribe to state replacement.
   * @param listener - notified after the state changes.
   * @returns an idempotent unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /**
   * Subscribe to detections.
   * @param listener - receives local detections after threshold and cooldown checks.
   * @returns an idempotent unsubscribe function.
   */
  onDetection(listener: (detection: WakeWordDetection) => void): () => void
  /**
   * Feed one bounded mono PCM frame to Worker inference.
   * @param pcm - normalized float PCM or signed 16-bit PCM; the caller's buffer is not detached.
   * @param sampleRate - source rate from 8 kHz through 48 kHz.
   */
  feed(pcm: MonoPcm, sampleRate: number): void
  /** Start a transaction that replaces committed templates on commit. */
  beginCalibration(): void
  /**
   * Derive and stage one complete spoken sample without retaining its PCM.
   * @param pcm - one isolated pronunciation with optional leading or trailing silence.
   * @param sampleRate - source rate from 8 kHz through 48 kHz.
   * @returns the staged derived-sample count.
   */
  addCalibrationSample(pcm: MonoPcm, sampleRate: number): Promise<number>
  /**
   * Replace committed templates with the staged derived templates.
   * @returns the committed template count.
   */
  commitCalibration(): Promise<number>
  /**
   * Enable or disable inference. Calibration remains available while disabled.
   * @param enabled - desired inference state.
   */
  setEnabled(enabled: boolean): void
  /** Terminate the Worker, reject pending calibration calls, and clear listeners. */
  dispose(): void
}
