// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { VoiceControl, VoiceStatus } from '../src/client/components.tsx'
import type { VoiceControlProps, VoiceStatusProps } from '../src/client/components.tsx'
import type { VoiceSnapshot } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}
const idle: VoiceSnapshot = {
  phase: 'idle',
  handsFree: false,
  wakeReadiness: 'calibration-required',
  calibration: { active: false, recording: false, sampleCount: 0, requiredSamples: 3, pending: false },
  transcript: '',
  sawToolResponse: false,
  cost: {
    currentRequest: {
      audioNanoUsd: 0, textNanoUsd: 0, cachedInputNanoUsd: 0, transcriptionNanoUsd: 0, totalNanoUsd: 0,
    },
    sessionTotal: {
      audioNanoUsd: 0, textNanoUsd: 0, cachedInputNanoUsd: 0, transcriptionNanoUsd: 0, totalNanoUsd: 0,
    },
    currentRequestReported: false,
    sessionReported: false,
  },
  errorCode: undefined,
}

function props(snapshot: VoiceSnapshot) {
  return {
    sessionId: 's1',
    session: {},
    input: {},
    useSession: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
    useVoice: (selector: (value: VoiceSnapshot) => unknown) => selector(snapshot),
    useStore: (selector: (value: { handsFreeEnabled: boolean; wakeReadiness: VoiceSnapshot['wakeReadiness'] }) => unknown) =>
      selector({ handsFreeEnabled: false, wakeReadiness: snapshot.wakeReadiness }),
    actions: { setHandsFreeEnabled: vi.fn(), setWakeReadiness: vi.fn() },
    beginPushToTalk: vi.fn().mockResolvedValue(undefined),
    endPushToTalk: vi.fn(),
    setHandsFree: vi.fn().mockResolvedValue(undefined),
    startCalibration: vi.fn().mockResolvedValue(undefined),
    beginCalibrationSample: vi.fn().mockResolvedValue(undefined),
    endCalibrationSample: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    t,
  }
}

describe('voice components', () => {
  it('maps pointerdown and pointerup to the PTT lifecycle', () => {
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    })
    const p = props(idle)
    render(<VoiceControl {...p as unknown as VoiceControlProps} />)
    const button = screen.getByRole('button', { name: '按住说话' })
    fireEvent.pointerDown(button, { button: 0, pointerId: 3 })
    fireEvent.pointerUp(button, { button: 0, pointerId: 3 })
    expect(p.beginPushToTalk).toHaveBeenCalledTimes(1)
    expect(p.endPushToTalk).toHaveBeenCalledTimes(1)
  })

  it('commits PTT on pointer cancellation', () => {
    const p = props({ ...idle, phase: 'listening' })
    render(<VoiceControl {...p as unknown as VoiceControlProps} />)
    fireEvent.pointerCancel(screen.getByRole('button', { name: '松开发送' }))
    expect(p.endPushToTalk).toHaveBeenCalledTimes(1)
  })

  it('keeps push-to-talk enabled as a barge-in action during spoken output', () => {
    const p = props({ ...idle, phase: 'speaking', transcript: '正在回答' })
    render(<VoiceControl {...p as unknown as VoiceControlProps} />)
    const button = screen.getByRole('button', { name: '按住并打断回答' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.pointerDown(button, { button: 0, pointerId: 4 })
    expect(p.beginPushToTalk).toHaveBeenCalledTimes(1)
  })

  it('shows calibration-required state without claiming universal wake readiness', () => {
    const p = props({ ...idle, handsFree: true })
    render(<VoiceStatus {...p as unknown as VoiceStatusProps} />)
    expect(screen.getByText('唤醒词需要校准')).toBeTruthy()
  })

  it('starts calibration and records an isolated БРО sample with pointer hold', () => {
    const start = props(idle)
    const view = render(<VoiceStatus {...start as unknown as VoiceStatusProps} />)
    fireEvent.click(screen.getByRole('button', { name: '校准 БРО' }))
    expect(start.startCalibration).toHaveBeenCalledTimes(1)

    const recording = props({ ...idle, calibration: { ...idle.calibration, active: true } })
    view.rerender(<VoiceStatus {...recording as unknown as VoiceStatusProps} />)
    const sample = screen.getByRole('button', { name: '按住并说 БРО' })
    fireEvent.pointerDown(sample, { button: 0, pointerId: 7 })
    fireEvent.pointerUp(sample, { button: 0, pointerId: 7 })
    expect(recording.beginCalibrationSample).toHaveBeenCalledTimes(1)
    expect(recording.endCalibrationSample).toHaveBeenCalledTimes(1)
  })

  it('keeps compact request and session cost visible while idle', () => {
    const p = props({
      ...idle,
      wakeReadiness: 'ready',
      cost: {
        currentRequest: {
          audioNanoUsd: 3_840_000,
          textNanoUsd: 1_040_000,
          cachedInputNanoUsd: 12_000,
          transcriptionNanoUsd: 200_000,
          totalNanoUsd: 5_092_000,
        },
        sessionTotal: {
          audioNanoUsd: 3_840_000,
          textNanoUsd: 1_040_000,
          cachedInputNanoUsd: 12_000,
          transcriptionNanoUsd: 200_000,
          totalNanoUsd: 5_092_000,
        },
        currentRequestReported: true,
        sessionReported: true,
      },
    })
    render(<VoiceStatus {...p as unknown as VoiceStatusProps} />)
    const cost = screen.getByText('本次 $0.005092 · 会话 $0.005092')
    expect(cost.getAttribute('title')).toBe('音频 $0.00384 · 文本 $0.00104 · 缓存输入 $0.000012 · 转录 $0.0002')
    expect(screen.getByText('语音就绪')).toBeTruthy()
  })

  it('shows generic response failure and never provider text', () => {
    const p = props({ ...idle, phase: 'error', errorCode: 'response', transcript: '' })
    render(<VoiceStatus {...p as unknown as VoiceStatusProps} />)
    expect(screen.getByText('语音回答失败')).toBeTruthy()
  })
})
