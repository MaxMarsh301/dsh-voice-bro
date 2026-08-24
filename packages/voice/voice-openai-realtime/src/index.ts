/** OpenAI Realtime provider for Host-owned DSH voice calls. @module @deepseek-ai/dsh-voice-openai-realtime */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import VoiceService, { VoiceSessionId } from '@deepseek-ai/dsh-voice'
import type { VoiceStartRequest, VoiceStartResult, VoiceStatusResult, VoiceStopResult } from '@deepseek-ai/dsh-voice'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
const SIDEBAND_URL = 'wss://api.openai.com/v1/realtime'
const MODELS = ['gpt-realtime-2.1'] as const
const TRANSCRIPTION_MODELS = ['gpt-4o-mini-transcribe'] as const
const VOICES = ['cedar'] as const
const MIN_SESSION_SECONDS = 30
const MAX_SESSION_SECONDS = 3300
const MAX_SDP_BYTES = 128 * 1024
const MAX_TURN_OUTPUT_BYTES = 16 * 1024
const DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS = 768
const DEFAULT_HTTP_TIMEOUT_MS = 15_000
const DEFAULT_ACTIVATION_ATTEMPTS = 5
const DEFAULT_ACTIVATION_RETRY_MS = 100

/** Provider configuration. Identifiers are restricted to reviewed OpenAI Realtime values. */
export interface Config {
  /** Allowlisted realtime model. */
  model?: typeof MODELS[number]
  /** Allowlisted input transcription model. */
  transcriptionModel?: typeof TRANSCRIPTION_MODELS[number]
  /** Allowlisted synthesized voice. */
  voice?: typeof VOICES[number]
  /** Hard lifetime for one logical call. */
  maxSessionSeconds?: number
  /** Maximum output tokens for each Realtime response, including function calls and audio. */
  maxResponseOutputTokens?: number
  /** Call-creation HTTP deadline. */
  httpTimeoutMs?: number
  /** Maximum sideband activation attempts. */
  activationAttempts?: number
  /** Delay between sideband activation attempts. */
  activationRetryMs?: number
  /** Allow voice-originated cancellation and cancel-and-replace actions. Disabled by default. */
  allowDestructiveVoiceActions?: boolean
}

/** Complete provider configuration after defaults and bounds. */
export interface ResolvedConfig {
  /** Allowlisted realtime model. */ model: typeof MODELS[number]
  /** Allowlisted transcription model. */ transcriptionModel: typeof TRANSCRIPTION_MODELS[number]
  /** Allowlisted synthesized voice. */ voice: typeof VOICES[number]
  /** Call lifetime in seconds. */ maxSessionSeconds: number
  /** Output-token cap for one Realtime response. */ maxResponseOutputTokens: number
  /** Call-creation HTTP deadline. */ httpTimeoutMs: number
  /** Sideband activation attempt cap. */ activationAttempts: number
  /** Sideband retry delay. */ activationRetryMs: number
  /** Whether voice may cancel or replace Agent work. */ allowDestructiveVoiceActions: boolean
}

/** Testable external clients; production uses global fetch and the `ws` package. */
export interface RuntimeDependencies {
  /** Fetch-compatible call creation client. */
  fetch: typeof fetch
  /** Open one authenticated sideband or reject without leaking provider details. */
  openSideband(url: string, apiKey: string, signal: AbortSignal): Promise<WebSocket>
}

interface LiveCall {
  readonly id: VoiceSessionId
  readonly agent: Agent
  readonly startedAt: number
  readonly expiresAt: number
  readonly activationAbort: AbortController
  readonly seenCallIds: Set<string>
  socket: WebSocket | undefined
  activation: Promise<void>
  dispatchTail: Promise<void>
  agentRevision: number
  resultFromEventIndex: number
  timer: NodeJS.Timeout | undefined
  state: 'connecting' | 'active' | 'stopping'
  closed: boolean
}

type ToolName = 'dsh_turn' | 'wait_for_agent' | 'cancel_turn' | 'get_voice_status'
type TurnMode = 'followup' | 'steer' | 'replace'
interface FunctionCall { callId: string; name: ToolName; arguments: string }
interface TurnRequest { prompt: string; mode: TurnMode }

