// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WakeWordState } from '@deepseek-ai/dsh-client-wake-word-local/client'
import {
  VoiceControllerCoordinator, VoiceSessionController, type VoiceBrowserDeps, type VoiceRuntimeConfig,
} from '../src/client/controller.ts'
import type { VoiceRemote, VoiceSessionId } from '../src/client/remote-adapter.ts'
import type { WakeWordPort } from '../src/client/wake-word-adapter.ts'

const config: VoiceRuntimeConfig = {
  maxBufferedChunks: 16,
  channelHighWaterBytes: 1024,
  channelLowWaterBytes: 256,
  statusAttempts: 3,
  statusIntervalMs: 1,
  iceTimeoutMs: 100,
  channelTimeoutMs: 100,
  responseTimeoutMs: 1_000,
  vadThreshold: 0.01,
  vadSilenceMs: 10,
}
const sid = (value: string) => value as SessionId
const voiceId = 'voice-1' as VoiceSessionId

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function wakeBench() {
  let wakeState: WakeWordState = {
    keyword: 'БРО', enabled: false, workerReady: true, ready: false, templateCount: 0,
    calibration: { active: false, sampleCount: 0, requiredSamples: 3 },
  }
  const stateListeners = new Set<() => void>()
  const detections = new Set<(value: never) => void>()
  const port: WakeWordPort = {
    getState: () => wakeState,
    subscribe: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
    onDetection: listener => { detections.add(listener as never); return () => { detections.delete(listener as never) } },
    feed: vi.fn(),
    beginCalibration: vi.fn(() => {
      wakeState = { ...wakeState, calibration: { ...wakeState.calibration, active: true, sampleCount: 0 } }
      for (const listener of stateListeners) listener()
    }),
    addCalibrationSample: vi.fn(async () => {
      const count = wakeState.calibration.sampleCount + 1
      wakeState = { ...wakeState, calibration: { ...wakeState.calibration, sampleCount: count } }
      for (const listener of stateListeners) listener()
      return count
    }),
    commitCalibration: vi.fn(async () => {
      wakeState = {
        ...wakeState, ready: true, templateCount: 3,
        calibration: { ...wakeState.calibration, active: false, sampleCount: 0 },
      }
      for (const listener of stateListeners) listener()
      return 3
    }),
    setEnabled: vi.fn(enabled => { wakeState = { ...wakeState, enabled } }),
  }
  return {
    port,
    state: () => wakeState,
    detect: () => {
      for (const listener of detections) listener({ keyword: 'БРО' } as never)
    },
  }
}

class FakeChannel {
  readyState = 'open' as RTCDataChannelState
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  sent: string[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onbufferedamountlow: (() => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  send(value: string) { this.sent.push(value) }
  close() { this.closed = true; this.onclose?.() }
  receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent) }
}

