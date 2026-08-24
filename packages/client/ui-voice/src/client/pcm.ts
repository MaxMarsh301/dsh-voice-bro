/** Target sample rate required by the Host voice session. */
export const VOICE_SAMPLE_RATE = 24_000

/**
 * Convert normalized mono samples to signed PCM16 little-endian bytes.
 * @param samples - normalized mono samples.
 * @returns little-endian PCM16 bytes.
 */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true)
  }
  return bytes
}

/** Stateful linear mono resampler that preserves phase between worklet chunks. */
export class PcmResampler {
  private position = 0
  private previous: number | undefined

  /**
   * Create a stream resampler.
   * @param inputRate - AudioContext sample rate.
   * @param outputRate - voice protocol sample rate.
   */
  constructor(
    readonly inputRate: number,
    readonly outputRate = VOICE_SAMPLE_RATE,
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError('sample rates must be positive')
  }

  /**
   * Resample one contiguous mono chunk and encode it as PCM16 LE.
   * @param input - next contiguous mono chunk.
   * @returns resampled PCM16 bytes.
   */
  push(input: Float32Array): Uint8Array {
    if (input.length === 0) return new Uint8Array()
    const source = this.previous === undefined
      ? input
      : Float32Array.from([this.previous, ...input])
    const step = this.inputRate / this.outputRate
    const output: number[] = []
    let position = this.position
    while (position < source.length - 1) {
      const left = Math.floor(position)
      const fraction = position - left
      const a = source[left] ?? 0
      const b = source[left + 1] ?? a
      output.push(a + ((b - a) * fraction))
      position += step
    }
    this.position = position - (source.length - 1)
    this.previous = source[source.length - 1]
    return floatToPcm16(Float32Array.from(output))
  }
}

/**
 * Encode bytes for the Realtime input_audio_buffer append event.
 * @param bytes - PCM16 bytes.
 * @returns base64 text without data-URL decoration.
 */
export function pcmBase64(bytes: Uint8Array): string {
  let binary = ''
  const stride = 0x8000
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride))
  }
  return btoa(binary)
}

/**
 * Calculate normalized root-mean-square energy for local phrase VAD.
 * @param samples - normalized mono samples.
 * @returns RMS energy in [0, 1].
 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}
