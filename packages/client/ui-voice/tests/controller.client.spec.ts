// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WakeWordState } from '@deepseek-ai/dsh-client-wake-word-local/client'
import { VoiceCalibrationController } from '../src/client/calibration-controller.ts'
import {
  browserVoiceDeps, VoiceControllerCoordinator, VoiceSessionController, type VoiceBrowserDeps, type VoiceRuntimeConfig,
} from '../src/client/controller.ts'
import type { VoiceConsumerId, VoiceRemote, VoiceSessionId } from '../src/client/remote-adapter.ts'
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
  wakeSignalDefault: true,
}
const sid = (value: string) => value as SessionId
const voiceId = 'voice-1' as VoiceSessionId
const consumerId = 'consumer-1' as VoiceConsumerId

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
  const remoteAudio = document.createElement('audio')
  remoteAudio.play = vi.fn(async () => {})
  remoteAudio.pause = vi.fn()
  const deps: VoiceBrowserDeps = {
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: () => context,
    createWorkletNode: () => worklet as unknown as AudioWorkletNode,
    createPeerConnection: () => peer,
    createAudioElement: () => remoteAudio,
    createWorkletUrl: () => ({ url: 'blob:voice', revoke: () => { revoked = true } }),
    playWakeSignal: vi.fn(),
    loadWakeSignalPreference: vi.fn(fallback => fallback),
    saveWakeSignalPreference: vi.fn(),
    setTimeout: (callback, delay) => { timerId += 1; timers.set(timerId, { callback, delay }); return timerId as never },
    clearTimeout: (id) => { timers.delete(id as unknown as number) },
    now: () => 1_000,
  }
  const remote: VoiceRemote = {
    start: vi.fn(async () => ({ ok: true as const, value: { sessionId: voiceId, answerSdp: 'answer', expiresAt: 9_999 } })),
    status: status ?? vi.fn(async () => ({
      ok: true as const, value: { sessionId: voiceId, state: 'active' as const, sidebandReady: true, startedAt: 1, expiresAt: 9_999 },
    })),
    setForeground: vi.fn(async (_voiceSessionId, foregroundSessionId) => ({
      ok: true as const, value: { sessionId: voiceId, ...(foregroundSessionId === undefined ? {} : { foregroundSessionId }) },
    })),
    claimResponseEpoch: vi.fn(async (_voiceSessionId, epoch) => ({
      ok: true as const, value: { sessionId: voiceId, epoch, claimed: true as const },
    })),
    ackNavigation: vi.fn(async (_voiceSessionId, request) => ({
      ok: true as const, value: { navigationId: request.navigationId, acknowledged: true as const },
    })),
    ackCreation: vi.fn(async (_voiceSessionId, request) => ({
      ok: true as const, value: { creationId: request.creationId, acknowledged: true as const },
    })),
    stop: vi.fn(async () => ({ ok: true as const, value: { sessionId: voiceId, stopped: true as const } })),
  }
  const wake = wakeBench()
  const coordinator = new VoiceControllerCoordinator()
  let foregroundSessionId: SessionId | undefined = sid('s1')
  const controller = new VoiceSessionController(
    consumerId, () => foregroundSessionId, remote, wake.port, coordinator, runtimeConfig, deps,
  )
  return {
    controller, coordinator, channel, transceivers, peer, remote, wake, deps, timers, track, worklet, remoteAudio,
    setForegroundSessionId: (value: SessionId | undefined) => { foregroundSessionId = value },
    closed: () => ({ peerClosed, audioClosed, revoked }),
  }
}

const types = (channel: FakeChannel) => channel.sent.map(raw => (JSON.parse(raw) as { type: string }).type)
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const startResponse = (channel: FakeChannel, responseId: string) => {
  const created = channel.sent.map(raw => JSON.parse(raw) as {
    type: string
    response?: { metadata?: { dsh_response_epoch?: string } }
  }).findLast(event => event.type === 'response.create')
  const epoch = created?.response?.metadata?.dsh_response_epoch
  if (epoch === undefined) throw new Error('response.create epoch missing from fixture')
  channel.receive({
    type: 'response.created', response: { id: responseId, metadata: { dsh_response_epoch: epoch } },
  })
}
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