function bench(status?: () => ReturnType<VoiceRemote['status']>, runtimeConfig = config) {
  const channel = new FakeChannel()
  const transceivers: RTCRtpTransceiverInit[] = []
  let peerClosed = false
  const peer = {
    iceGatheringState: 'complete',
    localDescription: { type: 'offer', sdp: 'complete-offer' },
    addTransceiver: (_kind: string, init: RTCRtpTransceiverInit) => { transceivers.push(init); return {} },
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'offer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: () => { peerClosed = true },
    ontrack: null,
    getSenders: () => [],
  } as unknown as RTCPeerConnection
  const track = { stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const worklet = { port: { onmessage: null, close: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }
  let audioClosed = false
  const context = {
    sampleRate: 48_000,
    state: 'running',
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: () => source,
    createGain: () => gain,
    destination: {},
    close: async () => { audioClosed = true },
  } as unknown as AudioContext
  let revoked = false
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  const deps: VoiceBrowserDeps = {
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: () => context,
    createWorkletNode: () => worklet as unknown as AudioWorkletNode,
    createPeerConnection: () => peer,
    createAudioElement: () => document.createElement('audio'),
    createWorkletUrl: () => ({ url: 'blob:voice', revoke: () => { revoked = true } }),
    setTimeout: (callback, delay) => { timerId += 1; timers.set(timerId, { callback, delay }); return timerId as never },
    clearTimeout: (id) => { timers.delete(id as unknown as number) },
    now: () => 1_000,
  }
  const remote: VoiceRemote = {
    start: vi.fn(async () => ({ ok: true as const, value: { sessionId: voiceId, answerSdp: 'answer', expiresAt: 9_999 } })),
    status: status ?? vi.fn(async () => ({
      ok: true as const, value: { sessionId: voiceId, state: 'active' as const, sidebandReady: true, startedAt: 1, expiresAt: 9_999 },
    })),
    stop: vi.fn(async () => ({ ok: true as const, value: { sessionId: voiceId, stopped: true as const } })),
  }
  const wake = wakeBench()
  const coordinator = new VoiceControllerCoordinator()
  const controller = new VoiceSessionController(sid('s1'), remote, wake.port, coordinator, runtimeConfig, deps)
  return {
    controller, coordinator, channel, transceivers, peer, remote, wake, deps, timers, track,
    closed: () => ({ peerClosed, audioClosed, revoked }),
  }
}

const types = (channel: FakeChannel) => channel.sent.map(raw => (JSON.parse(raw) as { type: string }).type)
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const responseUsage = {
  total_tokens: 220,
  input_tokens: 150,
  output_tokens: 70,
  input_token_details: {
    text_tokens: 100,
    audio_tokens: 50,
    cached_tokens: 30,
    cached_tokens_details: { text_tokens: 20, audio_tokens: 10 },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 40 },
}

describe('voice session controller', () => {
  it('waits for sideband, has no microphone sender, and sends exact gated order', async () => {
    const ready = deferred<Awaited<ReturnType<VoiceRemote['status']>>>()
    const b = bench(() => ready.promise)
    const beginning = b.controller.beginPushToTalk()
    await tick()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    expect(b.channel.sent).toEqual([])
    expect(b.peer.getSenders()).toEqual([])
    expect(b.transceivers).toEqual([{ direction: 'recvonly' }])

    ready.resolve({
      ok: true,
      value: { sessionId: voiceId, state: 'active', sidebandReady: true, startedAt: 1, expiresAt: 9_999 },
    })
    await beginning
    b.controller.endPushToTalk()
    await tick()
    expect(types(b.channel)).toEqual([
      'input_audio_buffer.clear',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
      'response.create',
    ])
  })

  it('sends zero append before the gate and commits no empty early release', async () => {
    const media = deferred<MediaStream>()
    const b = bench()
    ;(b.deps.getUserMedia as ReturnType<typeof vi.fn>).mockImplementation(() => media.promise)
    b.controller.acceptSamples(Float32Array.from([0.5, 0.5]))
    const beginning = b.controller.beginPushToTalk()
    b.controller.endPushToTalk()
    media.resolve({ getTracks: () => [b.track] } as unknown as MediaStream)
    await beginning
    expect(types(b.channel)).not.toContain('input_audio_buffer.append')
    expect(types(b.channel)).not.toContain('input_audio_buffer.commit')
    expect(b.remote.start).not.toHaveBeenCalled()
  })

  it('bounds sideband polling attempts', async () => {
    const status = vi.fn(async () => ({
      ok: true as const,
      value: { sessionId: voiceId, state: 'connecting' as const, sidebandReady: false, startedAt: 1, expiresAt: 9_999 },
    }))
    const pollingConfig = { ...config, statusIntervalMs: 0 }
    const b = bench(status, pollingConfig)
    const originalSetTimeout = b.deps.setTimeout
    b.deps.setTimeout = (callback, delay) => {
      if (delay === 0) queueMicrotask(callback)
      return originalSetTimeout(callback, delay)
    }
    await b.controller.beginPushToTalk()
    expect(status).toHaveBeenCalledTimes(config.statusAttempts)
    expect(b.controller.getSnapshot().errorCode).toBe('connection')
  })

  it('does not time out an approval-length wait after the first tool response', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    expect([...b.timers.values()].some(timer => timer.delay === config.responseTimeoutMs)).toBe(true)
    b.channel.receive({ type: 'response.done', response: { id: 'tool-1', status: 'completed', output: [{ type: 'function_call' }] } })
    expect(b.controller.getSnapshot().sawToolResponse).toBe(true)
    expect([...b.timers.values()].some(timer => timer.delay === config.responseTimeoutMs)).toBe(false)
  })

  it('keeps transport alive until generated speech drains', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()

    b.channel.receive({
      type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [{ type: 'message' }] },
    })
    await tick()
    expect(b.channel.closed).toBe(false)
    expect(b.remote.stop).not.toHaveBeenCalled()

    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-1' })
    await tick()
    expect(b.channel.closed).toBe(true)
    expect(b.remote.stop).toHaveBeenCalledWith('s1', voiceId)
    expect(b.controller.getSnapshot().phase).toBe('idle')
  })

  it('accumulates request and session costs across teardown while deduplicating provider ids', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()

    const transcription = {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'transcription-1',
      usage: { type: 'tokens', total_tokens: 100, input_tokens: 80, output_tokens: 20 },
    }
    const response = {
      type: 'response.done',
      response: { id: 'speech-cost-1', status: 'completed', output: [{ type: 'message' }], usage: responseUsage },
    }
    b.channel.receive(transcription)
    b.channel.receive(transcription)
    b.channel.receive(response)
    b.channel.receive(response)
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: {
        audioNanoUsd: 3_840_000,
        textNanoUsd: 1_040_000,
        cachedInputNanoUsd: 12_000,
        transcriptionNanoUsd: 200_000,
        totalNanoUsd: 5_092_000,
      },
      sessionTotal: { totalNanoUsd: 5_092_000 },
      currentRequestReported: true,
      sessionReported: true,
    })

    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-cost-1' })
    await tick()
    expect(b.controller.getSnapshot().phase).toBe('idle')
    expect(b.controller.getSnapshot().cost.sessionTotal.totalNanoUsd).toBe(5_092_000)
    const responseCreatesBefore = types(b.channel).filter(type => type === 'response.create').length

    const media = deferred<MediaStream>()
    ;(b.deps.getUserMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(() => media.promise)
    const emptyGate = b.controller.beginPushToTalk()
    b.controller.endPushToTalk()
    media.resolve({ getTracks: () => [b.track] } as unknown as MediaStream)
    await emptyGate
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: { totalNanoUsd: 5_092_000 },
      sessionTotal: { totalNanoUsd: 5_092_000 },
      currentRequestReported: true,
    })
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(responseCreatesBefore)

    ;(b.remote.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection failed'))
    await b.controller.beginPushToTalk()
    expect(b.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      cost: {
        currentRequest: { totalNanoUsd: 5_092_000 },
        sessionTotal: { totalNanoUsd: 5_092_000 },
        currentRequestReported: true,
      },
    })
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(responseCreatesBefore)

    await b.controller.beginPushToTalk()
    expect(b.controller.getSnapshot().cost.currentRequest.totalNanoUsd).toBe(5_092_000)
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: { totalNanoUsd: 0 },
      sessionTotal: { totalNanoUsd: 5_092_000 },
      currentRequestReported: false,
      sessionReported: true,
    })
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(responseCreatesBefore + 1)
  })

  it('interrupts active playback before opening a replacement speech gate', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    b.channel.receive({ type: 'response.audio_transcript.delta', delta: 'Старый ответ' })
    expect(b.controller.getSnapshot().phase).toBe('speaking')

    await b.controller.beginPushToTalk()

    expect(types(b.channel)).toContain('response.cancel')
    expect(types(b.channel)).toContain('output_audio_buffer.clear')
    expect(b.remote.stop).toHaveBeenCalledWith('s1', voiceId)
    expect(b.remote.start).toHaveBeenCalledTimes(2)
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'listening', transcript: '' })
  })

  it('uses a hands-free wake detection to interrupt spoken output', async () => {
    const b = bench()
    await b.controller.setHandsFree(true)
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    b.channel.receive({ type: 'response.audio_transcript.delta', delta: 'Старый ответ' })

    b.wake.detect()
    await vi.waitFor(() => { expect(b.remote.start).toHaveBeenCalledTimes(2) })

    expect(types(b.channel)).toContain('response.cancel')
    expect(types(b.channel)).toContain('output_audio_buffer.clear')
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'listening', handsFree: true })
  })

  it('abandons an interrupt gate when the user releases before teardown settles', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    b.channel.receive({ type: 'response.audio_transcript.delta', delta: 'Старый ответ' })
    const stopped = deferred<Awaited<ReturnType<VoiceRemote['stop']>>>()
    ;(b.remote.stop as ReturnType<typeof vi.fn>).mockImplementationOnce(() => stopped.promise)

    const interrupting = b.controller.beginPushToTalk()
    expect(b.controller.getSnapshot().phase).toBe('interrupting')
    b.controller.endPushToTalk()
    stopped.resolve({ ok: true, value: { sessionId: voiceId, stopped: true } })
    await interrupting

    expect(b.remote.start).toHaveBeenCalledTimes(1)
    expect(b.controller.getSnapshot().phase).toBe('idle')
  })

  it('matches playback completion by response id regardless of arrival order', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()

    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-1' })
    b.channel.receive({
      type: 'response.done', response: { id: 'speech-other', status: 'completed', output: [{ type: 'message' }] },
    })
    await tick()
    expect(b.channel.closed).toBe(false)

    b.channel.receive({
      type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [{ type: 'message' }] },
    })
    await tick()
    expect(b.channel.closed).toBe(true)
    expect(b.remote.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps explicitly armed hands-free capture after manual response cancellation', async () => {
    const b = bench()
    await b.controller.setHandsFree(true)
    await b.controller.beginPushToTalk()

    await b.controller.cancel()

    expect(b.track.stopped).toBe(false)
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'idle', handsFree: true })
    await b.controller.dispose()
  })

  it('tears down tracks, context, worklet URL, data channel, peer, audio, and Host session', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    await b.controller.dispose()
    expect(b.track.stopped).toBe(true)
    expect(b.channel.closed).toBe(true)
    expect(b.closed()).toEqual({ peerClosed: true, audioClosed: true, revoked: true })
    expect(b.remote.stop).toHaveBeenCalledWith('s1', voiceId)
    expect(b.wake.port.setEnabled).not.toHaveBeenCalledWith(expect.anything())
  })

  it('always releases local media when Host stop rejects', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    ;(b.remote.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('host unavailable'))

    await expect(b.controller.dispose()).resolves.toBeUndefined()
    expect(b.track.stopped).toBe(true)
    expect(b.channel.closed).toBe(true)
    expect(b.closed()).toEqual({ peerClosed: true, audioClosed: true, revoked: true })
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'error', errorCode: 'connection' })
  })

  it('clears channel wait handlers so late open cannot revive stopped transport', async () => {
    const b = bench()
    b.channel.readyState = 'connecting'
    const beginning = b.controller.beginPushToTalk()
    await vi.waitFor(() => { expect(b.channel.onopen).toBeTypeOf('function') })
    const lateOpen = b.channel.onopen

    await b.controller.dispose()
    await beginning
    expect(b.channel.onopen).toBeNull()
    expect(b.channel.onerror).toBeNull()
    expect(b.channel.onclose).toBeNull()
    expect([...b.timers.values()].some(timer => timer.delay === config.channelTimeoutMs)).toBe(false)
    lateOpen?.()
    expect(b.channel.sent).toEqual([])
  })

  it('keeps only one active microphone across session navigation', async () => {
    const first = bench()
    const second = new VoiceSessionController(
      sid('s2'), first.remote, first.wake.port, first.coordinator, config, first.deps,
    )
    await first.controller.setHandsFree(true)
    await second.setHandsFree(true)
    expect(first.controller.getSnapshot().handsFree).toBe(false)
    expect(first.track.stopped).toBe(true)
    await second.dispose()
  })

  it('derives three calibration templates and retains no raw sample in UI state', async () => {
    const b = bench()
    await b.controller.startCalibration()
    for (let count = 1; count <= 3; count += 1) {
      await b.controller.beginCalibrationSample()
      b.controller.acceptSamples(Float32Array.from([0, 0.2, 0.3, 0]))
      await b.controller.endCalibrationSample()
    }
    expect(b.wake.port.addCalibrationSample).toHaveBeenCalledTimes(3)
    expect(b.wake.port.commitCalibration).toHaveBeenCalledTimes(1)
    expect(b.controller.getSnapshot().wakeReadiness).toBe('ready')
    expect(JSON.stringify(b.controller.getSnapshot())).not.toContain('pcm')
  })
})