/** Russian control prompt for the realtime voice shell. */
export const VOICE_CORE = `Ты — только голосовая оболочка DSH. Не добавляй к запросу служебные пояснения, мета-инструкции или слова, которых пользователь не произносил. Для любой содержательной работы, рассуждения или использования инструментов всегда сначала вызывай get_voice_status, затем dsh_turn и wait_for_agent; ожидание может длиться, пока пользователь подтверждает действия на экране. Если Agent уже работает: mode=steer корректирует текущую работу на ближайшем шаге; mode=followup ставит отдельный запрос после неё; mode=replace допустим только после явной просьбы прервать текущую работу. Если намерение неоднозначно, сначала голосом уточни: скорректировать текущую задачу, поставить следующую или прервать и заменить. Не заявляй о завершении до получения результата функции. Если требуется подтверждение, скажи, что подтверждение ожидает на экране, и жди. После результата функции произнеси по-русски максимум 45 слов в двух-трёх коротких предложениях: итог, важное ограничение или следующий шаг. Даже очень длинный ответ сожми; не зачитывай списки, код, логи и подробности, а скажи, что полный ответ доступен на экране.`

/** Resolve and validate provider configuration. @param config - raw Loader configuration. @returns complete immutable settings. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const allowed = ['model', 'transcriptionModel', 'voice', 'maxSessionSeconds', 'maxResponseOutputTokens', 'httpTimeoutMs', 'activationAttempts', 'activationRetryMs', 'allowDestructiveVoiceActions']
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new Error(`voice-openai-realtime: unknown config key "${key}"`)
  const model = config.model ?? 'gpt-realtime-2.1'
  const transcriptionModel = config.transcriptionModel ?? 'gpt-4o-mini-transcribe'
  const voice = config.voice ?? 'cedar'
  if (!(MODELS as readonly string[]).includes(model)) throw new Error('voice-openai-realtime: model is not allowlisted')
  if (!(TRANSCRIPTION_MODELS as readonly string[]).includes(transcriptionModel)) throw new Error('voice-openai-realtime: transcriptionModel is not allowlisted')
  if (!(VOICES as readonly string[]).includes(voice)) throw new Error('voice-openai-realtime: voice is not allowlisted')
  const maxSessionSeconds = boundedInteger(config.maxSessionSeconds ?? MAX_SESSION_SECONDS, MIN_SESSION_SECONDS, MAX_SESSION_SECONDS, 'maxSessionSeconds')
  const maxResponseOutputTokens = boundedInteger(config.maxResponseOutputTokens ?? DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS, 256, 4_096, 'maxResponseOutputTokens')
  const httpTimeoutMs = boundedInteger(config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 100, 120_000, 'httpTimeoutMs')
  const activationAttempts = boundedInteger(config.activationAttempts ?? DEFAULT_ACTIVATION_ATTEMPTS, 1, 20, 'activationAttempts')
  const activationRetryMs = boundedInteger(config.activationRetryMs ?? DEFAULT_ACTIVATION_RETRY_MS, 0, 5_000, 'activationRetryMs')
  const allowDestructiveVoiceActions = config.allowDestructiveVoiceActions ?? false
  if (typeof allowDestructiveVoiceActions !== 'boolean') throw new Error('voice-openai-realtime: allowDestructiveVoiceActions must be a boolean')
  return Object.freeze({ model, transcriptionModel, voice, maxSessionSeconds, maxResponseOutputTokens, httpTimeoutMs, activationAttempts, activationRetryMs, allowDestructiveVoiceActions })
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`voice-openai-realtime: ${name} must be an integer from ${min} through ${max}`)
  return value
}

/** Validate an SDP offer before any credential or network operation. @param sdp - untrusted browser offer. @returns the original SDP. */
export function validateSdp(sdp: unknown): string {
  if (typeof sdp !== 'string') throw new Error('voice: SDP offer must be a string')
  const bytes = Buffer.byteLength(sdp)
  if (bytes === 0 || bytes > MAX_SDP_BYTES) throw new Error(`voice: SDP offer must contain 1 through ${MAX_SDP_BYTES} bytes`)
  if (sdp.includes('\0') || !/^v=0(?:\r\n|\n)/.test(sdp)) throw new Error('voice: invalid SDP offer')
  const sections = sdp.replaceAll('\r\n', '\n').split('\nm=')
  const sessionDirection = /(?:^|\n)a=(sendrecv|sendonly|recvonly|inactive)(?:\n|$)/.exec(sections[0] ?? '')?.[1] ?? 'sendrecv'
  let activeAudio = 0
  for (const section of sections.slice(1)) {
    const lines = section.split('\n')
    const media = lines[0]?.split(/\s+/)
    if (media?.[0] !== 'audio' || media[1] === '0') continue
    activeAudio += 1
    const direction = lines.map(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line)?.[1]).find(value => value !== undefined) ?? sessionDirection
    if (direction !== 'recvonly') throw new Error('voice: SDP offer must keep every active audio section recvonly')
  }
  if (activeAudio === 0) throw new Error('voice: invalid SDP offer')
  return sdp
}

