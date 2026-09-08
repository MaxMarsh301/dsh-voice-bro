// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { VoiceControl, VoiceOverlay, VoiceSidebarLauncher } from '../src/client/components.tsx'
import type { VoiceControlProps, VoiceOverlayProps, VoiceSidebarLauncherProps } from '../src/client/components.tsx'
import { VoiceSettingsSection, type VoiceSettingsSectionProps } from '../src/client/VoiceSettingsSection.tsx'
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
  activity: { steps: [], plannedText: '', finalText: '' },
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
  wakeSignalEnabled: true,
  errorCode: undefined,
}

function props(snapshot: VoiceSnapshot, overlayDisclosure: 'auto' | 'collapsed' | 'expanded' = 'auto') {
  return {
    wide: true,
    sessionId: 's1',
    session: {},
    input: {},
    useSession: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
    useVoice: (selector: (value: VoiceSnapshot) => unknown) => selector(snapshot),
    useVoiceWindow: (selector: (value: { disclosure: 'auto' | 'collapsed' | 'expanded' }) => unknown) => selector({ disclosure: overlayDisclosure }),
    useStore: (selector: (value: {
      handsFreeEnabled: boolean
      wakeReadiness: VoiceSnapshot['wakeReadiness']
      overlayDisclosure: 'auto' | 'collapsed' | 'expanded'
    }) => unknown) => selector({
      handsFreeEnabled: false,
      wakeReadiness: snapshot.wakeReadiness,
      overlayDisclosure,
    }),
    actions: { setHandsFreeEnabled: vi.fn(), setWakeReadiness: vi.fn(), setOverlayDisclosure: vi.fn() },
    setOverlayDisclosure: vi.fn(),
    beginPushToTalk: vi.fn().mockResolvedValue(undefined),
    endPushToTalk: vi.fn(),
    setHandsFree: vi.fn().mockResolvedValue(undefined),
    setWakeSignalEnabled: vi.fn(),
    startCalibration: vi.fn().mockResolvedValue(undefined),
    beginCalibrationSample: vi.fn().mockResolvedValue(undefined),
    endCalibrationSample: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    t,
  }
}

