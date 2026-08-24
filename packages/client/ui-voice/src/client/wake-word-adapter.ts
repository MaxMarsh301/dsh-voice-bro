import type {
  MonoPcm, WakeWordDetection, WakeWordServiceContract, WakeWordState,
} from '@deepseek-ai/dsh-client-wake-word-local/client'

/** Wake-word readiness rendered by the voice surface. */
export type WakeReadiness = 'calibration-required' | 'ready'

/** Stable consumer port over the provider-owned wake service. */
export interface WakeWordPort {
  getState(): WakeWordState
  subscribe(listener: () => void): () => void
  onDetection(listener: (detection: WakeWordDetection) => void): () => void
  feed(pcm: MonoPcm, sampleRate: number): void
  beginCalibration(): void
  addCalibrationSample(pcm: MonoPcm, sampleRate: number): Promise<number>
  commitCalibration(): Promise<number>
  setEnabled(enabled: boolean): void
}

/**
 * Narrow the provider-owned service to the operations used by this package.
 * The adapter never exposes or calls `dispose`; Cordis owns provider lifetime.
 * @param service - injected local wake-word service.
 * @returns consumer-owned subscriptions and operation face.
 */
export function wakeWordFrom(service: WakeWordServiceContract): WakeWordPort {
  return {
    getState: () => service.getState(),
    subscribe: listener => service.subscribe(listener),
    onDetection: listener => service.onDetection(listener),
    feed: (pcm, sampleRate) => { service.feed(pcm, sampleRate) },
    beginCalibration: () => { service.beginCalibration() },
    addCalibrationSample: (pcm, sampleRate) => service.addCalibrationSample(pcm, sampleRate),
    commitCalibration: () => service.commitCalibration(),
    setEnabled: enabled => { service.setEnabled(enabled) },
  }
}

/** @returns the UI readiness represented by a provider state. */
export function wakeReadiness(state: WakeWordState): WakeReadiness {
  return state.ready && state.workerReady ? 'ready' : 'calibration-required'
}