describe('browser wake confirmation', () => {
  it('plays one bounded oscillator signal and releases its nodes', () => {
    let ended: (() => void) | undefined
    const frequency = { setValueAtTime: vi.fn() }
    const envelope = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
    const oscillator = {
      type: 'square', frequency,
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: () => void) => { ended = listener }),
    }
    const gain = { gain: envelope, connect: vi.fn(), disconnect: vi.fn() }
    const context = {
      currentTime: 2,
      destination: {},
      createOscillator: () => oscillator,
      createGain: () => gain,
    } as unknown as AudioContext

    browserVoiceDeps.playWakeSignal(context)
    expect(oscillator.type).toBe('sine')
    expect(frequency.setValueAtTime).toHaveBeenCalledWith(880, 2)
    expect(oscillator.start).toHaveBeenCalledWith(2)
    expect(oscillator.stop).toHaveBeenCalledWith(2.16)
    ended?.()
    expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
    expect(gain.disconnect).toHaveBeenCalledTimes(1)
  })

  it('persists the setting and falls back when browser storage is unavailable', () => {
    localStorage.removeItem('dsh.voice.wake-signal.v1')
    expect(browserVoiceDeps.loadWakeSignalPreference(true)).toBe(true)
    browserVoiceDeps.saveWakeSignalPreference(false)
    expect(browserVoiceDeps.loadWakeSignalPreference(true)).toBe(false)
    browserVoiceDeps.saveWakeSignalPreference(true)
    expect(browserVoiceDeps.loadWakeSignalPreference(false)).toBe(true)
    localStorage.setItem('dsh.voice.wake-signal.v1', 'invalid')
    expect(browserVoiceDeps.loadWakeSignalPreference(true)).toBe(true)

    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(browserVoiceDeps.loadWakeSignalPreference(false)).toBe(false)
    get.mockRestore()
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => { browserVoiceDeps.saveWakeSignalPreference(true) }).not.toThrow()
    set.mockRestore()
  })
})

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
    startResponse(b.channel, 'tool-1')
    b.channel.receive({ type: 'response.done', response: { id: 'tool-1', status: 'completed', output: [{ type: 'function_call' }] } })
    expect(b.controller.getSnapshot().sawToolResponse).toBe(true)
    expect([...b.timers.values()].some(timer => timer.delay === config.responseTimeoutMs)).toBe(false)
  })

  it('accumulates bounded model activity and resets it for the next phrase', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'tool-1')

    b.channel.receive({
      type: 'response.function_call_arguments.done', response_id: 'tool-1', call_id: 'turn', name: 'thread_turn',
      arguments: JSON.stringify({ prompt: 'Проверить архитектуру' }),
    })
    b.channel.receive({
      type: 'response.function_call_arguments.done', response_id: 'tool-1', call_id: 'turn', name: 'thread_turn',
      arguments: JSON.stringify({ prompt: 'duplicate' }),
    })
    expect(b.controller.getSnapshot().activity).toEqual({
      steps: [{ callId: 'turn', tool: 'thread_turn', status: 'running' }],
      plannedText: 'Проверить архитектуру', finalText: '',
    })
    b.channel.receive({
      type: 'response.done', response: { id: 'tool-1', status: 'completed', output: [{ type: 'function_call' }] },
    })
    startResponse(b.channel, 'speech-1')
    b.channel.receive({
      type: 'response.function_call_arguments.done', response_id: 'speech-1', call_id: 'wait', name: 'wait_for_thread', arguments: '{}',
    })
    b.channel.receive({ type: 'response.output_audio_transcript.done', response_id: 'speech-1', transcript: 'Готово.' })
    b.channel.receive({
      type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [{ type: 'message' }] },
    })
    expect(b.controller.getSnapshot().activity).toEqual({
      steps: [
        { callId: 'turn', tool: 'thread_turn', status: 'completed' },
        { callId: 'wait', tool: 'wait_for_thread', status: 'completed' },
      ],
      plannedText: 'Проверить архитектуру', finalText: 'Готово.',
    })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-1' })
    await tick()
    expect(b.controller.getSnapshot().phase).toBe('idle')
    expect(b.controller.getSnapshot().activity.finalText).toBe('Готово.')

    await b.controller.cancel()
    expect(b.controller.getSnapshot().activity).toEqual({ steps: [], plannedText: '', finalText: '' })
  })

  it('stops a Host call whose start resolves after local cancellation', async () => {
    const b = bench()
    const starting = deferred<Awaited<ReturnType<VoiceRemote['start']>>>()
    vi.mocked(b.remote.start).mockImplementationOnce(() => starting.promise)
    const beginning = b.controller.beginPushToTalk()
    for (let attempt = 0; attempt < 10 && vi.mocked(b.remote.start).mock.calls.length === 0; attempt += 1) await tick()
    expect(b.remote.start).toHaveBeenCalledTimes(1)

    const cancelling = b.controller.cancel()
    starting.resolve({
      ok: true,
      value: { sessionId: voiceId, answerSdp: 'v=0\r\n', expiresAt: Date.now() + 1_000 },
    })
    await Promise.all([beginning, cancelling])
    expect(b.remote.stop).toHaveBeenCalledWith(voiceId)
    expect(b.controller.getSnapshot().phase).toBe('idle')
  })

  it('reuses one Host call and data channel for consecutive phrases', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-1')
    b.channel.receive({ type: 'response.output_audio_transcript.done', response_id: 'speech-1', transcript: 'Первый ответ.' })
    b.channel.receive({
      type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [{ type: 'message' }] },
    })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-1' })
    await tick()
    expect(b.controller.getSnapshot().phase).toBe('idle')
    expect(b.channel.closed).toBe(false)
    expect(b.remote.stop).not.toHaveBeenCalled()

    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.3, 0.3, 0.3, 0.3]))
    b.controller.endPushToTalk()
    await tick()
    expect(b.remote.start).toHaveBeenCalledTimes(1)
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(2)
    await b.controller.cancel()
  })

  it('keeps the persistent transport alive after generated speech drains', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-1')

    b.channel.receive({
      type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [{ type: 'message' }] },
    })
    await tick()
    expect(b.controller.getSnapshot().phase).not.toBe('idle')
    expect(b.channel.closed).toBe(false)

    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-1' })
    await tick()
    expect(b.channel.closed).toBe(false)
    expect(b.remote.stop).not.toHaveBeenCalled()
    expect(b.controller.getSnapshot().phase).toBe('idle')
  })

  it('accumulates request and session costs across teardown while deduplicating provider ids', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()

    b.channel.receive({ type: 'input_audio_buffer.committed', item_id: 'input-cost-1' })
    const transcription = {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-cost-1',
      event_id: 'transcription-1',
      usage: { type: 'tokens', total_tokens: 100, input_tokens: 80, output_tokens: 20 },
    }
    const response = {
      type: 'response.done',
      response: { id: 'speech-cost-1', status: 'completed', output: [{ type: 'message' }], usage: responseUsage },
    }
    startResponse(b.channel, 'speech-cost-1')
    b.channel.receive(transcription)
    b.channel.receive(transcription)
    b.channel.receive(response)
    b.channel.receive(response)
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: {
        audioNanoUsd: 1_200_000,
        textNanoUsd: 120_000,
        cachedInputNanoUsd: 4_200,
        transcriptionNanoUsd: 200_000,
        totalNanoUsd: 1_524_200,
      },
      sessionTotal: { totalNanoUsd: 1_524_200 },
      currentRequestReported: true,
      sessionReported: true,
    })

    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-cost-1' })
    await tick()
    expect(b.controller.getSnapshot().phase).toBe('idle')
    expect(b.controller.getSnapshot().cost.sessionTotal.totalNanoUsd).toBe(1_524_200)
    const responseCreatesBefore = types(b.channel).filter(type => type === 'response.create').length

    const media = deferred<MediaStream>()
    ;(b.deps.getUserMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(() => media.promise)
    const emptyGate = b.controller.beginPushToTalk()
    b.controller.endPushToTalk()
    media.resolve({ getTracks: () => [b.track] } as unknown as MediaStream)
    await emptyGate
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: { totalNanoUsd: 1_524_200 },
      sessionTotal: { totalNanoUsd: 1_524_200 },
      currentRequestReported: true,
    })
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(responseCreatesBefore)

    await b.controller.beginPushToTalk()
    expect(b.controller.getSnapshot().cost.currentRequest.totalNanoUsd).toBe(1_524_200)
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: { totalNanoUsd: 0 },
      sessionTotal: { totalNanoUsd: 1_524_200 },
      currentRequestReported: false,
      sessionReported: true,
    })
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(responseCreatesBefore + 1)
  })

  it('keeps late retired usage out of the replacement request during interruption', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    b.channel.receive({ type: 'input_audio_buffer.committed', item_id: 'input-retired' })
    startResponse(b.channel, 'speech-retired')

    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.3, 0.3, 0.3, 0.3]))
    b.controller.endPushToTalk()
    await tick()
    expect(b.controller.getSnapshot().cost.currentRequest.totalNanoUsd).toBe(0)

    b.channel.receive({
      type: 'response.done',
      response: { id: 'speech-retired', status: 'completed', output: [{ type: 'message' }], usage: responseUsage },
    })
    b.channel.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-retired',
      event_id: 'transcription-retired',
      usage: { type: 'tokens', total_tokens: 100, input_tokens: 80, output_tokens: 20 },
    })
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: { totalNanoUsd: 0 },
      sessionTotal: { totalNanoUsd: 1_524_200 },
      currentRequestReported: false,
      sessionReported: true,
    })

    b.channel.receive({ type: 'input_audio_buffer.committed', item_id: 'input-current' })
    startResponse(b.channel, 'speech-current')
    b.channel.receive({
      type: 'response.done',
      response: { id: 'speech-current', status: 'completed', output: [{ type: 'message' }], usage: responseUsage },
    })
    expect(b.controller.getSnapshot().cost).toMatchObject({
      currentRequest: { totalNanoUsd: 1_324_200 },
      sessionTotal: { totalNanoUsd: 2_848_400 },
      currentRequestReported: true,
    })
  })

  it('starts a new phrase during a completed tool response without cancelling or closing the call', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'tool-wait')
    b.channel.receive({ type: 'response.done', response: { id: 'tool-wait', status: 'completed', output: [{ type: 'function_call' }] } })
    expect(b.controller.getSnapshot().phase).toBe('thinking')

    await b.controller.beginPushToTalk()
    expect(types(b.channel).filter(type => type === 'response.cancel')).toHaveLength(0)
    b.channel.receive({ type: 'error', error: { code: 'response_cancel_not_active' } })
    expect(b.controller.getSnapshot().phase).toBe('listening')
    expect(b.remote.stop).not.toHaveBeenCalled()
    expect(b.channel.closed).toBe(false)
  })

  it('announces queued Session completions on the persistent call', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-before-completion')
    b.channel.receive({ type: 'response.done', response: { id: 'speech-before-completion', status: 'completed', output: [{ type: 'message' }] } })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-before-completion' })
    await tick()
    const responseCreates = types(b.channel).filter(type => type === 'response.create').length

    b.controller.queueCompletion({
      consumerId,
      voiceSessionId: voiceId,
      requestId: 'request-a' as never,
      sessionId: sid('session-a'),
      title: 'Сессия A',
      state: 'completed',
    })
    await tick()

    const completion = b.channel.sent.map(raw => JSON.parse(raw) as { type: string; item?: { role?: string; content?: Array<{ text?: string }> } })
      .findLast(event => event.type === 'conversation.item.create')
    expect(completion?.item).toMatchObject({ role: 'system' })
    expect(completion?.item?.content?.[0]?.text).toContain('request-a')
    expect(completion?.item?.content?.[0]?.text).toContain('Сессия A')
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(responseCreates + 1)
    expect(b.remote.start).toHaveBeenCalledTimes(1)
    expect(b.controller.getSnapshot().phase).toBe('thinking')
  })

  it('interrupts active playback immediately without replacing the global call', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-1')
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-1', delta: 'Старый ответ' })
    expect(b.controller.getSnapshot().phase).toBe('speaking')
    const claimed = deferred<Awaited<ReturnType<VoiceRemote['claimResponseEpoch']>>>()
    vi.mocked(b.remote.claimResponseEpoch).mockImplementationOnce(() => claimed.promise)

    const interruption = b.controller.beginPushToTalk()
    await tick()

    expect(b.remoteAudio.pause).toHaveBeenCalledTimes(1)
    expect(types(b.channel)).toContain('response.cancel')
    expect(types(b.channel)).toContain('output_audio_buffer.clear')
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'interrupting', transcript: '' })
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-1', delta: ' не должен вернуться' })
    expect(b.controller.getSnapshot().transcript).toBe('')
    const epoch = vi.mocked(b.remote.claimResponseEpoch).mock.calls.at(-1)?.[1]
    if (epoch === undefined) throw new Error('replacement epoch was not claimed')
    claimed.resolve({ ok: true, value: { sessionId: voiceId, epoch, claimed: true } })
    await interruption

    expect(b.remote.stop).not.toHaveBeenCalled()
    expect(b.remote.start).toHaveBeenCalledTimes(1)
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'listening', transcript: '' })
  })

  it('keeps a short voiced barge-in while response ownership is being claimed', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-old')
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-old', delta: 'Старый ответ' })
    const claimed = deferred<Awaited<ReturnType<VoiceRemote['claimResponseEpoch']>>>()
    vi.mocked(b.remote.claimResponseEpoch).mockImplementationOnce(() => claimed.promise)
    const createsBefore = types(b.channel).filter(type => type === 'response.create').length

    const interruption = b.controller.beginPushToTalk()
    await tick()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    expect(b.controller.getSnapshot().phase).toBe('thinking')
    const epoch = vi.mocked(b.remote.claimResponseEpoch).mock.calls.at(-1)?.[1]
    if (epoch === undefined) throw new Error('replacement epoch was not claimed')
    claimed.resolve({ ok: true, value: { sessionId: voiceId, epoch, claimed: true } })
    await interruption
    await tick()

    expect(types(b.channel).filter(type => type === 'input_audio_buffer.commit')).toHaveLength(2)
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(createsBefore + 1)
    startResponse(b.channel, 'speech-new')
    expect(b.remoteAudio.play).toHaveBeenCalled()
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-old', delta: 'Смешанный старый текст' })
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-new', delta: 'Новый ответ' })
    expect(b.controller.getSnapshot().transcript).toBe('Новый ответ')
  })

  it('drops low-energy microphone noise without creating a replacement request', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    const createsBefore = types(b.channel).filter(type => type === 'response.create').length

    b.controller.acceptSamples(Float32Array.from([0.001, -0.001, 0.001, -0.001]))
    b.controller.endPushToTalk()
    await tick()

    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(createsBefore)
    expect(types(b.channel)).not.toContain('input_audio_buffer.commit')
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: '' })
  })

  it('does not resume an interrupted completion announcement after the replacement response', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'initial')
    b.channel.receive({ type: 'response.done', response: { id: 'initial', status: 'completed', output: [{ type: 'message' }] } })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'initial' })
    await tick()
    b.controller.queueCompletion({
      consumerId,
      voiceSessionId: voiceId,
      requestId: 'completion-old' as never,
      sessionId: sid('session-old'),
      title: 'Старая сессия',
      state: 'completed',
    })
    await tick()
    startResponse(b.channel, 'announcement-old')

    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'replacement')
    const createsAfterReplacement = types(b.channel).filter(type => type === 'response.create').length
    b.channel.receive({ type: 'response.done', response: { id: 'replacement', status: 'completed', output: [{ type: 'message' }] } })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'replacement' })
    await tick()

    expect(b.controller.getSnapshot().phase).toBe('idle')
    expect(types(b.channel).filter(type => type === 'response.create')).toHaveLength(createsAfterReplacement)
  })

  it('stops the audible tail after generation has completed but playback has not drained', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-tail')
    b.channel.receive({
      type: 'response.done', response: { id: 'speech-tail', status: 'completed', output: [{ type: 'message' }] },
    })
    const clearsBefore = types(b.channel).filter(type => type === 'output_audio_buffer.clear').length

    await b.controller.beginPushToTalk()

    expect(b.remoteAudio.pause).toHaveBeenCalledTimes(1)
    expect(types(b.channel).filter(type => type === 'response.cancel')).toHaveLength(0)
    expect(types(b.channel).filter(type => type === 'output_audio_buffer.clear').length).toBeGreaterThan(clearsBefore)
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'listening', transcript: '' })
  })

  it('uses a hands-free wake detection to interrupt spoken output', async () => {
    const b = bench()
    await b.controller.setHandsFree(true)
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-1')
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-1', delta: 'Старый ответ' })

    b.wake.detect()
    b.wake.detect()
    await vi.waitFor(() => { expect(b.controller.getSnapshot().phase).toBe('listening') })

    expect(b.deps.playWakeSignal).toHaveBeenCalledTimes(1)
    expect(b.remote.start).toHaveBeenCalledTimes(1)
    expect(b.remote.stop).not.toHaveBeenCalled()
    expect(types(b.channel)).toContain('response.cancel')
    expect(types(b.channel)).toContain('output_audio_buffer.clear')
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'listening', handsFree: true })
  })

  it('keeps wake handling active when its confirmation sound is disabled or fails', async () => {
    const inactive = bench()
    inactive.wake.detect()
    await inactive.controller.beginPushToTalk()
    expect(inactive.deps.playWakeSignal).not.toHaveBeenCalled()

    const defaultOff = bench(undefined, { ...config, wakeSignalDefault: false })
    expect(defaultOff.controller.getSnapshot().wakeSignalEnabled).toBe(false)

    const disabled = bench()
    disabled.controller.setWakeSignalEnabled(false)
    await disabled.controller.setHandsFree(true)
    disabled.wake.detect()
    await vi.waitFor(() => { expect(disabled.controller.getSnapshot().phase).toBe('listening') })
    expect(disabled.deps.saveWakeSignalPreference).toHaveBeenCalledWith(false)
    expect(disabled.deps.playWakeSignal).not.toHaveBeenCalled()

    const failed = bench()
    vi.mocked(failed.deps.playWakeSignal).mockImplementation(() => { throw new Error('output unavailable') })
    await failed.controller.setHandsFree(true)
    failed.wake.detect()
    await vi.waitFor(() => { expect(failed.controller.getSnapshot().phase).toBe('listening') })
    expect(failed.deps.playWakeSignal).toHaveBeenCalledTimes(1)
    expect(failed.controller.getSnapshot()).toMatchObject({ handsFree: true, phase: 'listening' })
  })

  it('ignores late completion events from the interrupted response epoch', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-old')
    b.channel.receive({ type: 'response.audio_transcript.delta', response_id: 'speech-old', delta: 'Старый ответ' })

    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.3, 0.3, 0.3, 0.3]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-new')
    expect(b.controller.getSnapshot().phase).toBe('thinking')

    b.channel.receive({
      type: 'response.done', response: { id: 'speech-old', status: 'completed', output: [{ type: 'message' }] },
    })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-old' })
    await tick()
    expect(b.controller.getSnapshot().phase).toBe('thinking')
    expect(b.remote.stop).not.toHaveBeenCalled()

    b.channel.receive({
      type: 'response.done', response: { id: 'speech-new', status: 'completed', output: [{ type: 'message' }] },
    })
    b.channel.receive({ type: 'output_audio_buffer.stopped', response_id: 'speech-new' })
    await tick()
    expect(b.controller.getSnapshot().phase).toBe('idle')
  })

  it('matches playback completion by response id regardless of arrival order', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.controller.acceptSamples(Float32Array.from([0.2, 0.2, 0.2, 0.2]))
    b.controller.endPushToTalk()
    await tick()
    startResponse(b.channel, 'speech-1')

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
    expect(b.controller.getSnapshot().phase).toBe('idle')
    expect(b.channel.closed).toBe(false)
    expect(b.remote.stop).not.toHaveBeenCalled()
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

  it('closes the Host call when the live data channel fails', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    b.channel.close()
    await vi.waitFor(() => { expect(b.remote.stop).toHaveBeenCalledWith(voiceId) })
    expect(b.track.stopped).toBe(true)
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'error', errorCode: 'connection' })
  })

  it('tears down tracks, context, worklet URL, data channel, peer, audio, and Host session', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    await b.controller.dispose()
    expect(b.track.stopped).toBe(true)
    expect(b.channel.closed).toBe(true)
    expect(b.closed()).toEqual({ peerClosed: true, audioClosed: true, revoked: true })
    expect(b.remote.stop).toHaveBeenCalledWith(voiceId)
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

  it('keeps one live call while foreground Session changes and serializes Host updates', async () => {
    const b = bench()
    await b.controller.beginPushToTalk()
    expect(b.remote.start).toHaveBeenCalledWith({
      sdp: 'complete-offer', consumerId, foregroundSessionId: 's1',
    })
    expect(b.controller.ownsVoiceSession(voiceId)).toBe(true)

    b.setForegroundSessionId(sid('s2'))
    await b.controller.setForeground(sid('s2'))
    b.setForegroundSessionId(undefined)
    await b.controller.setForeground(undefined)

    expect(b.remote.start).toHaveBeenCalledTimes(1)
    expect(b.remote.setForeground).toHaveBeenNthCalledWith(1, voiceId, 's2')
    expect(b.remote.setForeground).toHaveBeenNthCalledWith(2, voiceId, undefined)
    await b.controller.dispose()
  })

  it('derives three Settings calibration templates and retains no raw sample in UI state', async () => {
    const b = bench()
    const calibration = new VoiceCalibrationController(b.wake.port, b.coordinator, b.deps)
    await calibration.startCalibration()
    for (let count = 1; count <= 3; count += 1) {
      await calibration.beginCalibrationSample()
      ;(b.worklet as unknown as AudioWorkletNode).port.onmessage?.(
        { data: Float32Array.from([0, 0.2, 0.3, 0]) } as MessageEvent,
      )
      await calibration.endCalibrationSample()
    }
    expect(b.wake.port.addCalibrationSample).toHaveBeenCalledTimes(3)
    expect(b.wake.port.commitCalibration).toHaveBeenCalledTimes(1)
    expect(calibration.getSnapshot().wakeReadiness).toBe('ready')
    expect(JSON.stringify(calibration.getSnapshot())).not.toContain('pcm')
    await calibration.dispose()
    await b.controller.dispose()
  })
})