/** Validate a bounded SDP answer received from the provider. @param sdp - response text. @returns the original SDP. */
export function validateAnswerSdp(sdp: string): string {
  if (Buffer.byteLength(sdp) === 0 || Buffer.byteLength(sdp) > MAX_SDP_BYTES || sdp.includes('\0') || !/^v=0(?:\r\n|\n)/.test(sdp)) {
    throw new Error('voice: provider returned an invalid SDP answer')
  }
  return sdp
}

/** Parse a safe official OpenAI `rtc_` call id from Location. @param location - response Location header. @returns private provider call id. */
export function parseRtcCallId(location: string | null): string {
  if (location === null) throw new Error('voice: provider response omitted call location')
  let pathname: string
  try { pathname = new URL(location, CALLS_URL).pathname } catch { throw new Error('voice: provider returned an invalid call location') }
  const match = /^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]{1,128})$/.exec(pathname)
  if (match?.[1] === undefined) throw new Error('voice: provider returned an invalid call location')
  return match[1]
}

/** Parse one strict sideband function call event. @param input - decoded provider event. @returns validated call or undefined. */
export function parseFunctionCall(input: unknown): FunctionCall | undefined {
  if (!isRecord(input)) return undefined
  let source: Record<string, unknown> | undefined
  if (input['type'] === 'response.function_call_arguments.done') source = input
  else if (input['type'] === 'response.output_item.done' && isRecord(input['item']) && input['item']['type'] === 'function_call') source = input['item']
  if (source === undefined) return undefined
  const callId = source['call_id']; const name = source['name']; const args = source['arguments']
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) throw new Error('voice: invalid function call id')
  if (name !== 'dsh_turn' && name !== 'wait_for_agent' && name !== 'cancel_turn' && name !== 'get_voice_status') throw new Error('voice: unsupported function call')
  if (typeof args !== 'string' || Buffer.byteLength(args) > 16_384) throw new Error('voice: invalid function arguments')
  return { callId, name, arguments: args }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactObject(json: string, keys: readonly string[]): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('invalid-json') }
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error('invalid-arguments')
  return value
}
function emptyArguments(json: string): void { exactObject(json, []) }
function turnRequest(json: string): TurnRequest {
  const value = exactObject(json, ['prompt', 'mode'])
  const prompt = value['prompt']; const mode = value['mode']
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || Buffer.byteLength(prompt) > 32_768) throw new Error('invalid-prompt')
  if (mode !== 'followup' && mode !== 'steer' && mode !== 'replace') throw new Error('invalid-mode')
  const stripped = prompt.replace(/^(?:\s*БРО(?:\s*[,.:—-]?\s*))+/iu, '').trim()
  if (stripped.length === 0) throw new Error('invalid-prompt')
  return { prompt: stripped, mode }
}
function bound(text: string, maxBytes = MAX_TURN_OUTPUT_BYTES): string {
  const buffer = Buffer.from(text)
  return buffer.length <= maxBytes ? text : `${buffer.subarray(0, maxBytes - 3).toString('utf8')}…`
}
function latestAssistantText(agent: Agent, from = 0): string {
  const events = agent.session.events.slice(from)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  }
  return ''
}
function sessionDefinition(config: ResolvedConfig): Record<string, unknown> {
  const modes = config.allowDestructiveVoiceActions ? ['followup', 'steer', 'replace'] : ['followup', 'steer']
  const tools: Record<string, unknown>[] = [
    {
      type: 'function', name: 'dsh_turn',
      description: config.allowDestructiveVoiceActions
        ? 'Передать запрос текущему Agent. followup ставит отдельный Turn; steer корректирует активную работу; replace отменяет активную работу и запускает новый Turn.'
        : 'Передать безопасный запрос текущему Agent. followup ставит отдельный Turn; steer корректирует активную работу. Отмена и замена отключены владельцем DSH.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { prompt: { type: 'string' }, mode: { type: 'string', enum: modes } },
        required: ['prompt', 'mode'],
      },
    },
    { type: 'function', name: 'wait_for_agent', description: 'Дождаться полного состояния покоя Agent после отправленного запроса или уточнения; ожидание включает экранное подтверждение и последующую работу.', parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
    { type: 'function', name: 'get_voice_status', description: 'Получить состояние Realtime-сеанса и текущей работы Agent, количество ожидающих уточнений и последний текстовый ответ после голосового запроса.', parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  ]
  if (config.allowDestructiveVoiceActions) {
    tools.splice(2, 0, { type: 'function', name: 'cancel_turn', description: 'По явной просьбе пользователя отменить активную и ожидающую работу Agent.', parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } })
  }
  return {
    type: 'realtime', model: config.model,
    instructions: config.allowDestructiveVoiceActions
      ? VOICE_CORE
      : `${VOICE_CORE} В этой сессии отмена и замена работы запрещены: не проси cancel_turn и не выбирай mode=replace.`,
    max_response_output_tokens: config.maxResponseOutputTokens, output_modalities: ['audio'],
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: config.transcriptionModel }, turn_detection: null },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice },
    },
    tools, tool_choice: 'auto',
  }
}

