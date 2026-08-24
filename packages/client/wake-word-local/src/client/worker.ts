import type { WakeKeyword } from '../types.ts'

/** Configuration copied into the isolated matcher Worker. */
export interface WorkerMatcherConfig {
  readonly threshold: number
  readonly vadRms: number
  readonly cooldownMs: number
  readonly minTemplates: number
  readonly maxTemplates: number
  readonly minSampleMs: number
  readonly maxSampleMs: number
}

/** JSON-safe derived template persisted by the main thread. */
export type DerivedTemplate = number[][]

/** Messages accepted by the inline Worker. */
export type WorkerRequest =
  | { type: 'init'; config: WorkerMatcherConfig; templates: DerivedTemplate[] }
  | { type: 'enabled'; enabled: boolean }
  | { type: 'feed'; pcm: Float32Array | Int16Array; sampleRate: number }
  | { type: 'beginCalibration' }
  | { type: 'addCalibration'; id: number; pcm: Float32Array | Int16Array; sampleRate: number }
  | { type: 'commitCalibration'; id: number }
  | { type: 'dispose' }

/** Messages emitted by the inline Worker. */
export type WorkerResponse =
  | { type: 'ready'; templateCount: number }
  | { type: 'calibrationStaged'; id: number; sampleCount: number }
  | { type: 'calibrationCommitted'; id: number; templates: DerivedTemplate[] }
  | { type: 'detected'; keyword: WakeKeyword; score: number; durationMs: number }
  | { type: 'requestError'; id: number; message: string }
  | { type: 'workerError'; message: string }

/** Minimal Worker-global interface used by tests and the blob entry. */
export interface MatcherWorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse): void
  close(): void
}

/**
 * Install the complete streaming matcher in a Worker-like scope.
 * @param scope - isolated message endpoint.
 */
