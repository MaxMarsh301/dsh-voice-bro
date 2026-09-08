import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { VoiceConsumerId, type VoiceCreationId } from '@deepseek-ai/dsh-voice'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import OpenAiRealtimeVoiceService, {
  parseFunctionCall, parseRtcCallId, resolveConfig, validateSdp,
} from '../src/index.ts'
import type { RuntimeDependencies } from '../src/index.ts'

class MockSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  readonly sent: string[] = []
  pings = 0
  send(value: string): void { this.sent.push(value) }
  ping(): void { this.pings += 1 }
  terminate(): void { this.close() }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close', 1000) }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

interface World {
  ctx: Context
  registry: AgentRegistry
  agents: Map<string, Agent>
  records: Array<{ header: SessionHeader; live: boolean; persisted: boolean }>
  lookup: ReturnType<typeof vi.fn>
  query: {
    listSessions: ReturnType<typeof vi.fn>
    searchSessions: ReturnType<typeof vi.fn>
    readTitleSnapshots: ReturnType<typeof vi.fn>
    readTitle: ReturnType<typeof vi.fn>
    readSurface: ReturnType<typeof vi.fn>
  }
}

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 10, cwd: `/work/${id}`, ...extra }
}

function createWorld(): World {
  const ctx = new Context(); const registry = new AgentRegistry(ctx)
  const agents = new Map<string, Agent>()
  const records = [
    { header: header('ordinary'), live: true, persisted: true },
    { header: header('cold'), live: false, persisted: true },
    { header: header('child', { origin: 'subagent', parentSession: SessionId('ordinary') }), live: true, persisted: true },
  ]
  const query = {
    listSessions: vi.fn(async () => records),
    searchSessions: vi.fn(async () => ({ items: records.slice(0, 1).map(record => ({ ...record, bestMatch: { snippet: 'strong match' } })) })),
    readTitleSnapshots: vi.fn(async (ids: SessionId[]) => ids.map((id, index) => ({ sessionId: id, status: 'fulfilled', value: { session: records.find(record => record.header.id === id)!.header, title: { title: `Title ${String(id)}`, messageSeqs: [], source: { kind: 'user' }, eventSeq: index, updatedAt: 100 + index } } }))),
    readTitle: vi.fn(async (id: SessionId) => ({ title: `Title ${String(id)}`, messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 100 })),
    readSurface: vi.fn(async (id: SessionId) => ({
      session: records.find(record => record.header.id === id)!.header,
      capturedThroughSeq: 4,
      events: [
        { type: 'user/message', seq: 1, time: 20, data: { id: 'u' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } },
        { type: 'assistant/message', seq: 2, time: 30, data: { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'answer' }] }) } },
      ],
    })),
  }
  const lookup = vi.fn(async (id: SessionId) => agents.get(id))
  ctx.provide('sessionQuery', query as never)
  ctx.provide('typert', {
    lookups: {
      get: (key: string) => key === 'agent' ? { resolve: lookup } : undefined,
      register: vi.fn(() => () => {}),
    },
    contexts: { registerHost: vi.fn(() => () => {}) },
  } as never)
  return { ctx, registry, agents, records, lookup, query }
}

function createAgent(world: World, id = 'ordinary', status: 'idle' | 'running' = 'idle'): Agent {
  const sessionId = SessionId(id); const events: SessionEvent[] = []
  let currentStatus = status
  const agent = {
    id: sessionId, options: {}, get status() { return currentStatus }, set status(value) { currentStatus = value }, ctx: world.ctx,
    inbox: { nextTurn: [], nextStep: [] } as unknown as Agent['inbox'],
    session: { id: sessionId, header: world.records.find(record => record.header.id === sessionId)?.header ?? header(id), events } as unknown as Agent['session'],
    cancel: vi.fn(), whenIdle: vi.fn(() => Promise.resolve()), runMaintenance: vi.fn(), send: vi.fn(), followup: vi.fn(), steer: vi.fn(), inject: vi.fn(),
  } as unknown as Agent
  world.registry.register(agent); world.agents.set(id, agent)
  return agent
}

function response(): Response {
  return new Response('v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n', { status: 201, headers: { location: '/v1/realtime/calls/rtc_test_123' } })
}

