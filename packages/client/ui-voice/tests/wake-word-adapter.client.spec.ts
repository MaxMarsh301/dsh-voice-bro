import { describe, expect, it, vi } from 'vitest'
import type { WakeWordServiceContract, WakeWordState } from '@deepseek-ai/dsh-client-wake-word-local/client'
import { wakeReadiness, wakeWordFrom } from '../src/client/wake-word-adapter.ts'

function state(ready = false): WakeWordState {
  return {
    keyword: 'БРО', enabled: false, workerReady: true, ready, templateCount: ready ? 3 : 0,
    calibration: { active: false, sampleCount: 0, requiredSamples: 3 },
  }
}

describe('wake-word adapter', () => {
  it('uses the provider API without taking provider disposal ownership', async () => {
    const service = {
      getState: vi.fn(() => state()),
      subscribe: vi.fn(() => vi.fn()),
      onDetection: vi.fn(() => vi.fn()),
      feed: vi.fn(),
      beginCalibration: vi.fn(),
      addCalibrationSample: vi.fn(async () => 1),
      commitCalibration: vi.fn(async () => 3),
      setEnabled: vi.fn(),
      dispose: vi.fn(),
    } satisfies WakeWordServiceContract
    const wake = wakeWordFrom(service)
    const pcm = Float32Array.from([0, 0.5, 0])
    wake.feed(pcm, 48_000)
    wake.beginCalibration()
    await wake.addCalibrationSample(pcm, 48_000)
    await wake.commitCalibration()
    wake.setEnabled(true)

    expect(service.feed).toHaveBeenCalledWith(pcm, 48_000)
    expect(service.addCalibrationSample).toHaveBeenCalledWith(pcm, 48_000)
    expect(service.setEnabled).toHaveBeenCalledWith(true)
    expect(service.dispose).not.toHaveBeenCalled()
  })

  it('reports calibration required rather than universal readiness', () => {
    expect(wakeReadiness(state(false))).toBe('calibration-required')
    expect(wakeReadiness(state(true))).toBe('ready')
  })
})
