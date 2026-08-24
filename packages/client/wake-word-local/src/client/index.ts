/** Browser-only local wake-word service and its consumer-facing types. */
import type {} from '@deepseek-ai/cordis'
import { WakeWordService } from './service.ts'

export { WakeWordService as default }
export type { Config } from './service.ts'
export type {
  MonoPcm,
  WakeKeyword,
  WakeWordCalibrationState,
  WakeWordDetection,
  WakeWordServiceContract,
  WakeWordState,
} from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser-only speaker-calibrated matcher for the literal keyword `БРО`. */
    wakeWord: import('../types.ts').WakeWordServiceContract
  }
}