function dependencies(socket: MockSocket | Promise<WebSocket> = new MockSocket()): RuntimeDependencies {
  return {
    fetch: vi.fn(() => Promise.resolve(response())),
    openSideband: vi.fn(() => socket instanceof Promise ? socket : Promise.resolve(socket as unknown as WebSocket)),
  }
}

const startRequest = {
  sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
  consumerId: VoiceConsumerId('tab-one'),
  foregroundSessionId: SessionId('ordinary'),
}

async function tick(): Promise<void> { await new Promise(resolve => setImmediate(resolve)) }
function emitTool(socket: MockSocket, callId: string, name: string, args: object, responseId = 'response-1'): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done', response_id: responseId,
    call_id: callId, name, arguments: JSON.stringify(args),
  })))
}
async function claimResponse(
  service: OpenAiRealtimeVoiceService,
  sessionId: Awaited<ReturnType<OpenAiRealtimeVoiceService['start']>>['sessionId'],
  socket: MockSocket,
  responseId = 'response-1',
  epoch = 'epoch-1',
): Promise<void> {
  await service.claimResponseEpoch(sessionId, epoch as never)
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId, metadata: { dsh_response_epoch: epoch } },
  })))
}
function output(socket: MockSocket, callId: string): Record<string, unknown> | undefined {
  const event = socket.sent.map(value => JSON.parse(value) as { item?: { call_id?: string; output?: string } })
    .find(value => value.item?.call_id === callId)
  return event?.item?.output === undefined ? undefined : JSON.parse(event.item.output) as Record<string, unknown>
}
function append(world: World, agent: Agent, event: SessionEvent): void {
  ;(agent.session.events as SessionEvent[]).push(event)
  world.ctx.emit('session/event', agent.session, event)
}