const defaultDependencies: RuntimeDependencies = { fetch: globalThis.fetch, openSideband: openSocket }

/** OpenAI Realtime implementation of `ctx.voice`. */
export class OpenAiRealtimeVoiceService extends VoiceService {
  static inject = ['agents']
  static Config: z<Config> = z.object({
    model: z.union(MODELS.map(value => z.const(value))).default('gpt-realtime-2.1'),
    transcriptionModel: z.union(TRANSCRIPTION_MODELS.map(value => z.const(value))).default('gpt-4o-mini-transcribe'),
    voice: z.union(VOICES.map(value => z.const(value))).default('cedar'),
    maxSessionSeconds: z.number().step(1).min(MIN_SESSION_SECONDS).max(MAX_SESSION_SECONDS).default(MAX_SESSION_SECONDS),
    maxResponseOutputTokens: z.number().step(1).min(256).max(4_096).default(DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS),
    httpTimeoutMs: z.number().step(1).min(100).max(120_000).default(DEFAULT_HTTP_TIMEOUT_MS),
    activationAttempts: z.number().step(1).min(1).max(20).default(DEFAULT_ACTIVATION_ATTEMPTS),
    activationRetryMs: z.number().step(1).min(0).max(5_000).default(DEFAULT_ACTIVATION_RETRY_MS),
    allowDestructiveVoiceActions: z.boolean().default(false),
  }) as z<Config>

  private readonly config: ResolvedConfig
  private readonly dependencies: RuntimeDependencies
  private readonly calls = new Map<VoiceSessionId, LiveCall>()
  private readonly byAgent = new WeakMap<Agent, LiveCall>()
  private readonly starting = new WeakSet<Agent>()
  private closing = false

  constructor(ctx: Context, config: Config = {}, dependencies: RuntimeDependencies = defaultDependencies) {
    super(ctx); this.config = resolveConfig(config); this.dependencies = dependencies
    ctx.effect(() => async () => { this.closing = true; await Promise.all([...this.calls.values()].map(call => this.teardown(call))) }, 'voice-openai-realtime.drain')
    ctx.on('agent/disposed', ({ agent }) => { const call = this.byAgent.get(agent); if (call !== undefined) void this.teardown(call) })
  }

