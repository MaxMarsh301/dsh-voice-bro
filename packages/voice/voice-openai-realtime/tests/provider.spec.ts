import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import OpenAiRealtimeVoiceService, { parseFunctionCall, parseRtcCallId, resolveConfig, validateSdp } from '../src/index.ts'
import type { RuntimeDependencies } from '../src/index.ts'

class MockSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  readonly sent: string[] = []
  send(value: string): void { this.sent.push(value) }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close') }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}

function createAgent(ctx: Context): Agent {
  const id = 'voice-agent' as Agent['id']
  return {
    id, options: {}, status: 'idle', ctx, inbox: { nextTurn: [], nextStep: [] } as unknown as Agent['inbox'],
    session: { id, events: [] } as unknown as Agent['session'],
    cancel: vi.fn(), whenIdle: () => Promise.resolve(), runMaintenance: vi.fn(), send: vi.fn(), followup: vi.fn(), steer: vi.fn(), inject: vi.fn(),
  }
}

function response(): Response {
  return new Response('v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n', { status: 201, headers: { location: '/v1/realtime/calls/rtc_test_123' } })
}

async function tick(): Promise<void> { await new Promise(resolve => setImmediate(resolve)) }

describe('OpenAI Realtime validation', () => {
  it('applies strict defaults, bounds, SDP checks, and official rtc ids', () => {
    expect(resolveConfig()).toMatchObject({
      model: 'gpt-realtime-2.1', transcriptionModel: 'gpt-4o-mini-transcribe', voice: 'cedar',
      maxSessionSeconds: 3300, maxResponseOutputTokens: 768,
    })
    expect(() => resolveConfig({ maxSessionSeconds: 3301 })).toThrow(/maxSessionSeconds/)
    expect(() => resolveConfig({ maxResponseOutputTokens: 255 })).toThrow(/maxResponseOutputTokens/)
    expect(() => resolveConfig({ model: 'other' as never })).toThrow(/allowlisted/)
    expect(validateSdp('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n')).toContain('m=audio')
    expect(() => validateSdp('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n')).toThrow(/recvonly/)
    expect(() => validateSdp('v=0\r\na=sendonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toThrow(/recvonly/)
    expect(() => validateSdp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n')).toThrow(/invalid SDP/)
    expect(parseRtcCallId('https://api.openai.com/v1/realtime/calls/rtc_abc-123')).toBe('rtc_abc-123')
    expect(() => parseRtcCallId('/v1/realtime/calls/call_abc')).toThrow(/invalid call location/)
  })

  it('parses the official function-arguments event and rejects extra tool names', () => {
    expect(parseFunctionCall({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'dsh_turn', arguments: '{"prompt":"x"}' }))
      .toEqual({ callId: 'c1', name: 'dsh_turn', arguments: '{"prompt":"x"}' })
    expect(() => parseFunctionCall({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'shell', arguments: '{}' })).toThrow(/unsupported/)
  })
})

describe('OpenAI Realtime lifecycle with client mocks', () => {
  const oldKey = process.env['OPENAI_API_KEY']
  beforeEach(() => { process.env['OPENAI_API_KEY'] = 'test-key' })
  afterEach(() => { if (oldKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = oldKey })

  it('passes a configured timeout signal and converts timeout failure to a safe error', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    const fetchMock: typeof fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('secret provider detail')), { once: true })
    }))
    const service = new OpenAiRealtimeVoiceService(ctx, { httpTimeoutMs: 100 }, { fetch: fetchMock, openSideband: vi.fn() })
    await expect(service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' })).rejects.toThrow('voice: provider call creation failed')
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }))
  })

  it('returns the answer before sideband opens, then reports ready', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    const opening = deferred<WebSocket>(); let requestInit: RequestInit | undefined
    const dependencies: RuntimeDependencies = {
      fetch: vi.fn((_url, init) => { requestInit = init; return Promise.resolve(response()) }),
      openSideband: vi.fn(() => opening.promise),
    }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30 }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' })
    expect(await service.status(agent, started.sessionId)).toMatchObject({ state: 'connecting', sidebandReady: false })
    expect(requestInit).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal)
    expect((requestInit?.headers as Record<string, string>)['OpenAI-Safety-Identifier']).toMatch(/^dsh_[a-f0-9]{32}$/)
    const form = requestInit?.body as FormData
    const definition = JSON.parse(String(form.get('session'))) as Record<string, unknown> & { instructions: string; tools: Array<{ name: string; parameters: object }> }
    expect(definition).toMatchObject({
      max_response_output_tokens: 768, output_modalities: ['audio'],
      audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
    })
    expect(definition.instructions).toContain('максимум 45 слов')
    expect(definition.instructions).toContain('полный ответ доступен на экране')
    expect(definition.instructions).not.toContain('БРО')
    expect(JSON.stringify(definition.tools)).not.toContain('БРО')
    expect(definition.tools.map(tool => tool.name)).not.toContain('cancel_turn')
    expect(definition.tools.find(tool => tool.name === 'dsh_turn')?.parameters).toMatchObject({ required: ['prompt', 'mode'], properties: { mode: { enum: ['followup', 'steer'] } } })
    const socket = new MockSocket(); opening.resolve(socket as unknown as WebSocket); await tick()
    expect(await service.status(agent, started.sessionId)).toMatchObject({ state: 'active', sidebandReady: true })
    await service.stop(agent, started.sessionId)
  })

  it('deduplicates call ids and serializes one function output', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    const socket = new MockSocket()
    const dependencies: RuntimeDependencies = { fetch: vi.fn(() => Promise.resolve(response())), openSideband: vi.fn(() => Promise.resolve(socket as unknown as WebSocket)) }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30 }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' }); await tick()
    const event = Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'same', name: 'get_voice_status', arguments: '{}' }))
    socket.emit('message', event); socket.emit('message', event); await tick()
    expect(socket.sent).toHaveLength(2)
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'conversation.item.create', item: { call_id: 'same' } })
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'response.create' })
    await service.stop(agent, started.sessionId)
  })

  it('does not expose assistant history from before the voice session', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    ;(agent.session.events as unknown as unknown[]).push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'private pre-call answer' }] } } })
    const socket = new MockSocket()
    const dependencies: RuntimeDependencies = { fetch: vi.fn(() => Promise.resolve(response())), openSideband: vi.fn(() => Promise.resolve(socket as unknown as WebSocket)) }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30 }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' }); await tick()
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'status', name: 'get_voice_status', arguments: '{}' })))
    await tick()
    const status = socket.sent.map(value => JSON.parse(value) as { item?: { output?: string } }).find(value => value.item?.output !== undefined)
    expect(JSON.parse(status?.item?.output ?? '{}')).toMatchObject({ agent: { lastAssistantText: '' } })
    expect(status?.item?.output).not.toContain('private pre-call answer')
    await service.stop(agent, started.sessionId)
  })

  it('reports active chat work and lets explicitly enabled replacement bypass a waiting follow-up', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    Object.defineProperty(agent, 'status', { configurable: true, get: () => 'running' })
    const idle = deferred<void>(); agent.whenIdle = () => idle.promise
    const socket = new MockSocket()
    const dependencies: RuntimeDependencies = { fetch: vi.fn(() => Promise.resolve(response())), openSideband: vi.fn(() => Promise.resolve(socket as unknown as WebSocket)) }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30, allowDestructiveVoiceActions: true }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' }); await tick()
    const emit = (callId: string, name: string, args: object) => {
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: callId, name, arguments: JSON.stringify(args) })))
    }
    emit('queued', 'dsh_turn', { prompt: 'сделай следующим', mode: 'followup' }); await tick()
    emit('wait', 'wait_for_agent', {}); await tick()
    expect(socket.sent.some(value => (JSON.parse(value) as { item?: { call_id?: string } }).item?.call_id === 'wait')).toBe(false)
    emit('steering', 'dsh_turn', { prompt: 'уточни текущий результат', mode: 'steer' })
    emit('status', 'get_voice_status', {}); await tick()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const statusEvent = socket.sent.map(value => JSON.parse(value) as { item?: { call_id?: string; output?: string } })
      .find(value => value.item?.call_id === 'status')
    expect(JSON.parse(statusEvent?.item?.output ?? '{}')).toMatchObject({ agent: { status: 'running', queuedTurns: 0, pendingSteers: 0 } })
    emit('replacement', 'dsh_turn', { prompt: 'останови и сделай иначе', mode: 'replace' }); await tick()
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(agent.followup).toHaveBeenCalledTimes(2)
    expect(vi.mocked(agent.cancel).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(agent.followup).mock.invocationCallOrder[1]!)
    idle.resolve(undefined); await tick(); await tick()
    expect(socket.sent.some(value => (JSON.parse(value) as { item?: { call_id?: string } }).item?.call_id === 'wait')).toBe(true)
    await service.stop(agent, started.sessionId)
  })

  it('rejects late steering when the Agent is already idle', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    const socket = new MockSocket()
    const dependencies: RuntimeDependencies = { fetch: vi.fn(() => Promise.resolve(response())), openSideband: vi.fn(() => Promise.resolve(socket as unknown as WebSocket)) }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30 }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' }); await tick()
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'late', name: 'dsh_turn', arguments: '{"prompt":"уточнение","mode":"steer"}' })))
    await tick()
    expect(agent.steer).not.toHaveBeenCalled(); expect(agent.followup).not.toHaveBeenCalled()
    const event = socket.sent.map(value => JSON.parse(value) as { item?: { output?: string } }).find(value => value.item?.output !== undefined)
    expect(JSON.parse(event?.item?.output ?? '{}')).toMatchObject({ accepted: false, disposition: 'agent_idle' })
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'ordinary', name: 'dsh_turn', arguments: '{"prompt":"объясни слово БРО","mode":"followup"}' })))
    await tick()
    expect(agent.followup).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: 'объясни слово БРО' }] }))
    await service.stop(agent, started.sessionId)
  })

  it('stops promptly while wait_for_agent remains blocked on an Agent approval', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    const idle = deferred<void>(); agent.whenIdle = () => idle.promise
    const socket = new MockSocket()
    const dependencies: RuntimeDependencies = { fetch: vi.fn(() => Promise.resolve(response())), openSideband: vi.fn(() => Promise.resolve(socket as unknown as WebSocket)) }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30 }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' }); await tick()
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'turn', name: 'dsh_turn', arguments: '{"prompt":"бро, БРО — сделай","mode":"followup"}' })))
    await tick()
    expect(agent.followup).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: 'сделай' }] }))
    socket.sent.splice(0)
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'waiting', name: 'wait_for_agent', arguments: '{}' })))
    await tick(); expect(socket.sent).toHaveLength(0)
    await expect(Promise.race([
      service.stop(agent, started.sessionId).then(() => 'stopped'),
      new Promise<string>(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])).resolves.toBe('stopped')
    expect(socket.sent).toHaveLength(0)
    idle.resolve(undefined); await tick()
    expect(socket.sent).toHaveLength(0)
  })

  it('removes the logical session after bounded activation failure', async () => {
    const ctx = new Context(); const registry = new AgentRegistry(ctx); const agent = createAgent(ctx); registry.register(agent)
    const dependencies: RuntimeDependencies = { fetch: vi.fn(() => Promise.resolve(response())), openSideband: vi.fn(() => Promise.reject(new Error('private body'))) }
    const service = new OpenAiRealtimeVoiceService(ctx, { maxSessionSeconds: 30, activationAttempts: 1 }, dependencies)
    const started = await service.start(agent, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' }); await tick()
    await expect(service.status(agent, started.sessionId)).rejects.toThrow('session not found')
  })
})