describe('OpenAI Realtime global voice validation', () => {
  it('applies strict defaults, bounds, SDP checks, and global tool names', () => {
    expect(resolveConfig()).toMatchObject({
      model: 'gpt-realtime-2.1-mini', transcriptionModel: 'gpt-4o-mini-transcribe', voice: 'cedar',
      maxSessionSeconds: 3300, maxResponseOutputTokens: 768, sidebandPingIntervalMs: 30_000,
      navigationAckTimeoutMs: 5_000, creationAckTimeoutMs: 30_000,
    })
    expect(() => resolveConfig({ maxSessionSeconds: 3301 })).toThrow(/maxSessionSeconds/)
    expect(() => resolveConfig({ navigationAckTimeoutMs: 99 })).toThrow(/navigationAckTimeoutMs/)
    expect(() => resolveConfig({ creationAckTimeoutMs: 120_001 })).toThrow(/creationAckTimeoutMs/)
    expect(() => resolveConfig({ sidebandPingIntervalMs: 4_999 })).toThrow(/sidebandPingIntervalMs/)
    expect(resolveConfig({ proxyURL: 'http://127.0.0.1:8888' }).proxyURL).toBe('http://127.0.0.1:8888/')
    expect(() => resolveConfig({ proxyURL: 'socks5://127.0.0.1:1080' })).toThrow(/absolute HTTP URL/)
    expect(() => resolveConfig({ proxyURL: 'http://user:secret@127.0.0.1:8888' })).toThrow(/without credentials/)
    expect(() => resolveConfig({ model: 'other' as never })).toThrow(/allowlisted/)
    expect(validateSdp(startRequest.sdp)).toContain('m=audio')
    expect(() => validateSdp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n')).toThrow(/invalid SDP/)
    expect(parseRtcCallId('https://api.openai.com/v1/realtime/calls/rtc_abc-123')).toBe('rtc_abc-123')
    expect(() => parseRtcCallId('/v1/realtime/calls/call_abc')).toThrow(/invalid call location/)
    expect(parseFunctionCall({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', name: 'thread_turn', arguments: '{}' }))
      .toEqual({ callId: 'c1', responseId: 'r1', name: 'thread_turn', arguments: '{}' })
    expect(() => parseFunctionCall({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', name: 'shell', arguments: '{}' })).toThrow(/unsupported/)
  })
})

describe('OpenAI Realtime global lifecycle and tools', () => {
  const oldKey = process.env['OPENAI_API_KEY']
  beforeEach(() => { process.env['OPENAI_API_KEY'] = 'test-key' })
  afterEach(() => { if (oldKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = oldKey })

  it('holds one global lease, returns before sideband opens, and tracks foreground', async () => {
    const world = createWorld(); createAgent(world)
    const opening = deferred<WebSocket>(); let requestInit: RequestInit | undefined
    const deps: RuntimeDependencies = {
      fetch: vi.fn((_url, init) => { requestInit = init; return Promise.resolve(response()) }),
      openSideband: vi.fn(() => opening.promise),
    }
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, deps)
    const overlapping = new OpenAiRealtimeVoiceService(world.ctx.isolate('voice'), { maxSessionSeconds: 30 }, deps)
    const started = await service.start(startRequest)
    await expect(service.start({ ...startRequest, consumerId: VoiceConsumerId('tab-two') })).rejects.toThrow(/global session/)
    await expect(overlapping.start({ ...startRequest, consumerId: VoiceConsumerId('tab-three') })).rejects.toThrow(/global session/)
    expect(await service.status(started.sessionId)).toMatchObject({ state: 'connecting', sidebandReady: false, foregroundSessionId: SessionId('ordinary') })
    expect((requestInit?.headers as Record<string, string>)['OpenAI-Safety-Identifier']).toMatch(/^dsh_[a-f0-9]{32}$/)
    const definition = JSON.parse(String((requestInit?.body as FormData).get('session'))) as { model: string; instructions: string; tools: Array<{ name: string }> }
    expect(definition.model).toBe('gpt-realtime-2.1-mini')
    expect(definition.instructions).toContain('глобальная голосовая оболочка')
    expect(definition.instructions).toContain('create_thread создаёт Session через обычный браузерный путь')
    expect(definition.instructions).toContain('если возвращено confirmation_required')
    expect(definition.tools.map(tool => tool.name)).toEqual(['find_threads', 'read_thread', 'create_thread', 'switch_thread', 'thread_turn', 'wait_for_thread', 'cancel_thread', 'get_voice_status'])
    const socket = new MockSocket(); opening.resolve(socket as unknown as WebSocket); await tick()
    expect(await service.status(started.sessionId)).toMatchObject({ state: 'active', sidebandReady: true })
    await expect(service.setForeground(started.sessionId, SessionId('cold'))).resolves.toMatchObject({ foregroundSessionId: SessionId('cold') })
    await service.stop(started.sessionId)
  })

  it('keeps an idle sideband alive and releases its heartbeat on stop', async () => {
    const world = createWorld(); const socket = new MockSocket()
    let heartbeat: (() => void) | undefined
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout
    const deps: RuntimeDependencies = {
      ...dependencies(socket),
      setInterval: vi.fn((callback) => { heartbeat = callback; return timer }),
      clearInterval: vi.fn(),
    }
    const service = new OpenAiRealtimeVoiceService(world.ctx, {
      maxSessionSeconds: 30,
      sidebandPingIntervalMs: 5_000,
    }, deps)
    const started = await service.start(startRequest); await tick()

    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 5_000)
    expect(timer.unref).toHaveBeenCalledOnce()
    expect(heartbeat).toBeTypeOf('function')
    heartbeat?.()
    expect(socket.pings).toBe(1)

    await service.stop(started.sessionId)
    expect(deps.clearInterval).toHaveBeenCalledWith(timer)
    heartbeat?.()
    expect(socket.pings).toBe(1)
  })

  it('routes call creation through the configured HTTP proxy dispatcher', async () => {
    const world = createWorld(); createAgent(world)
    let requestInit: RequestInit | undefined
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      requestInit = init
      return Promise.resolve(response())
    })
    const service = new OpenAiRealtimeVoiceService(world.ctx, {
      maxSessionSeconds: 30,
      activationAttempts: 1,
      proxyURL: 'http://127.0.0.1:9',
    })
    const started = await service.start(startRequest)
    expect(requestInit).toHaveProperty('dispatcher')
    await service.stop(started.sessionId)
    fetch.mockRestore()
  })

  it('replaces an orphaned call when the same browser tab reconnects', async () => {
    const world = createWorld()
    const firstSocket = new MockSocket(); const secondSocket = new MockSocket()
    const deps = dependencies()
    ;(deps.openSideband as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(firstSocket as unknown as WebSocket)
      .mockResolvedValueOnce(secondSocket as unknown as WebSocket)
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, deps)
    const first = await service.start(startRequest); await tick()

    const replacement = await service.start(startRequest); await tick()

    expect(firstSocket.readyState).toBe(WebSocket.CLOSED)
    expect(replacement.sessionId).not.toBe(first.sessionId)
    await expect(service.status(first.sessionId)).rejects.toThrow('session not found')
    await expect(service.status(replacement.sessionId)).resolves.toMatchObject({ state: 'active', sidebandReady: true })
    await service.stop(replacement.sessionId)
  })

  it('serializes a same-tab reconnect behind pending call creation', async () => {
    const world = createWorld()
    const creation = deferred<Response>()
    const firstSocket = new MockSocket(); const secondSocket = new MockSocket()
    const deps: RuntimeDependencies = {
      fetch: vi.fn()
        .mockImplementationOnce(() => creation.promise)
        .mockResolvedValueOnce(response()),
      openSideband: vi.fn()
        .mockResolvedValueOnce(firstSocket as unknown as WebSocket)
        .mockResolvedValueOnce(secondSocket as unknown as WebSocket),
    }
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, deps)
    const firstStart = service.start(startRequest)
    const replacementStart = service.start(startRequest)
    await tick()
    expect(deps.fetch).toHaveBeenCalledTimes(1)

    creation.resolve(response())
    const first = await firstStart
    const replacement = await replacementStart; await tick()

    expect(deps.fetch).toHaveBeenCalledTimes(2)
    expect(firstSocket.readyState).toBe(WebSocket.CLOSED)
    expect(replacement.sessionId).not.toBe(first.sessionId)
    await service.stop(replacement.sessionId)
  })

  it('waits for a stopping global lease before accepting its replacement', async () => {
    const world = createWorld()
    const opening = deferred<WebSocket>()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(opening.promise))
    const started = await service.start(startRequest)
    const stopping = service.stop(started.sessionId)
    const replacement = service.start({ ...startRequest, consumerId: VoiceConsumerId('tab-two') })
    let replaced = false
    void replacement.then(() => { replaced = true })
    await tick()
    expect(replaced).toBe(false)

    opening.resolve(new MockSocket() as unknown as WebSocket)
    await stopping
    const next = await replacement
    expect(next.sessionId).not.toBe(started.sessionId)
    await service.stop(next.sessionId)
  })

  it('reactivates a Cordis-restored provider through the live Service proxy', async () => {
    const world = createWorld(); const socket = new MockSocket()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const lifecycle = service as unknown as { closing: boolean; startAbort: AbortController }
    lifecycle.closing = true; lifecycle.startAbort.abort()
    const proxied = world.ctx.get('voice') as OpenAiRealtimeVoiceService
    const started = await proxied.start(startRequest); await tick()
    expect(await proxied.status(started.sessionId)).toMatchObject({ state: 'active', sidebandReady: true })
    await proxied.stop(started.sessionId)
  })

  it('converts call-creation transport failure to a safe error and releases the lease', async () => {
    const world = createWorld(); const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('private provider detail')))
    const service = new OpenAiRealtimeVoiceService(world.ctx, { httpTimeoutMs: 100 }, { fetch: fetchMock, openSideband: vi.fn() })
    await expect(service.start(startRequest)).rejects.toThrow('voice: provider call creation failed')
    await expect(service.start(startRequest)).rejects.toThrow('voice: provider call creation failed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates calls and exposes bounded thread discovery and reads without Agent lookup', async () => {
    const world = createWorld(); createAgent(world)
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    emitTool(socket, 'find', 'find_threads', { query: '', state: 'all', limit: 3 })
    emitTool(socket, 'read', 'read_thread', { session_id: 'ordinary', max_messages: 2 })
    emitTool(socket, 'status', 'get_voice_status', {}); emitTool(socket, 'status', 'get_voice_status', {})
    await tick(); await tick()
    expect(output(socket, 'find')).toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ session_id: 'ordinary', kind: 'ordinary' })]) })
    expect((output(socket, 'find')?.threads as Array<{ session_id: string }>).some(thread => thread.session_id === 'child')).toBe(false)
    expect(output(socket, 'read')).toMatchObject({ session_id: 'ordinary', title: 'Title ordinary', messages: [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }] })
    expect(output(socket, 'status')).toMatchObject({ foreground_session_id: 'ordinary' })
    expect(world.lookup).not.toHaveBeenCalled()
    expect(socket.sent.filter(value => (JSON.parse(value) as { item?: { call_id?: string } }).item?.call_id === 'status')).toHaveLength(1)
    await service.stop(started.sessionId)
  })

  it('creates a named Session through the owning browser and commits foreground only after acknowledgement', async () => {
    const world = createWorld(); const socket = new MockSocket()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30, navigationAckTimeoutMs: 1_000 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    const requests: Array<{ creationId: string; activationTimeoutMs: number; title?: string }> = []
    world.ctx.on('voice/creation-requested', (request) => {
      requests.push(request)
      world.records.push({ header: header('fresh'), live: true, persisted: true })
      void service.ackCreation(started.sessionId, {
        creationId: request.creationId,
        created: true,
        activated: true,
        sessionId: SessionId('fresh'),
      })
    })

    emitTool(socket, 'create', 'create_thread', { title: 'Roadmap' })
    await tick(); await tick()

    expect(requests).toEqual([expect.objectContaining({ title: 'Roadmap', activationTimeoutMs: 30_000 })])
    expect(output(socket, 'create')).toMatchObject({ created: true, activated: true, session_id: 'fresh', title: 'Roadmap' })
    expect(await service.status(started.sessionId)).toMatchObject({ foregroundSessionId: SessionId('fresh') })
    await service.stop(started.sessionId)
  })

  it('keeps creation waiting beyond the shorter navigation acknowledgement deadline', async () => {
    const world = createWorld(); const socket = new MockSocket()
    const service = new OpenAiRealtimeVoiceService(world.ctx, {
      maxSessionSeconds: 30,
      navigationAckTimeoutMs: 100,
      creationAckTimeoutMs: 1_000,
    }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    world.ctx.on('voice/creation-requested', (request) => {
      setTimeout(() => {
        world.records.push({ header: header('delayed'), live: true, persisted: true })
        void service.ackCreation(started.sessionId, {
          creationId: request.creationId,
          created: true,
          activated: true,
          sessionId: SessionId('delayed'),
        })
      }, 150)
    })

    emitTool(socket, 'create-delayed', 'create_thread', { title: 'Delayed' })
    await new Promise(resolve => setTimeout(resolve, 180)); await tick()

    expect(output(socket, 'create-delayed')).toMatchObject({
      created: true,
      activated: true,
      session_id: 'delayed',
    })
    await service.stop(started.sessionId)
  })

  it('does not report creation failure when the browser acknowledgement times out', async () => {
    const world = createWorld(); const socket = new MockSocket()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30, creationAckTimeoutMs: 100 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    let creationId: VoiceCreationId | undefined
    world.ctx.on('voice/creation-requested', (request) => { creationId = request.creationId })

    emitTool(socket, 'create-timeout', 'create_thread', { title: 'Slow' })
    await new Promise(resolve => setTimeout(resolve, 120)); await tick()

    expect(output(socket, 'create-timeout')).toEqual({ disposition: 'outcome_unknown', title: 'Slow' })
    if (creationId === undefined) throw new Error('creation request was not emitted')
    world.records.push({ header: header('late'), live: true, persisted: true })
    const acknowledgement = {
      creationId,
      created: true,
      activated: true,
      sessionId: SessionId('late'),
    }
    await expect(service.ackCreation(started.sessionId, acknowledgement)).resolves.toMatchObject({ acknowledged: true })
    await expect(service.ackCreation(started.sessionId, acknowledgement)).resolves.toMatchObject({ acknowledged: true })
    await expect(service.ackCreation(started.sessionId, { ...acknowledgement, activated: false }))
      .rejects.toThrow(/conflicting creation acknowledgement/)
    expect(await service.status(started.sessionId)).toMatchObject({ foregroundSessionId: SessionId('late') })
    await service.stop(started.sessionId)
  })

  it('requires confirmation for an ambiguous title and switches only after an exact chosen id is acknowledged', async () => {
    const world = createWorld(); const socket = new MockSocket()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30, navigationAckTimeoutMs: 1_000 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    const navigations: Array<{ navigationId: string; sessionId: SessionId }> = []
    world.ctx.on('voice/navigation-requested', (request) => {
      navigations.push(request)
      void service.ackNavigation(started.sessionId, { navigationId: request.navigationId, activated: true })
    })

    emitTool(socket, 'ambiguous', 'switch_thread', { query: 'Title', session_id: '' })
    await tick(); await tick()
    expect(output(socket, 'ambiguous')).toMatchObject({ activated: false, disposition: 'confirmation_required' })
    expect(navigations).toEqual([])
    expect(await service.status(started.sessionId)).toMatchObject({ foregroundSessionId: SessionId('ordinary') })

    emitTool(socket, 'chosen', 'switch_thread', { session_id: 'cold' })
    await tick(); await tick()
    expect(output(socket, 'chosen')).toMatchObject({ session_id: 'cold', activated: true, disposition: 'activated' })
    expect(navigations).toHaveLength(1)
    expect(await service.status(started.sessionId)).toMatchObject({ foregroundSessionId: SessionId('cold') })
    await service.stop(started.sessionId)
  })

  it('finds a thread by title when full-text search is disabled', async () => {
    const world = createWorld()
    world.query.searchSessions.mockRejectedValue(new SessionQueryError(
      'session search is disabled',
      'SESSION_QUERY_SEARCH_DISABLED',
    ))
    const socket = new MockSocket()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)

    emitTool(socket, 'find-title', 'find_threads', { query: 'title COLD', state: 'all', limit: 3 })
    await tick(); await tick()

    expect(output(socket, 'find-title')).toMatchObject({
      threads: [{ session_id: 'cold', title: 'Title cold', kind: 'ordinary' }],
      has_more: false,
    })
    expect(world.query.searchSessions).toHaveBeenCalledWith({ query: 'title COLD', limit: 10 })
    await service.stop(started.sessionId)
  })

  it('orders recent threads by last activity before applying limit and state pagination', async () => {
    const world = createWorld()
    world.records.splice(0, world.records.length,
      { header: header('new-created', { createdAt: 300 }), live: false, persisted: true },
      { header: header('middle-created', { createdAt: 200 }), live: false, persisted: true },
      { header: header('old-active', { createdAt: 100 }), live: true, persisted: true },
    )
    createAgent(world, 'old-active', 'running')
    world.query.readSurface.mockImplementation(async (id: SessionId) => ({
      session: world.records.find(record => record.header.id === id)!.header,
      capturedThroughSeq: 1,
      events: [{ type: 'turn/end', seq: 0, time: id === 'old-active' ? 900 : id === 'middle-created' ? 500 : 400, data: { turn: 1, reason: { kind: 'completed' } } }],
    }))
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)

    emitTool(socket, 'recent', 'find_threads', { query: '', state: 'all', limit: 2 })
    emitTool(socket, 'running', 'find_threads', { query: '', state: 'running', limit: 2 })
    await tick(); await tick()

    expect(output(socket, 'recent')).toMatchObject({
      threads: [{ session_id: 'old-active' }, { session_id: 'middle-created' }],
      has_more: true,
    })
    expect(output(socket, 'running')).toMatchObject({ threads: [{ session_id: 'old-active', running: true }], has_more: false })
    await service.stop(started.sessionId)
  })

  it('routes a cold ordinary request, correlates MessageId to turn/end, navigates, and narrates that turn only', async () => {
    const world = createWorld(); const cold = createAgent(world, 'cold')
    const idle = deferred<void>(); cold.whenIdle = vi.fn(() => idle.promise)
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30, navigationAckTimeoutMs: 1_000 }, dependencies(socket))
    const navigations: Array<{ navigationId: string; sessionId: string; reason: string }> = []
    world.ctx.on('voice/navigation-requested', (request) => { navigations.push(request) })
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    emitTool(socket, 'turn', 'thread_turn', { session_id: 'cold', prompt: 'БРО, проверь архитектуру', mode: 'followup', reveal: 'on-complete' }); await tick()
    const accepted = output(socket, 'turn') as { request_id: string; disposition: string }
    expect(accepted).toMatchObject({ disposition: 'started' })
    expect(world.lookup).toHaveBeenCalledWith(SessionId('cold'))
    const message = vi.mocked(cold.followup).mock.calls[0]![0]
    expect(message.content).toEqual([{ type: 'text', text: 'проверь архитектуру' }])
    await claimResponse(service, started.sessionId, socket, 'response-2', 'epoch-1')
    emitTool(socket, 'wait', 'wait_for_thread', { request_id: accepted.request_id }, 'response-2'); await tick()
    expect(output(socket, 'wait')).toBeUndefined()

    append(world, cold, { type: 'turn/start', seq: 0, time: 1, data: { turn: 7 } })
    append(world, cold, { type: 'user/message', seq: 1, time: 2, data: message })
    const unrelated = createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'wrong turn' }] })
    append(world, cold, { type: 'assistant/message', seq: 2, time: 3, data: { turn: 6, step: 1, message: unrelated } })
    const answer = createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'exact answer' }] })
    append(world, cold, { type: 'assistant/message', seq: 3, time: 4, data: { turn: 7, step: 1, message: answer } })
    append(world, cold, { type: 'turn/end', seq: 4, time: 5, data: { turn: 7, reason: { kind: 'completed' } } })
    await tick()
    expect(navigations).toHaveLength(1)
    expect(navigations[0]).toMatchObject({ sessionId: 'cold', reason: 'response-ready' })
    await service.ackNavigation(started.sessionId, { navigationId: navigations[0]!.navigationId as never, activated: true })
    await tick(); await tick()
    expect(output(socket, 'wait')).toMatchObject({ request_id: accepted.request_id, session_id: 'cold', state: 'completed', text: 'exact answer', activated: true })
    expect((await service.status(started.sessionId)).foregroundSessionId).toBe(SessionId('cold'))
    idle.resolve(undefined); await service.stop(started.sessionId)
  })

  it('reports subagents unsupported and applies cancel to an ordinary foreground Agent', async () => {
    const world = createWorld(); const ordinary = createAgent(world, 'ordinary', 'running')
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    emitTool(socket, 'child-turn', 'thread_turn', { session_id: 'child', prompt: 'do it', mode: 'followup', reveal: 'never' })
    emitTool(socket, 'cancel', 'cancel_thread', { session_id: '' }); await tick(); await tick()
    expect(output(socket, 'child-turn')).toMatchObject({ code: 'subagent_unsupported' })
    expect(output(socket, 'cancel')).toMatchObject({ cancel_requested: true, session_id: 'ordinary' })
    expect(ordinary.cancel).toHaveBeenCalledWith({ kind: 'user' })
    await service.stop(started.sessionId)
  })

  it('reroutes a delayed completion after a newer phrase claims ownership without stale navigation', async () => {
    const world = createWorld(); const agent = createAgent(world)
    const idle = deferred<void>(); agent.whenIdle = vi.fn(() => idle.promise)
    const completions: Array<{ requestId: string; sessionId: string }> = []
    const navigations: string[] = []
    world.ctx.on('voice/completion-requested', request => { completions.push(request) })
    world.ctx.on('voice/navigation-requested', request => { navigations.push(request.sessionId) })
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    emitTool(socket, 'turn', 'thread_turn', { session_id: 'ordinary', prompt: 'сделай', mode: 'followup', reveal: 'on-complete' }); await tick()
    const requestId = (output(socket, 'turn') as { request_id: string }).request_id
    await claimResponse(service, started.sessionId, socket, 'response-2', 'epoch-1')
    socket.sent.splice(0)
    emitTool(socket, 'wait', 'wait_for_thread', { request_id: requestId }, 'response-2'); await tick()
    await service.claimResponseEpoch(started.sessionId, 'epoch-2' as never)

    const message = vi.mocked(agent.followup).mock.calls[0]![0]
    append(world, agent, { type: 'turn/start', seq: 0, time: 1, data: { turn: 8 } })
    append(world, agent, { type: 'user/message', seq: 1, time: 2, data: message })
    append(world, agent, { type: 'turn/end', seq: 2, time: 3, data: { turn: 8, reason: { kind: 'completed' } } })
    await tick(); await tick()
    expect(output(socket, 'wait')).toBeUndefined()
    expect(socket.sent.map(value => JSON.parse(value) as { type: string }).some(event => event.type === 'response.create')).toBe(false)
    expect(completions).toEqual([expect.objectContaining({ requestId, sessionId: 'ordinary' })])
    expect(navigations).toEqual([])
    expect(await service.status(started.sessionId)).toMatchObject({ state: 'active', sidebandReady: true })
    idle.resolve(undefined); await service.stop(started.sessionId)
  })

  it('tracks several Session requests independently and reports reverse-order completions on one call', async () => {
    const world = createWorld(); const ordinary = createAgent(world); const cold = createAgent(world, 'cold')
    const ordinaryIdle = deferred<void>(); const coldIdle = deferred<void>()
    ordinary.whenIdle = vi.fn(() => ordinaryIdle.promise); cold.whenIdle = vi.fn(() => coldIdle.promise)
    const completions: Array<{ requestId: string; sessionId: string }> = []
    world.ctx.on('voice/completion-requested', request => { completions.push(request) })
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket, 'response-a', 'epoch-a')
    emitTool(socket, 'turn-a', 'thread_turn', { session_id: 'ordinary', prompt: 'задача A', mode: 'followup', reveal: 'never' }, 'response-a'); await tick()
    const requestA = (output(socket, 'turn-a') as { request_id: string }).request_id

    await claimResponse(service, started.sessionId, socket, 'response-b', 'epoch-b')
    emitTool(socket, 'turn-b', 'thread_turn', { session_id: 'cold', prompt: 'задача B', mode: 'followup', reveal: 'never' }, 'response-b'); await tick()
    const requestB = (output(socket, 'turn-b') as { request_id: string }).request_id
    await service.claimResponseEpoch(started.sessionId, 'epoch-c' as never)

    const messageB = vi.mocked(cold.followup).mock.calls[0]![0]
    append(world, cold, { type: 'turn/start', seq: 0, time: 1, data: { turn: 2 } })
    append(world, cold, { type: 'user/message', seq: 1, time: 2, data: messageB })
    append(world, cold, { type: 'turn/end', seq: 2, time: 3, data: { turn: 2, reason: { kind: 'completed' } } })
    const messageA = vi.mocked(ordinary.followup).mock.calls[0]![0]
    append(world, ordinary, { type: 'turn/start', seq: 0, time: 4, data: { turn: 3 } })
    append(world, ordinary, { type: 'user/message', seq: 1, time: 5, data: messageA })
    append(world, ordinary, { type: 'turn/end', seq: 2, time: 6, data: { turn: 3, reason: { kind: 'completed' } } })
    await tick()

    expect(completions).toEqual([
      expect.objectContaining({ requestId: requestB, sessionId: 'cold' }),
      expect.objectContaining({ requestId: requestA, sessionId: 'ordinary' }),
    ])
    expect(await service.status(started.sessionId)).toMatchObject({ state: 'active' })
    ordinaryIdle.resolve(undefined); coldIdle.resolve(undefined); await service.stop(started.sessionId)
  })

  it('stops promptly while a request wait is pending and suppresses late completion output', async () => {
    const world = createWorld(); const agent = createAgent(world)
    const idle = deferred<void>(); agent.whenIdle = vi.fn(() => idle.promise)
    const socket = new MockSocket(); const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30 }, dependencies(socket))
    const started = await service.start(startRequest); await tick(); await claimResponse(service, started.sessionId, socket)
    emitTool(socket, 'turn', 'thread_turn', { session_id: 'ordinary', prompt: 'сделай', mode: 'followup', reveal: 'never' }); await tick()
    const requestId = (output(socket, 'turn') as { request_id: string }).request_id
    await claimResponse(service, started.sessionId, socket, 'response-2', 'epoch-1')
    socket.sent.splice(0); emitTool(socket, 'wait', 'wait_for_thread', { request_id: requestId }, 'response-2'); await tick()
    expect(socket.sent).toHaveLength(0)
    await expect(Promise.race([
      service.stop(started.sessionId).then(() => 'stopped'),
      new Promise<string>(resolve => setTimeout(() =>{  resolve('timed-out') }, 50)),
    ])).resolves.toBe('stopped')
    idle.resolve(undefined); await tick(); await tick()
    expect(socket.sent).toHaveLength(0)
  })

  it('removes the lease after bounded sideband activation failure', async () => {
    const world = createWorld()
    const service = new OpenAiRealtimeVoiceService(world.ctx, { maxSessionSeconds: 30, activationAttempts: 1 }, dependencies(Promise.reject(new Error('private body'))))
    const started = await service.start(startRequest); await tick()
    await expect(service.status(started.sessionId)).rejects.toThrow('session not found')
  })
})