  /** Create WebRTC resources, publish a connecting logical call, and return before sideband activation. */
  async start(agent: Agent, request: VoiceStartRequest): Promise<VoiceStartResult> {
    this.assertLiveAgent(agent)
    if (this.closing) throw new Error('voice: service is disposing')
    if (this.byAgent.has(agent) || this.starting.has(agent)) throw new Error('voice: this agent already has an active session')
    this.starting.add(agent)
    try {
      const sdp = validateSdp(request.sdp)
      const resolved = await this.ctx.get('credentials')?.resolve(credentialRef('OPENAI_API_KEY'))
      const apiKey = resolved?.value ?? process.env['OPENAI_API_KEY']
      if (apiKey === undefined || apiKey.length === 0) throw new Error('voice: OPENAI_API_KEY is not configured')
      const form = new FormData(); form.set('sdp', sdp); form.set('session', JSON.stringify(sessionDefinition(this.config)))
      const safetyId = `dsh_${createHash('sha256').update(agent.id).digest('hex').slice(0, 32)}`
      let response: Response
      try {
        response = await this.dependencies.fetch(CALLS_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.httpTimeoutMs),
          headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': safetyId }, body: form,
        })
      } catch {
        this.ctx.logger.warn('voice: provider call creation transport failed')
        throw new Error('voice: provider call creation failed')
      }
      if (!response.ok) {
        this.ctx.logger.warn('voice: provider call creation rejected with HTTP %d', response.status)
        throw new Error('voice: provider call creation failed')
      }
      const answerSdp = validateAnswerSdp(await readBoundedText(response, MAX_SDP_BYTES))
      const rtcCallId = parseRtcCallId(response.headers.get('location'))
      if (this.closing) throw new Error('voice: service is disposing')
      this.assertLiveAgent(agent)
      const startedAt = Date.now(); const expiresAt = startedAt + this.config.maxSessionSeconds * 1000
      const call: LiveCall = {
        id: VoiceSessionId(`voice-${randomUUID()}`), agent, startedAt, expiresAt,
        activationAbort: new AbortController(), seenCallIds: new Set(), socket: undefined,
        activation: Promise.resolve(), dispatchTail: Promise.resolve(),
        agentRevision: 0, resultFromEventIndex: agent.session.events.length, timer: undefined,
        state: 'connecting', closed: false,
      }
      this.calls.set(call.id, call); this.byAgent.set(agent, call)
      call.timer = setTimeout(() => { void this.teardown(call) }, this.config.maxSessionSeconds * 1000)
      call.activation = this.activate(call, rtcCallId, apiKey).catch(async () => { await this.teardown(call, false, false) })
      return { sessionId: call.id, answerSdp, expiresAt }
    } finally {
      this.starting.delete(agent)
    }
  }

  /** Return public lifecycle facts, including whether PCM can safely flow. */
  async status(agent: Agent, sessionId: VoiceSessionId): Promise<VoiceStatusResult> {
    const call = this.owned(agent, sessionId)
    return { sessionId: call.id, state: call.state, sidebandReady: call.state === 'active', startedAt: call.startedAt, expiresAt: call.expiresAt }
  }

  /** Stop and drain an owned logical call. */
  async stop(agent: Agent, sessionId: VoiceSessionId): Promise<VoiceStopResult> {
    const call = this.owned(agent, sessionId); await this.teardown(call)
    return { sessionId, stopped: true }
  }

  private assertLiveAgent(agent: Agent): void { if (this.ctx.agents.get(agent.id) !== agent) throw new Error('voice: agent is not live') }
  private owned(agent: Agent, id: VoiceSessionId): LiveCall {
    this.assertLiveAgent(agent); const call = this.calls.get(id)
    if (call === undefined || call.agent !== agent) throw new Error('voice: session not found')
    return call
  }

  private async activate(call: LiveCall, rtcCallId: string, apiKey: string): Promise<void> {
    for (let attempt = 1; attempt <= this.config.activationAttempts; attempt += 1) {
      if (call.activationAbort.signal.aborted) throw new Error('aborted')
      try {
        const socket = await this.dependencies.openSideband(`${SIDEBAND_URL}?call_id=${encodeURIComponent(rtcCallId)}`, apiKey, call.activationAbort.signal)
        if (call.closed) { await closeSocketAndWait(socket); return }
        call.socket = socket; call.state = 'active'
        socket.on('message', data => { this.onMessage(call, data) })
        socket.once('close', () => { void this.teardown(call, false) })
        return
      } catch {
        if (attempt === this.config.activationAttempts) break
        await abortableDelay(this.config.activationRetryMs, call.activationAbort.signal)
      }
    }
    throw new Error('activation-failed')
  }

  private onMessage(call: LiveCall, data: RawData): void {
    if (call.closed) return
    let event: unknown
    try { event = JSON.parse(data.toString()) } catch { return }
    let request: FunctionCall | undefined
    try { request = parseFunctionCall(event) } catch { this.ctx.logger.warn('voice: rejected malformed provider function call'); return }
    if (request === undefined || call.seenCallIds.has(request.callId)) return
    call.seenCallIds.add(request.callId)
    void this.execute(call, request).catch(() => (
      JSON.stringify({ code: 'voice_tool_failed', message: 'Не удалось выполнить голосовую команду.' })
    )).then((output) => {
      call.dispatchTail = call.dispatchTail.then(() => {
        const socket = call.socket
        if (call.closed || socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: request.callId, output: bound(output) } }))
        socket.send(JSON.stringify({ type: 'response.create' }))
      }).catch(() => {})
    })
  }

  private async execute(call: LiveCall, request: FunctionCall): Promise<string> {
    if (request.name === 'cancel_turn') {
      emptyArguments(request.arguments)
      if (!this.config.allowDestructiveVoiceActions) throw new Error('voice: destructive actions are disabled')
      const queuedTurns = call.agent.inbox.nextTurn.length; const pendingSteers = call.agent.inbox.nextStep.length
      call.resultFromEventIndex = call.agent.session.events.length; call.agentRevision += 1
      call.agent.cancel({ kind: 'user' })
      return JSON.stringify({ cancelRequested: true, agentStatus: call.agent.status, clearedQueuedTurns: queuedTurns, clearedSteers: pendingSteers })
    }
    if (request.name === 'get_voice_status') {
      emptyArguments(request.arguments)
      return JSON.stringify({
        voice: { state: call.state, sidebandReady: call.state === 'active', expiresAt: call.expiresAt },
        agent: {
          status: call.agent.status,
          queuedTurns: call.agent.inbox.nextTurn.length,
          pendingSteers: call.agent.inbox.nextStep.length,
          lastAssistantText: bound(latestAssistantText(call.agent, call.resultFromEventIndex), 4_096),
        },
      })
    }
    if (request.name === 'wait_for_agent') {
      emptyArguments(request.arguments)
      for (;;) {
        const revision = call.agentRevision; const from = call.resultFromEventIndex
        await call.agent.whenIdle()
        if (revision !== call.agentRevision) continue
        const text = latestAssistantText(call.agent, from)
        return JSON.stringify({ state: revision === 0 ? 'idle' : 'completed', scope: 'agent-quiescence', ...(text.length === 0 ? {} : { text: bound(text) }) })
      }
    }
    const turn = turnRequest(request.arguments); const agentStatus = call.agent.status
    if (turn.mode === 'replace' && !this.config.allowDestructiveVoiceActions) throw new Error('voice: destructive actions are disabled')
    if (turn.mode === 'steer' && agentStatus === 'idle') {
      return JSON.stringify({ accepted: false, action: turn.mode, disposition: 'agent_idle', agentStatus })
    }
    call.resultFromEventIndex = call.agent.session.events.length; call.agentRevision += 1
    const message = createUserMessage({ content: [{ type: 'text', text: turn.prompt }], source: { kind: 'user' } })
    let disposition: 'started' | 'queued' | 'steered' | 'replacing'
    if (turn.mode === 'steer') { call.agent.steer(message); disposition = 'steered' }
    else if (turn.mode === 'replace') {
      call.agent.cancel({ kind: 'user' }); call.agent.followup(message); disposition = 'replacing'
    } else {
      call.agent.followup(message); disposition = agentStatus === 'idle' ? 'started' : 'queued'
    }
    return JSON.stringify({ accepted: true, action: turn.mode, disposition, agentStatus })
  }

  private async teardown(call: LiveCall, closeSocket = true, awaitActivation = true): Promise<void> {
    if (call.closed) return
    call.closed = true; call.state = 'stopping'; call.activationAbort.abort()
    if (call.timer !== undefined) clearTimeout(call.timer)
    this.calls.delete(call.id); this.byAgent.delete(call.agent)
    if (awaitActivation) await call.activation
    const socket = call.socket
    if (closeSocket && socket !== undefined && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) await closeSocketAndWait(socket)
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) throw new Error('voice: provider returned an invalid SDP answer')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > maxBytes) { await reader.cancel(); throw new Error('voice: provider returned an invalid SDP answer') }
    chunks.push(next.value)
  }
  const joined = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(joined) }
  catch { throw new Error('voice: provider returned an invalid SDP answer') }
}

function openSocket(url: string, apiKey: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    const onOpen = (): void => { cleanup(); resolve(socket) }
    const onFailure = (): void => { cleanup(); socket.close(); reject(new Error('activation failed')) }
    const onAbort = (): void => { cleanup(); socket.close(); reject(new Error('activation aborted')) }
    const cleanup = (): void => { socket.off('open', onOpen); socket.off('error', onFailure); signal.removeEventListener('abort', onAbort) }
    socket.once('open', onOpen); socket.once('error', onFailure); signal.addEventListener('abort', onAbort, { once: true })
  })
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(done, ms)
    function done(): void { signal.removeEventListener('abort', abort); resolve() }
    function abort(): void { clearTimeout(timer); reject(new Error('aborted')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
function closeSocketAndWait(socket: WebSocket): Promise<void> {
  return new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
    const timer = setTimeout(resolve, 1000)
    socket.once('close', () => { clearTimeout(timer); resolve() })
    socket.close(1000, 'voice session stopped')
  })
}

export default OpenAiRealtimeVoiceService