export function installMatcherWorker(scope: MatcherWorkerScope): void {
  const KEYWORD: WakeKeyword = 'БРО'
  const TARGET_RATE = 16_000
  const VAD_BLOCK = 160
  const FRAME_SIZE = 400
  const FRAME_HOP = 160
  const FFT_SIZE = 512
  const FILTERS = 16
  const COEFFICIENTS = 8
  const MAX_PERSISTED_FRAMES = 220

  let config: WorkerMatcherConfig | undefined
  let templates: DerivedTemplate[] = []
  let staged: DerivedTemplate[] | undefined
  let enabled = true
  let disposed = false
  let stream = new Float32Array(0)
  let active: number[] = []
  let preRoll: Float32Array[] = []
  let speechBlocks = 0
  let silentBlocks = 0
  let lastDetection = Number.NEGATIVE_INFINITY

  const fail = (message: string): never => { throw new Error(message) }

  const ensureConfig = (): WorkerMatcherConfig => config ?? fail('matcher is not initialized')

  const finitePcm = (pcm: Float32Array | Int16Array): Float32Array => {
    const output = new Float32Array(pcm.length)
    if (pcm instanceof Int16Array) {
      for (let index = 0; index < pcm.length; index += 1) output[index] = pcm[index]! / 32_768
      return output
    }
    for (let index = 0; index < pcm.length; index += 1) {
      const value = pcm[index]!
      if (!Number.isFinite(value)) fail('PCM contains a non-finite sample')
      output[index] = Math.max(-1, Math.min(1, value))
    }
    return output
  }

  const resample = (pcm: Float32Array | Int16Array, sampleRate: number): Float32Array => {
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
      fail('sampleRate must be an integer from 8000 through 48000')
    }
    const input = finitePcm(pcm)
    if (sampleRate === TARGET_RATE || input.length === 0) return input
    const length = Math.max(1, Math.round(input.length * TARGET_RATE / sampleRate))
    const output = new Float32Array(length)
    const scale = sampleRate / TARGET_RATE
    for (let index = 0; index < length; index += 1) {
      const position = index * scale
      const left = Math.min(input.length - 1, Math.floor(position))
      const right = Math.min(input.length - 1, left + 1)
      const mix = position - left
      output[index] = input[left]! * (1 - mix) + input[right]! * mix
    }
    return output
  }

  const rms = (pcm: ArrayLike<number>, from = 0, to = pcm.length): number => {
    let sum = 0
    for (let index = from; index < to; index += 1) sum += pcm[index]! * pcm[index]!
    return Math.sqrt(sum / Math.max(1, to - from))
  }

  const trimVoice = (pcm: Float32Array): Float32Array => {
    const cfg = ensureConfig()
    const gate = cfg.vadRms * 0.65
    let first = -1
    let last = -1
    for (let from = 0; from + VAD_BLOCK <= pcm.length; from += VAD_BLOCK) {
      if (rms(pcm, from, from + VAD_BLOCK) >= gate) {
        if (first < 0) first = from
        last = from + VAD_BLOCK
      }
    }
    if (first < 0) fail('calibration sample contains no speech above the VAD gate')
    const padding = VAD_BLOCK * 3
    return pcm.slice(Math.max(0, first - padding), Math.min(pcm.length, last + padding))
  }

  const fftPower = (frame: Float32Array): Float64Array => {
    const real = new Float64Array(FFT_SIZE)
    const imaginary = new Float64Array(FFT_SIZE)
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * index / (FRAME_SIZE - 1))
      const sample = frame[index]! - (index === 0 ? 0 : 0.97 * frame[index - 1]!)
      real[index] = sample * window
    }
    for (let index = 1, reverse = 0; index < FFT_SIZE; index += 1) {
      let bit = FFT_SIZE >> 1
      for (; (reverse & bit) !== 0; bit >>= 1) reverse ^= bit
      reverse ^= bit
      if (index < reverse) {
        const swapReal = real[index]!
        const swapImaginary = imaginary[index]!
        real[index] = real[reverse]!
        imaginary[index] = imaginary[reverse]!
        real[reverse] = swapReal
        imaginary[reverse] = swapImaginary
      }
    }
    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
      const angle = -2 * Math.PI / size
      const stepReal = Math.cos(angle)
      const stepImaginary = Math.sin(angle)
      for (let start = 0; start < FFT_SIZE; start += size) {
        let twiddleReal = 1
        let twiddleImaginary = 0
        for (let offset = 0; offset < size / 2; offset += 1) {
          const even = start + offset
          const odd = even + size / 2
          const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary
          const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal
          real[odd] = real[even]! - oddReal
          imaginary[odd] = imaginary[even]! - oddImaginary
          real[even] = real[even]! + oddReal
          imaginary[even] = imaginary[even]! + oddImaginary
          const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary
          twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal
          twiddleReal = nextReal
        }
      }
    }
    const power = new Float64Array(FFT_SIZE / 2 + 1)
    for (let index = 0; index < power.length; index += 1) {
      power[index] = real[index]! * real[index]! + imaginary[index]! * imaginary[index]!
    }
    return power
  }

  const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700)
  const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1)

  const frameFeature = (frame: Float32Array): number[] => {
    const power = fftPower(frame)
    const lowMel = hzToMel(100)
    const highMel = hzToMel(7_600)
    const bins: number[] = []
    for (let index = 0; index < FILTERS + 2; index += 1) {
      const mel = lowMel + (highMel - lowMel) * index / (FILTERS + 1)
      bins.push(Math.max(0, Math.min(power.length - 1, Math.floor((FFT_SIZE + 1) * melToHz(mel) / TARGET_RATE))))
    }
    const logs = new Float64Array(FILTERS)
    for (let filter = 0; filter < FILTERS; filter += 1) {
      const left = bins[filter]!
      const center = Math.max(left + 1, bins[filter + 1]!)
      const right = Math.max(center + 1, bins[filter + 2]!)
      let energy = 0
      for (let bin = left; bin < center && bin < power.length; bin += 1) {
        energy += power[bin]! * (bin - left) / (center - left)
      }
      for (let bin = center; bin < right && bin < power.length; bin += 1) {
        energy += power[bin]! * (right - bin) / (right - center)
      }
      logs[filter] = Math.log(energy + 1e-10)
    }
    const feature = new Array<number>(COEFFICIENTS)
    for (let coefficient = 1; coefficient <= COEFFICIENTS; coefficient += 1) {
      let value = 0
      for (let filter = 0; filter < FILTERS; filter += 1) {
        value += logs[filter]! * Math.cos(Math.PI * coefficient * (filter + 0.5) / FILTERS)
      }
      feature[coefficient - 1] = value
    }
    let norm = 0
    for (const value of feature) norm += value * value
    norm = Math.sqrt(norm) || 1
    return feature.map(value => Math.round(value / norm * 100_000) / 100_000)
  }

  const derive = (input: Float32Array | Int16Array, sampleRate: number): DerivedTemplate => {
    const cfg = ensureConfig()
    const pcm = trimVoice(resample(input, sampleRate))
    const durationMs = pcm.length / TARGET_RATE * 1_000
    if (durationMs < cfg.minSampleMs || durationMs > cfg.maxSampleMs) {
      fail(`spoken sample must be ${cfg.minSampleMs}-${cfg.maxSampleMs} ms after VAD trimming`)
    }
    const result: DerivedTemplate = []
    for (let from = 0; from + FRAME_SIZE <= pcm.length; from += FRAME_HOP) {
      result.push(frameFeature(pcm.subarray(from, from + FRAME_SIZE)))
    }
    if (result.length < 3 || result.length > MAX_PERSISTED_FRAMES) fail('spoken sample produced an unsupported feature length')
    return result
  }

  const distance = (left: readonly number[], right: readonly number[]): number => {
    let dot = 0
    let leftNorm = 0
    let rightNorm = 0
    for (let index = 0; index < COEFFICIENTS; index += 1) {
      dot += left[index]! * right[index]!
      leftNorm += left[index]! * left[index]!
      rightNorm += right[index]! * right[index]!
    }
    return 1 - dot / Math.max(1e-9, Math.sqrt(leftNorm * rightNorm))
  }

  const dtw = (candidate: DerivedTemplate, template: DerivedTemplate): number => {
    const ratio = candidate.length / template.length
    if (ratio < 0.55 || ratio > 1.8) return Number.POSITIVE_INFINITY
    const width = Math.max(3, Math.ceil(Math.max(candidate.length, template.length) * 0.35))
    let previous = new Float64Array(template.length + 1).fill(Number.POSITIVE_INFINITY)
    previous[0] = 0
    for (let row = 1; row <= candidate.length; row += 1) {
      const current = new Float64Array(template.length + 1).fill(Number.POSITIVE_INFINITY)
      const expected = row * template.length / candidate.length
      const start = Math.max(1, Math.floor(expected - width))
      const end = Math.min(template.length, Math.ceil(expected + width))
      for (let column = start; column <= end; column += 1) {
        current[column] = distance(candidate[row - 1]!, template[column - 1]!)
          + Math.min(previous[column]!, current[column - 1]!, previous[column - 1]!)
      }
      previous = current
    }
    return previous[template.length]! / (candidate.length + template.length)
  }

  const publishMatch = (candidate: DerivedTemplate, template: DerivedTemplate, durationMs: number): boolean => {
    const cfg = ensureConfig()
    const score = dtw(candidate, template)
    if (score > cfg.threshold) return false
    const now = Date.now()
    if (now - lastDetection >= cfg.cooldownMs) {
      lastDetection = now
      scope.postMessage({ type: 'detected', keyword: KEYWORD, score, durationMs })
    }
    return true
  }

  const matchCompleteCandidate = (pcm: Float32Array): boolean => {
    const cfg = ensureConfig()
    if (!enabled || templates.length < cfg.minTemplates) return false
    try {
      const candidate = derive(pcm, TARGET_RATE)
      for (const template of templates) {
        if (publishMatch(candidate, template, pcm.length / TARGET_RATE * 1_000)) return true
      }
    } catch {
      // Streaming candidates outside configured duration or VAD bounds are ordinary non-matches.
    }
    return false
  }

  const resetCandidate = (): void => {
    active = []
    preRoll = []
    speechBlocks = 0
    silentBlocks = 0
  }

  const finalizeCandidate = (): void => {
    matchCompleteCandidate(Float32Array.from(active))
    resetCandidate()
  }

  const matchStreamingWindow = (): boolean => {
    const cfg = ensureConfig()
    if (!enabled || templates.length < cfg.minTemplates) return false
    const samples = Float32Array.from(active)
    for (const template of templates) {
      const expectedSamples = (template.length - 1) * FRAME_HOP + FRAME_SIZE
      const windowSamples = Math.min(samples.length, expectedSamples + VAD_BLOCK * 3)
      const window = samples.subarray(samples.length - windowSamples)
      const durationMs = window.length / TARGET_RATE * 1_000
      if (durationMs < cfg.minSampleMs || durationMs > cfg.maxSampleMs) continue
      try {
        const candidate = derive(window, TARGET_RATE)
        if (publishMatch(candidate, template, durationMs)) return true
      } catch {
        // A bounded streaming window may not yet contain enough voiced material.
      }
    }
    return false
  }

  const consumeStream = (pcm: Float32Array): void => {
    const cfg = ensureConfig()
    const merged = new Float32Array(stream.length + pcm.length)
    merged.set(stream)
    merged.set(pcm, stream.length)
    let offset = 0
    while (offset + VAD_BLOCK <= merged.length) {
      const block = merged.slice(offset, offset + VAD_BLOCK)
      offset += VAD_BLOCK
      const voice = rms(block) >= cfg.vadRms
      if (active.length === 0) {
        preRoll.push(block)
        if (preRoll.length > 3) preRoll.shift()
        speechBlocks = voice ? speechBlocks + 1 : 0
        if (speechBlocks >= 2) {
          for (const retained of preRoll) active.push(...retained)
          preRoll = []
        }
        continue
      }
      active.push(...block)
      silentBlocks = voice ? 0 : silentBlocks + 1
      const atStreamingCadence = voice && (active.length / VAD_BLOCK) % 4 === 0
      if (atStreamingCadence && matchStreamingWindow()) {
        resetCandidate()
        continue
      }
      if (silentBlocks >= 12 || active.length >= cfg.maxSampleMs * TARGET_RATE / 1_000) finalizeCandidate()
    }
    stream = merged.slice(offset)
  }

  const validTemplate = (template: DerivedTemplate): boolean =>
    Array.isArray(template)
    && template.length >= 3
    && template.length <= MAX_PERSISTED_FRAMES
    && template.every(frame => Array.isArray(frame)
      && frame.length === COEFFICIENTS
      && frame.every(value => Number.isFinite(value) && Math.abs(value) <= 2))

  scope.onmessage = (event): void => {
    if (disposed) return
    const message = event.data
    try {
      switch (message.type) {
        case 'init': {
          config = message.config
          templates = message.templates.filter(validTemplate).slice(0, config.maxTemplates)
          scope.postMessage({ type: 'ready', templateCount: templates.length })
          break
        }
        case 'enabled':
          enabled = message.enabled
          if (!enabled) {
            stream = new Float32Array(0)
            active = []
            preRoll = []
          }
          break
        case 'feed':
          if (enabled) consumeStream(resample(message.pcm, message.sampleRate))
          break
        case 'beginCalibration':
          staged = []
          break
        case 'addCalibration': {
          const transaction = staged ?? fail('beginCalibration must be called first')
          const cfg = ensureConfig()
          if (transaction.length >= cfg.maxTemplates) fail(`calibration accepts at most ${cfg.maxTemplates} samples`)
          transaction.push(derive(message.pcm, message.sampleRate))
          scope.postMessage({ type: 'calibrationStaged', id: message.id, sampleCount: transaction.length })
          break
        }
        case 'commitCalibration': {
          const cfg = ensureConfig()
          const transaction = staged ?? fail('beginCalibration must be called first')
          if (transaction.length < cfg.minTemplates) fail(`calibration requires at least ${cfg.minTemplates} samples`)
          templates = transaction
          staged = undefined
          scope.postMessage({ type: 'calibrationCommitted', id: message.id, templates })
          break
        }
        case 'dispose':
          disposed = true
          stream = new Float32Array(0)
          active = []
          preRoll = []
          templates = []
          staged = undefined
          scope.close()
          break
        default:
          /* v8 ignore next -- closed worker protocol is exhaustively produced by the typed main thread. */
          fail('unknown Worker message')
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if ('id' in message && typeof message.id === 'number') scope.postMessage({ type: 'requestError', id: message.id, message: text })
      else scope.postMessage({ type: 'workerError', message: text })
    }
  }
}

/**
 * Serialize the matcher installer without external runtime references.
 * @returns self-contained JavaScript for an inline blob Worker.
 */
export function createMatcherWorkerSource(): string {
  return `(${installMatcherWorker.toString()})(self);`
}