function settingsProps(snapshot: VoiceSnapshot) {
  const calibration = {
    wakeReadiness: snapshot.wakeReadiness,
    calibration: snapshot.calibration,
    error: snapshot.errorCode === 'calibration',
  }
  return {
    close: vi.fn(),
    useSession: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
    useCalibration: (selector: (value: typeof calibration) => unknown) => selector(calibration),
    useVoice: (selector: (value: VoiceSnapshot) => unknown) => selector(snapshot),
    startCalibration: vi.fn().mockResolvedValue(undefined),
    beginCalibrationSample: vi.fn().mockResolvedValue(undefined),
    endCalibrationSample: vi.fn().mockResolvedValue(undefined),
    setWakeSignalEnabled: vi.fn(),
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

  it('keeps idle voice compact in the sidebar and opens the floating window on click', () => {
    const p = props(idle)
    const view = render(<VoiceSidebarLauncher {...p as unknown as VoiceSidebarLauncherProps} />)
    const launcher = screen.getByRole('button', { name: '展开语音控制' })
    expect(launcher.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('全局语音')).toBeTruthy()
    expect(screen.getByText('唤醒词需要校准')).toBeTruthy()
    fireEvent.click(launcher)
    expect(p.setOverlayDisclosure).toHaveBeenCalledWith('expanded')

    view.rerender(<VoiceOverlay {...props(idle, 'expanded') as unknown as VoiceOverlayProps} />)
    expect(screen.getByRole('region', { name: '语音控制' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '按住说话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '开启免手持' })).toBeTruthy()
  })

  it('keeps the sidebar launcher compact in the collapsed rail', () => {
    const p = props(idle)
    p.wide = false
    render(<VoiceSidebarLauncher {...p as unknown as VoiceSidebarLauncherProps} />)
    expect(screen.getByRole('button', { name: '展开语音控制' })).toBeTruthy()
    expect(screen.queryByText('全局语音')).toBeNull()
  })

  it('shows calibration-required state without claiming universal wake readiness', () => {
    render(<VoiceOverlay {...props({ ...idle, handsFree: true }, 'expanded') as unknown as VoiceOverlayProps} />)
    expect(screen.getByText('唤醒词需要校准')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '校准 БРО' })).toBeNull()
  })

  it('starts calibration and records an isolated БРО sample in Settings', () => {
    const start = settingsProps(idle)
    const view = render(<VoiceSettingsSection {...start as unknown as VoiceSettingsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: '校准 БРО' }))
    expect(start.startCalibration).toHaveBeenCalledTimes(1)

    const recording = settingsProps({ ...idle, calibration: { ...idle.calibration, active: true } })
    view.rerender(<VoiceSettingsSection {...recording as unknown as VoiceSettingsSectionProps} />)
    const sample = screen.getByRole('button', { name: '按住并说 БРО' })
    fireEvent.pointerDown(sample, { button: 0, pointerId: 7 })
    fireEvent.pointerUp(sample, { button: 0, pointerId: 7 })
    expect(recording.beginCalibrationSample).toHaveBeenCalledTimes(1)
    expect(recording.endCalibrationSample).toHaveBeenCalledTimes(1)
  })

  it('toggles the wake confirmation sound independently in Settings', () => {
    const p = settingsProps(idle)
    render(<VoiceSettingsSection {...p as unknown as VoiceSettingsSectionProps} />)
    const toggle = screen.getByRole('checkbox', { name: '播放提示音' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(p.setWakeSignalEnabled).toHaveBeenCalledWith(false)
  })

  it('offers recalibration for a ready matcher only in Settings', () => {
    const ready = settingsProps({ ...idle, wakeReadiness: 'ready' })
    render(<VoiceSettingsSection {...ready as unknown as VoiceSettingsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: '重新校准 БРО' }))
    expect(ready.startCalibration).toHaveBeenCalledTimes(1)
    expect(screen.getByText('语音与唤醒')).toBeTruthy()
  })

  it('shows cost only inside the expanded global voice plaque', () => {
    const priced: VoiceSnapshot = {
      ...idle,
      wakeReadiness: 'ready',
      cost: {
        currentRequest: {
          audioNanoUsd: 1_200_000,
          textNanoUsd: 120_000,
          cachedInputNanoUsd: 4_200,
          transcriptionNanoUsd: 200_000,
          totalNanoUsd: 1_524_200,
        },
        sessionTotal: {
          audioNanoUsd: 1_200_000,
          textNanoUsd: 120_000,
          cachedInputNanoUsd: 4_200,
          transcriptionNanoUsd: 200_000,
          totalNanoUsd: 1_524_200,
        },
        currentRequestReported: true,
        sessionReported: true,
      },
    }
    const p = props(priced)
    const view = render(<VoiceSidebarLauncher {...p as unknown as VoiceSidebarLauncherProps} />)
    expect(screen.queryByText('$0.0015242')).toBeNull()
    expect(screen.queryByRole('region', { name: '语音费用' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '展开语音控制' }))
    expect(p.setOverlayDisclosure).toHaveBeenCalledWith('expanded')
    view.rerender(<VoiceOverlay {...props(priced, 'expanded') as unknown as VoiceOverlayProps} />)
    const panel = screen.getByRole('region', { name: '语音费用' })
    expect(panel.textContent).toContain('本次请求$0.0015242')
    expect(panel.textContent).toContain('当前通话$0.0015242')
    expect(panel.textContent).toContain('音频 $0.0012 · 文本 $0.00012 · 缓存输入 $0.0000042 · 转录 $0.0002')
    expect(screen.getByText('语音就绪')).toBeTruthy()
  })

  it('updates expanded cost immediately when the controller snapshot changes', () => {
    const costAt = (nanoUsd: number): VoiceSnapshot => ({
      ...idle,
      cost: {
        currentRequest: { ...idle.cost.currentRequest, audioNanoUsd: nanoUsd, totalNanoUsd: nanoUsd },
        sessionTotal: { ...idle.cost.sessionTotal, audioNanoUsd: nanoUsd, totalNanoUsd: nanoUsd },
        currentRequestReported: true,
        sessionReported: true,
      },
    })
    const view = render(<VoiceOverlay {...props(costAt(1_000), 'expanded') as unknown as VoiceOverlayProps} />)
    expect(screen.getByRole('region', { name: '语音费用' }).textContent).toContain('$0.000001')
    view.rerender(<VoiceOverlay {...props(costAt(2_000), 'expanded') as unknown as VoiceOverlayProps} />)
    const panel = screen.getByRole('region', { name: '语音费用' })
    expect(panel.textContent).toContain('$0.000002')
    expect(panel.textContent).not.toContain('$0.000001')
  })

  it('shows ordered model actions, planned work, and the final conclusion', () => {
    const p = props({
      ...idle,
      phase: 'speaking',
      transcript: 'Проверка завершена.',
      activity: {
        steps: [
          { callId: 'find', tool: 'find_threads', status: 'completed' },
          { callId: 'turn', tool: 'thread_turn', status: 'completed' },
          { callId: 'wait', tool: 'wait_for_thread', status: 'running' },
        ],
        plannedText: 'Проверить архитектуру и подготовить вывод.',
        finalText: 'Проверка завершена.',
      },
    })
    render(<VoiceOverlay {...p as unknown as VoiceOverlayProps} />)
    const panel = screen.getByRole('region', { name: '模型工作过程' })
    expect(panel.textContent).toContain('查找相关线程')
    expect(panel.textContent).toContain('向线程发送任务')
    expect(panel.textContent).toContain('等待线程完成工作')
    expect(screen.getByText('准备发送')).toBeTruthy()
    expect(screen.getByText('Проверить архитектуру и подготовить вывод.')).toBeTruthy()
    expect(screen.getByText('最终结论')).toBeTruthy()
    expect(screen.getByText('Проверка завершена.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '语音回答' })).toBeNull()
  })

  it('keeps an explicit collapse across live activity updates and restores it on expand', () => {
    const active: VoiceSnapshot = {
      ...idle,
      phase: 'thinking',
      activity: {
        steps: [{ callId: 'turn', tool: 'thread_turn', status: 'running' }],
        plannedText: 'Проверить состояние.',
        finalText: '',
      },
    }
    const collapsed = props(active, 'collapsed')
    const view = render(<VoiceSidebarLauncher {...collapsed as unknown as VoiceSidebarLauncherProps} />)
    expect(screen.queryByRole('region', { name: '模型工作过程' })).toBeNull()
    expect(screen.getByRole('button', { name: '展开语音控制' }).getAttribute('aria-expanded')).toBe('false')

    const updated = props({ ...active, phase: 'speaking', transcript: 'Готово.' }, 'collapsed')
    view.rerender(<VoiceSidebarLauncher {...updated as unknown as VoiceSidebarLauncherProps} />)
    expect(screen.queryByText('Проверить состояние.')).toBeNull()
    expect(screen.queryByText('Готово.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开语音控制' }))
    expect(updated.setOverlayDisclosure).toHaveBeenCalledWith('expanded')
    view.rerender(<VoiceOverlay {...props({ ...active, phase: 'speaking', transcript: 'Готово.' }, 'expanded') as unknown as VoiceOverlayProps} />)
    expect(screen.getByText('Проверить состояние.')).toBeTruthy()
    expect(screen.getByRole('region', { name: '语音回答' }).textContent).toContain('Готово.')
    expect(screen.getByRole('button', { name: '收起语音控制' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('suppresses an invalid cost snapshot and logs one display error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const invalid: VoiceSnapshot = {
      ...idle,
      cost: {
        currentRequest: { ...idle.cost.currentRequest, audioNanoUsd: 1, totalNanoUsd: 2 },
        sessionTotal: { ...idle.cost.sessionTotal, audioNanoUsd: 1, totalNanoUsd: 1 },
        currentRequestReported: true,
        sessionReported: true,
      },
    }
    render(<VoiceOverlay {...props(invalid, 'expanded') as unknown as VoiceOverlayProps} />)
    expect(screen.getByText('费用暂不可用')).toBeTruthy()
    expect(screen.queryByText('$0.000000002')).toBeNull()
    expect(error).toHaveBeenCalledWith('[ui-voice] cost display rejected: current request total does not match its categories')
    error.mockRestore()
  })

  it('hides an empty activity panel and renders provider text literally', () => {
    const empty = render(<VoiceOverlay {...props(idle) as unknown as VoiceOverlayProps} />)
    expect(screen.queryByRole('region', { name: '模型工作过程' })).toBeNull()
    empty.rerender(<VoiceOverlay {...props({
      ...idle,
      activity: {
        steps: [{ callId: 'turn', tool: 'thread_turn', status: 'running' }],
        plannedText: '<script>not markup</script>',
        finalText: '',
      },
    }) as unknown as VoiceOverlayProps} />)
    expect(screen.getByText('<script>not markup</script>')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
  })

  it('shows generic response failure in the sidebar and never provider text', () => {
    const p = props({ ...idle, phase: 'error', errorCode: 'response', transcript: '' })
    render(<VoiceSidebarLauncher {...p as unknown as VoiceSidebarLauncherProps} />)
    expect(screen.getByText('语音回答失败')).toBeTruthy()
  })
})
