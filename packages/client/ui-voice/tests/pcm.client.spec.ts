import { describe, expect, it } from 'vitest'
import { PcmResampler, floatToPcm16, rms } from '../src/client/pcm.ts'

describe('voice PCM', () => {
  it('encodes clipped signed PCM16 little-endian', () => {
    const bytes = floatToPcm16(Float32Array.from([-2, -1, 0, 0.5, 1, 2]))
    const values = new Int16Array(bytes.buffer)
    expect([...values]).toEqual([-32768, -32768, 0, 16384, 32767, 32767])
  })

  it('resamples 48 kHz mono to 24 kHz across chunk boundaries', () => {
    const one = new PcmResampler(48_000)
    const together = one.push(Float32Array.from([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]))
    const split = new PcmResampler(48_000)
    const first = split.push(Float32Array.from([0, 0.25, 0.5, 0.75]))
    const second = split.push(Float32Array.from([1, 0.75, 0.5, 0.25]))
    expect([...first, ...second]).toEqual([...together])
  })

  it('reports normalized RMS for local VAD', () => {
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1)
    expect(rms(new Float32Array())).toBe(0)
  })
})
