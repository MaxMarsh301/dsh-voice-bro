/** OpenAI Realtime provider for one Host-global DSH voice call. @module @deepseek-ai/dsh-voice-openai-realtime */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionRecord, type SessionSearchHit } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import VoiceService, {
  VoiceCreationId, VoiceNavigationId, VoiceRequestId, VoiceResponseEpoch, VoiceSessionId,
} from '@deepseek-ai/dsh-voice'
import type { VoiceCompletionRequest } from '@deepseek-ai/dsh-voice/types'
import type {
  VoiceCreationAckRequest, VoiceCreationAckResult, VoiceForegroundResult, VoiceNavigationAckRequest, VoiceNavigationAckResult,
  VoiceResponseEpoch as VoiceResponseEpochValue, VoiceResponseEpochResult,
  VoiceSessionId as VoiceSessionIdValue, VoiceStartRequest, VoiceStartResult,
  VoiceStatusResult, VoiceStopResult,
} from '@deepseek-ai/dsh-voice'
import { createHash, randomUUID } from 'node:crypto'
import type { Agent as HttpAgent } from 'node:http'
import { basename } from 'node:path'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent, type Dispatcher } from 'undici'
import WebSocket, { type RawData } from 'ws'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
const SIDEBAND_URL = 'wss://api.openai.com/v1/realtime'
const MODELS = ['gpt-realtime-2.1-mini'] as const
const TRANSCRIPTION_MODELS = ['gpt-4o-mini-transcribe'] as const
const VOICES = ['cedar'] as const
const MIN_SESSION_SECONDS = 30
const MAX_SESSION_SECONDS = 3300
const MAX_SDP_BYTES = 128 * 1024
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024
const MAX_THREAD_READ_TEXT_BYTES = 10 * 1024
const MAX_TRACKED_REQUESTS = 128
const MAX_NAVIGATION_HISTORY = 128
const MAX_CREATION_HISTORY = 128
const DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS = 768
const DEFAULT_HTTP_TIMEOUT_MS = 15_000
const DEFAULT_SIDEBAND_PING_INTERVAL_MS = 30_000
const DEFAULT_ACTIVATION_ATTEMPTS = 5
const DEFAULT_ACTIVATION_RETRY_MS = 100
const DEFAULT_NAVIGATION_ACK_TIMEOUT_MS = 5_000
const DEFAULT_CREATION_ACK_TIMEOUT_MS = 30_000

/** Provider configuration. Identifiers are restricted to reviewed OpenAI Realtime values. */
export interface Config {
  /** Allowlisted realtime model. */
  model?: typeof MODELS[number]
  /** Allowlisted input transcription model. */
  transcriptionModel?: typeof TRANSCRIPTION_MODELS[number]
  /** Allowlisted synthesized voice. */
  voice?: typeof VOICES[number]
  /** Hard lifetime for the single logical call. */
  maxSessionSeconds?: number
  /** Maximum output tokens for each Realtime response, including function calls and audio. */
  maxResponseOutputTokens?: number
  /** Call-creation HTTP deadline. */
  httpTimeoutMs?: number
  /** WebSocket protocol ping interval that keeps an idle sideband tunnel active. */
  sidebandPingIntervalMs?: number
  /** Maximum sideband activation attempts. */
  activationAttempts?: number
  /** Delay between sideband activation attempts. */
  activationRetryMs?: number
  /** Maximum wait for the owning browser tab to acknowledge navigation. */
  navigationAckTimeoutMs?: number
  /** Maximum wait for the owning browser tab to acknowledge Session creation and activation. */
  creationAckTimeoutMs?: number
  /** Optional HTTP CONNECT proxy shared by call creation and the sideband WebSocket. */
  proxyURL?: string
}

/** Complete provider configuration after defaults and bounds. */
export interface ResolvedConfig {
  /** Allowlisted realtime model. */ model: typeof MODELS[number]
  /** Allowlisted transcription model. */ transcriptionModel: typeof TRANSCRIPTION_MODELS[number]
  /** Allowlisted synthesized voice. */ voice: typeof VOICES[number]
  /** Call lifetime in seconds. */ maxSessionSeconds: number
  /** Output-token cap for one Realtime response. */ maxResponseOutputTokens: number
  /** Call-creation HTTP deadline. */ httpTimeoutMs: number
  /** Idle sideband WebSocket ping interval. */ sidebandPingIntervalMs: number
  /** Sideband activation attempt cap. */ activationAttempts: number
  /** Sideband retry delay. */ activationRetryMs: number
  /** Browser navigation acknowledgement deadline. */ navigationAckTimeoutMs: number
  /** Browser Session creation and activation acknowledgement deadline. */ creationAckTimeoutMs: number
  /** Validated HTTP CONNECT proxy, when configured. */ proxyURL?: string
}

/** Testable external clients; production uses global fetch and the `ws` package. */
export interface RuntimeDependencies {
  /** Fetch-compatible call creation client. */
  fetch: typeof fetch
  /** Open one authenticated sideband or reject without leaking provider details. */
  openSideband(url: string, apiKey: string, signal: AbortSignal): Promise<WebSocket>
  /** Schedule a repeated transport heartbeat. */
  setInterval?(callback: () => void, intervalMs: number): NodeJS.Timeout
  /** Cancel a repeated transport heartbeat. */
  clearInterval?(timer: NodeJS.Timeout): void
  /** Release transport pools owned by the default implementation. */
  dispose?(): Promise<void>
}

type ToolName =
  | 'find_threads'
  | 'read_thread'
  | 'create_thread'
  | 'switch_thread'
  | 'thread_turn'
  | 'wait_for_thread'
  | 'cancel_thread'
  | 'get_voice_status'
type RevealMode = 'never' | 'immediately' | 'on-complete'
interface FunctionCall { callId: string; responseId: string; name: ToolName; arguments: string }
interface TrackResult { state: string; reason?: TurnEndReason; text: string }
interface RequestTrack {
  readonly id: VoiceRequestId
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly agent: Agent
  readonly reveal: RevealMode
  readonly title: string
  readonly originEpoch: VoiceResponseEpochValue
  readonly done: Promise<TrackResult>
  readonly resolve: (result: TrackResult) => void
  turn: number | undefined
  text: string[]
  result: TrackResult | undefined
  navigation: Promise<boolean> | undefined
  completionNotified: boolean
}
interface PendingNavigation {
  readonly sessionId: SessionId
  readonly timer: NodeJS.Timeout
  readonly resolve: (activated: boolean) => void
}
interface ConfirmedCreationResult {
  readonly created: boolean
  readonly activated: boolean
  readonly sessionId?: SessionId
}
type CreationResult = ConfirmedCreationResult | {
  readonly disposition: 'outcome_unknown'
}
interface WaitingCreation {
  readonly state: 'waiting'
  readonly timer: NodeJS.Timeout
  readonly resolve: (result: CreationResult) => void
}
interface TimedOutCreation { readonly state: 'timed-out' }
interface TerminalCreation {
  readonly state: 'terminal'
  readonly result: ConfirmedCreationResult
}
type CreationRecord = WaitingCreation | TimedOutCreation | TerminalCreation
interface StartReservation {
  readonly owner: OpenAiRealtimeVoiceService
  readonly consumerId: VoiceStartRequest['consumerId']
  readonly done: Promise<void>
  readonly resolve: () => void
}
interface RootVoiceLease {
  starting: StartReservation | undefined
  active: { owner: OpenAiRealtimeVoiceService; call: LiveCall } | undefined
}

interface LiveCall {
  readonly id: VoiceSessionIdValue
  readonly consumerId: VoiceStartRequest['consumerId']
  readonly startedAt: number
  readonly expiresAt: number
  readonly activationAbort: AbortController
  readonly seenCallIds: Set<string>
  readonly responseEpochs: Map<string, VoiceResponseEpochValue>
  readonly requests: Map<VoiceRequestId, RequestTrack>
  readonly requestsByMessage: Map<MessageId, RequestTrack>
  readonly navigations: Map<VoiceNavigationId, PendingNavigation>
  readonly issuedNavigations: Set<VoiceNavigationId>
  readonly creations: Map<ReturnType<typeof VoiceCreationId>, CreationRecord>
  readonly lifecycleDisposers: Array<() => unknown>
  socket: WebSocket | undefined
  activation: Promise<void>
  dispatchTail: Promise<void>
  teardown: Promise<void> | undefined
  foregroundSessionId: SessionId | undefined
  responseEpoch: VoiceResponseEpochValue | undefined
  timer: NodeJS.Timeout | undefined
  sidebandHeartbeat: NodeJS.Timeout | undefined
  state: 'connecting' | 'active' | 'stopping'
  closed: boolean
}

/** Russian control prompt for the global realtime voice shell. */
export const VOICE_CORE = 'Ты — глобальная голосовая оболочка DSH. Не добавляй к запросу служебные пояснения, мета-инструкции или слова, которых пользователь не произносил. Тред — это Session: находи его через find_threads, читай только явно выбранный тред через read_thread и не угадывай при неоднозначности. create_thread создаёт Session через обычный браузерный путь и активирует её только после подтверждённого успеха. Для переключения используй switch_thread: сначала передай произнесённое название в query; если возвращено confirmation_required, перечисли варианты и дождись явного выбора пользователя, затем передай session_id выбранного варианта. Не выдавай неоднозначный выбор за подтверждённый. Для содержательной работы вызывай thread_turn, затем wait_for_thread с полученным request_id. Пользователь может прервать ожидание, запустить работу в других тредах и продолжить голосовой разговор; не считай это ошибкой и не отменяй уже запущенные запросы. Пустой session_id означает foreground_session_id из get_voice_status; если его нет, попроси пользователя выбрать тред. mode=steer корректирует активную работу, mode=followup ставит отдельный запрос, mode=replace допустим только после явной просьбы прервать текущую работу. switch_thread открывает тред в браузере, но утверждай, что он открыт, только когда activated=true. Не открывай завершившийся тред без подтверждения пользователя: сначала назови сессию, кратко озвучь результат и спроси, переключить ли браузер на неё. Не заявляй о завершении до результата wait_for_thread. Если требуется подтверждение на экране, скажи об этом и продолжай ждать. После результата произнеси по-русски максимум 45 слов в двух-трёх коротких предложениях: итог, важное ограничение или следующий шаг. Не зачитывай списки, код, логи и подробности; скажи, что полный ответ доступен на экране только если activated=true.'

/**
 * Resolve and validate provider configuration.
 * @param config - Raw Loader configuration.
 * @returns Complete immutable settings.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const allowed = [
    'model', 'transcriptionModel', 'voice', 'maxSessionSeconds', 'maxResponseOutputTokens',
    'httpTimeoutMs', 'sidebandPingIntervalMs', 'activationAttempts', 'activationRetryMs',
    'navigationAckTimeoutMs', 'creationAckTimeoutMs', 'proxyURL',
  ]
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new Error(`voice-openai-realtime: unknown config key "${key}"`)
  const model = config.model ?? 'gpt-realtime-2.1-mini'
  const transcriptionModel = config.transcriptionModel ?? 'gpt-4o-mini-transcribe'
  const voice = config.voice ?? 'cedar'
  if (!(MODELS as readonly string[]).includes(model)) throw new Error('voice-openai-realtime: model is not allowlisted')
  if (!(TRANSCRIPTION_MODELS as readonly string[]).includes(transcriptionModel)) throw new Error('voice-openai-realtime: transcriptionModel is not allowlisted')
  if (!(VOICES as readonly string[]).includes(voice)) throw new Error('voice-openai-realtime: voice is not allowlisted')
  const maxSessionSeconds = boundedInteger(config.maxSessionSeconds ?? MAX_SESSION_SECONDS, MIN_SESSION_SECONDS, MAX_SESSION_SECONDS, 'maxSessionSeconds')
  const maxResponseOutputTokens = boundedInteger(config.maxResponseOutputTokens ?? DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS, 256, 4_096, 'maxResponseOutputTokens')
  const httpTimeoutMs = boundedInteger(config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 100, 120_000, 'httpTimeoutMs')
  const sidebandPingIntervalMs = boundedInteger(config.sidebandPingIntervalMs ?? DEFAULT_SIDEBAND_PING_INTERVAL_MS, 5_000, 300_000, 'sidebandPingIntervalMs')
  const activationAttempts = boundedInteger(config.activationAttempts ?? DEFAULT_ACTIVATION_ATTEMPTS, 1, 20, 'activationAttempts')
  const activationRetryMs = boundedInteger(config.activationRetryMs ?? DEFAULT_ACTIVATION_RETRY_MS, 0, 5_000, 'activationRetryMs')
  const navigationAckTimeoutMs = boundedInteger(config.navigationAckTimeoutMs ?? DEFAULT_NAVIGATION_ACK_TIMEOUT_MS, 100, 30_000, 'navigationAckTimeoutMs')
  const creationAckTimeoutMs = boundedInteger(config.creationAckTimeoutMs ?? DEFAULT_CREATION_ACK_TIMEOUT_MS, 100, 120_000, 'creationAckTimeoutMs')
  const proxyURL = config.proxyURL === undefined ? undefined : validateProxyURL(config.proxyURL)
  return Object.freeze({
    model, transcriptionModel, voice, maxSessionSeconds, maxResponseOutputTokens,
    httpTimeoutMs, sidebandPingIntervalMs, activationAttempts, activationRetryMs,
    navigationAckTimeoutMs, creationAckTimeoutMs,
    ...(proxyURL === undefined ? {} : { proxyURL }),
  })
}

function validateProxyURL(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('voice-openai-realtime: proxyURL must be an absolute HTTP URL') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('voice-openai-realtime: proxyURL must be an absolute HTTP URL without credentials, path, query, or fragment')
  }
  return url.href
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`voice-openai-realtime: ${name} must be an integer from ${min} through ${max}`)
  return value
}

function sameCreationResult(left: ConfirmedCreationResult, right: ConfirmedCreationResult): boolean {
  return left.created === right.created && left.activated === right.activated && left.sessionId === right.sessionId
}

/**
 * Validate an SDP offer before any credential or network operation.
 * @param sdp - Untrusted browser offer.
 * @returns The original SDP.
 */
export function validateSdp(sdp: unknown): string {
  if (typeof sdp !== 'string') throw new Error('voice: SDP offer must be a string')
  const bytes = Buffer.byteLength(sdp)
  if (bytes === 0 || bytes > MAX_SDP_BYTES) throw new Error(`voice: SDP offer must contain 1 through ${MAX_SDP_BYTES} bytes`)
  if (sdp.includes('\0') || !/^v=0(?:\r\n|\n)/.test(sdp) || !/(?:^|\n)m=audio\s/m.test(sdp)) throw new Error('voice: invalid SDP offer')
  return sdp
}

/**
 * Validate a bounded SDP answer received from the provider.
 * @param sdp - Response text.
 * @returns The original SDP.
 */
export function validateAnswerSdp(sdp: string): string {
  if (Buffer.byteLength(sdp) === 0 || Buffer.byteLength(sdp) > MAX_SDP_BYTES || sdp.includes('\0') || !/^v=0(?:\r\n|\n)/.test(sdp)) {
    throw new Error('voice: provider returned an invalid SDP answer')
  }
  return sdp
}

/** Parse a safe official OpenAI `rtc_` call id from Location.
 * @param location - response Location header.
 * @returns private provider call id.
 */
export function parseRtcCallId(location: string | null): string {
  if (location === null) throw new Error('voice: provider response omitted call location')
  let pathname: string
  try { pathname = new URL(location, CALLS_URL).pathname } catch { throw new Error('voice: provider returned an invalid call location') }
  const match = /^\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]{1,128})$/.exec(pathname)
  if (match?.[1] === undefined) throw new Error('voice: provider returned an invalid call location')
  return match[1]
}

/**
 * Parse one strict sideband function call event.
 * @param input - Decoded provider event.
 * @returns Validated call or undefined.
 */
function parseResponseEpoch(input: unknown): { responseId: string; epoch: VoiceResponseEpochValue } | undefined {
  if (!isRecord(input) || input['type'] !== 'response.created') return undefined
  const response = input['response']
  if (!isRecord(response) || typeof response['id'] !== 'string') return undefined
  const metadata = response['metadata']
  if (!isRecord(metadata) || typeof metadata['dsh_response_epoch'] !== 'string') return undefined
  const epoch = metadata['dsh_response_epoch']
  if (epoch.length === 0 || epoch.length > 256) return undefined
  return { responseId: response['id'], epoch: VoiceResponseEpoch(epoch) }
}

/**
 * Parse one supported provider function call and its response owner.
 * @param input - Untrusted sideband event.
 * @returns Normalized function call, or undefined for another event type.
 */
export function parseFunctionCall(input: unknown): FunctionCall | undefined {
  if (!isRecord(input)) return undefined
  let source: Record<string, unknown> | undefined
  if (input['type'] === 'response.function_call_arguments.done') source = input
  else if (input['type'] === 'response.output_item.done' && isRecord(input['item']) && input['item']['type'] === 'function_call') source = input['item']
  if (source === undefined) return undefined
  const callId = source['call_id']; const responseId = input['response_id']; const name = source['name']; const args = source['arguments']
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) throw new Error('voice: invalid function call id')
  if (typeof responseId !== 'string' || responseId.length === 0 || responseId.length > 256) throw new Error('voice: invalid function response id')
  if (!TOOL_NAMES.includes(name as ToolName)) throw new Error('voice: unsupported function call')
  if (typeof args !== 'string' || Buffer.byteLength(args) > MAX_TOOL_OUTPUT_BYTES) throw new Error('voice: invalid function arguments')
  return { callId, responseId, name: name as ToolName, arguments: args }
}

const TOOL_NAMES: readonly ToolName[] = [
  'find_threads', 'read_thread', 'create_thread', 'switch_thread', 'thread_turn',
  'wait_for_thread', 'cancel_thread', 'get_voice_status',
]

class VoiceToolError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function objectArguments(json: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new VoiceToolError('invalid_json', 'Некорректные аргументы голосовой команды.') }
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) {
    throw new VoiceToolError('invalid_arguments', 'Некорректные аргументы голосовой команды.')
  }
  return value
}
function stringArgument(value: unknown, name: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || Buffer.byteLength(value) > maxBytes) {
    throw new VoiceToolError('invalid_arguments', `Поле ${name} недопустимо.`)
  }
  return value
}
function enumArgument<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new VoiceToolError('invalid_arguments', `Поле ${name} недопустимо.`)
  return value as T
}
function integerArgument(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new VoiceToolError('invalid_arguments', `Поле ${name} недопустимо.`)
  return value as number
}
function bound(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= maxBytes) return text
  const suffix = Buffer.from('…')
  return `${buffer.subarray(0, maxBytes - suffix.length).toString('utf8').replace(/\uFFFD$/u, '')}…`
}
function json(value: unknown): string { return JSON.stringify(value) }
function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
function textOfMessage(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
}
function workspaceOf(cwd: string | undefined): string | undefined { return cwd === undefined ? undefined : basename(cwd) || cwd }
function activeTurn(events: readonly SessionEvent[], beforeSeq: number): number | undefined {
  for (let index = Math.min(beforeSeq - 1, events.length - 1); index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return undefined
    if (event?.type === 'turn/start') return event.data.turn
  }
  return undefined
}
function toolFailure(error: unknown): string {
  if (error instanceof VoiceToolError) return json({ code: error.code, message: error.message })
  return json({ code: 'voice_tool_failed', message: 'Не удалось выполнить голосовую команду.' })
}

function sessionDefinition(config: ResolvedConfig): Record<string, unknown> {
  const empty = { type: 'object', additionalProperties: false, properties: {}, required: [] }
  return {
    type: 'realtime', model: config.model, instructions: VOICE_CORE,
    max_output_tokens: config.maxResponseOutputTokens, output_modalities: ['audio'],
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: config.transcriptionModel }, turn_detection: null },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice },
    },
    tools: [
      {
        type: 'function', name: 'find_threads', description: 'Найти bounded список DSH-тредов по названию или содержимому. Пустой query возвращает недавние треды.',
        parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, state: { type: 'string', enum: ['all', 'running', 'idle'] }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query', 'state', 'limit'] },
      },
      {
        type: 'function', name: 'read_thread', description: 'Прочитать bounded хвост явно выбранного ordinary-треда без запуска его Agent.',
        parameters: { type: 'object', additionalProperties: false, properties: { session_id: { type: 'string' }, max_messages: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['session_id', 'max_messages'] },
      },
      {
        type: 'function', name: 'create_thread', description: 'Создать ordinary-тред через обычный браузерный Session API, при непустом title явно назвать его и активировать только после полного успеха.',
        parameters: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } }, required: ['title'] },
      },
      {
        type: 'function', name: 'switch_thread', description: 'Безопасно выбрать и открыть ordinary-тред. Первый вызов передаёт query. При нескольких совпадениях вернётся confirmation_required без переключения; после явного выбора пользователя повтори с точным session_id.',
        parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, session_id: { type: 'string' } }, required: [] },
      },
      {
        type: 'function', name: 'thread_turn', description: 'Отправить запрос в ordinary-тред. Пустой session_id использует foreground. replace допустим только по явной просьбе пользователя.',
        parameters: { type: 'object', additionalProperties: false, properties: { session_id: { type: 'string' }, prompt: { type: 'string' }, mode: { type: 'string', enum: ['followup', 'steer', 'replace'] }, reveal: { type: 'string', enum: ['never', 'immediately', 'on-complete'] } }, required: ['session_id', 'prompt', 'mode', 'reveal'] },
      },
      {
        type: 'function', name: 'wait_for_thread', description: 'Дождаться turn/end, который принял MessageId конкретного voice request, и получить bounded ответ этого Turn.',
        parameters: { type: 'object', additionalProperties: false, properties: { request_id: { type: 'string' } }, required: ['request_id'] },
      },
      {
        type: 'function', name: 'cancel_thread', description: 'По явной просьбе пользователя отменить активную работу ordinary-треда; request_id выбирает тред исходного запроса.',
        parameters: { type: 'object', additionalProperties: false, properties: { session_id: { type: 'string' }, request_id: { type: 'string' } }, required: [] },
      },
      { type: 'function', name: 'get_voice_status', description: 'Получить состояние глобального voice call, foreground Session и voice requests.', parameters: empty },
    ], tool_choice: 'auto',
  }
}

function createDefaultDependencies(proxyURL: string | undefined): RuntimeDependencies {
  if (proxyURL === undefined) return { fetch: globalThis.fetch, openSideband: openSocket }
  const dispatcher = new ProxyAgent(proxyURL)
  const socketAgent = new HttpsProxyAgent(proxyURL)
  const proxyFetch: typeof fetch = (input, init) => globalThis.fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher })
  return {
    fetch: proxyFetch,
    openSideband: (url, apiKey, signal) => openSocket(url, apiKey, signal, socketAgent),
    dispose: async () => {
      socketAgent.destroy()
      await dispatcher.close()
    },
  }
}
const ROOT_LEASES = new WeakMap<Context, RootVoiceLease>()

function reserveStart(owner: OpenAiRealtimeVoiceService, consumerId: VoiceStartRequest['consumerId']): StartReservation {
  let settle!: () => void
  const done = new Promise<void>((resolve) => { settle = resolve })
  return { owner, consumerId, done, resolve: settle }
}

/** OpenAI Realtime implementation of the Host-global `ctx.voice` lease. */
export class OpenAiRealtimeVoiceService extends VoiceService {
  static inject = ['agents', 'sessionQuery', 'typert']
  static Config: z<Config> = z.object({
    model: z.union(MODELS.map(value => z.const(value))).default('gpt-realtime-2.1-mini'),
    transcriptionModel: z.union(TRANSCRIPTION_MODELS.map(value => z.const(value))).default('gpt-4o-mini-transcribe'),
    voice: z.union(VOICES.map(value => z.const(value))).default('cedar'),
    maxSessionSeconds: z.number().step(1).min(MIN_SESSION_SECONDS).max(MAX_SESSION_SECONDS).default(MAX_SESSION_SECONDS),
    maxResponseOutputTokens: z.number().step(1).min(256).max(4_096).default(DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS),
    httpTimeoutMs: z.number().step(1).min(100).max(120_000).default(DEFAULT_HTTP_TIMEOUT_MS),
    sidebandPingIntervalMs: z.number().step(1).min(5_000).max(300_000).default(DEFAULT_SIDEBAND_PING_INTERVAL_MS),
    activationAttempts: z.number().step(1).min(1).max(20).default(DEFAULT_ACTIVATION_ATTEMPTS),
    activationRetryMs: z.number().step(1).min(0).max(5_000).default(DEFAULT_ACTIVATION_RETRY_MS),
    navigationAckTimeoutMs: z.number().step(1).min(100).max(30_000).default(DEFAULT_NAVIGATION_ACK_TIMEOUT_MS),
    creationAckTimeoutMs: z.number().step(1).min(100).max(120_000).default(DEFAULT_CREATION_ACK_TIMEOUT_MS),
    proxyURL: z.string(),
  })

  private readonly config: ResolvedConfig
  private readonly dependencies: RuntimeDependencies
  private readonly lease: RootVoiceLease
  private startAbort = new AbortController()
  private closing = false

  constructor(ctx: Context, config: Config = {}, dependencies?: RuntimeDependencies) {
    super(ctx); this.config = resolveConfig(config); this.dependencies = dependencies ?? createDefaultDependencies(this.config.proxyURL)
    this.lease = ROOT_LEASES.get(ctx.root) ?? { starting: undefined, active: undefined }
    ROOT_LEASES.set(ctx.root, this.lease)
    ctx.effect(() => async () => {
      this.closing = true; this.startAbort.abort()
      const owner = this.typertRemote.service
      const starting = this.lease.starting
      if (starting?.owner === owner) await starting.done
      const active = this.lease.active
      if (active?.owner === owner) await this.teardown(active.call)
      await this.dependencies.dispose?.()
    }, 'voice-openai-realtime.drain')

  }

  /** Create the single global WebRTC call and return before sideband activation. */
  async start(request: VoiceStartRequest): Promise<VoiceStartResult> {
    this.reactivateForStart()
    this.ctx.logger.info('voice: global call start requested')
    const consumerId = stringArgument(request.consumerId, 'consumerId', 256)
    const owner = this.typertRemote.service
    for (;;) {
      const starting = this.lease.starting
      if (starting === undefined) break
      if (starting.consumerId !== request.consumerId) throw new Error('voice: a global session is already active')
      await starting.done
    }
    const occupied = this.lease.active?.call
    if (occupied?.state !== 'stopping' && occupied !== undefined && occupied.consumerId !== request.consumerId) {
      throw new Error('voice: a global session is already active')
    }
    const reservation = reserveStart(owner, request.consumerId)
    this.lease.starting = reservation
    try {
      if (occupied !== undefined) {
        if (occupied.state !== 'stopping') this.ctx.logger.warn('voice: replacing a stale call from the same browser tab')
        await this.teardown(occupied)
      }
      if (this.lease.active !== undefined) throw new Error('voice: a global session is already active')
      const sdp = validateSdp(request.sdp)
      const resolved = await this.ctx.get('credentials')?.resolve(credentialRef('OPENAI_API_KEY'))
      const apiKey = resolved?.value ?? process.env['OPENAI_API_KEY']
      if (apiKey === undefined || apiKey.length === 0) throw new Error('voice: OPENAI_API_KEY is not configured')
      this.ctx.logger.info('voice: OpenAI credential resolved from %s', resolved?.source ?? 'environment')
      const form = new FormData(); form.set('sdp', sdp); form.set('session', JSON.stringify(sessionDefinition(this.config)))
      const safetyId = `dsh_${createHash('sha256').update(consumerId).digest('hex').slice(0, 32)}`
      let response: Response
      try {
        response = await this.dependencies.fetch(CALLS_URL, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(this.config.httpTimeoutMs), this.startAbort.signal]),
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
      this.ctx.logger.info('voice: provider accepted the WebRTC call')
      this.assertStartupOwner(reservation)
      const startedAt = Date.now(); const expiresAt = startedAt + this.config.maxSessionSeconds * 1000
      const call: LiveCall = {
        id: VoiceSessionId(`voice-${randomUUID()}`), consumerId: request.consumerId, startedAt, expiresAt,
        activationAbort: new AbortController(), seenCallIds: new Set(), responseEpochs: new Map(),
        requests: new Map(), requestsByMessage: new Map(), navigations: new Map(), issuedNavigations: new Set(),
        creations: new Map(), lifecycleDisposers: [], socket: undefined,
        activation: Promise.resolve(), dispatchTail: Promise.resolve(),
        teardown: undefined, foregroundSessionId: request.foregroundSessionId, responseEpoch: undefined,
        timer: undefined, sidebandHeartbeat: undefined, state: 'connecting', closed: false,
      }
      this.lease.active = { owner, call }
      this.attachCallLifecycle(call)
      call.timer = setTimeout(() => { void this.teardown(call) }, this.config.maxSessionSeconds * 1000)
      call.activation = this.activate(call, rtcCallId, apiKey).catch(() => {
        this.ctx.logger.warn('voice: provider sideband activation failed')
        void this.teardown(call, false, false)
      })
      return { sessionId: call.id, answerSdp, expiresAt }
    } finally {
      if (this.lease.starting === reservation) this.lease.starting = undefined
      reservation.resolve()
    }
  }

  /** Return public lifecycle facts, including the browser's current Session. */
  status(sessionId: VoiceSessionIdValue): Promise<VoiceStatusResult> {
    return Promise.resolve().then(() => {
      const call = this.owned(sessionId)
      return {
        sessionId: call.id, state: call.state, sidebandReady: call.state === 'active',
        startedAt: call.startedAt, expiresAt: call.expiresAt,
        ...(call.foregroundSessionId === undefined ? {} : { foregroundSessionId: call.foregroundSessionId }),
      }
    })
  }

  /** Update the Session visible in the owning browser tab. */
  setForeground(sessionId: VoiceSessionIdValue, foregroundSessionId: SessionId | undefined): Promise<VoiceForegroundResult> {
    return Promise.resolve().then(() => {
      const call = this.owned(sessionId); call.foregroundSessionId = foregroundSessionId
      return { sessionId, ...(foregroundSessionId === undefined ? {} : { foregroundSessionId }) }
    })
  }

  /** Claim sole continuation ownership for one browser-gated phrase. */
  claimResponseEpoch(sessionId: VoiceSessionIdValue, epoch: VoiceResponseEpochValue): Promise<VoiceResponseEpochResult> {
    return Promise.resolve().then(() => {
      const call = this.owned(sessionId)
      call.responseEpoch = VoiceResponseEpoch(stringArgument(epoch, 'epoch', 256))
      return { sessionId, epoch: call.responseEpoch, claimed: true as const }
    })
  }

  /** Settle one navigation wait from the owning browser tab. */
  ackNavigation(sessionId: VoiceSessionIdValue, request: VoiceNavigationAckRequest): Promise<VoiceNavigationAckResult> {
    return Promise.resolve().then(() => {
      const call = this.owned(sessionId)
      const pending = call.navigations.get(request.navigationId)
      if (pending === undefined) {
        if (call.issuedNavigations.has(request.navigationId)) return { navigationId: request.navigationId, acknowledged: true as const }
        throw new Error('voice: navigation not found')
      }
      clearTimeout(pending.timer); call.navigations.delete(request.navigationId)
      if (request.activated) call.foregroundSessionId = pending.sessionId
      pending.resolve(request.activated)
      return { navigationId: request.navigationId, acknowledged: true as const }
    })
  }

  /** Settle or idempotently repeat one browser-owned Session creation acknowledgement. */
  async ackCreation(sessionId: VoiceSessionIdValue, request: VoiceCreationAckRequest): Promise<VoiceCreationAckResult> {
    const call = this.owned(sessionId)
    if (request.created !== (request.sessionId !== undefined) || (request.activated && !request.created)) {
      throw new Error('voice: invalid creation acknowledgement')
    }
    const result: ConfirmedCreationResult = {
      created: request.created,
      activated: request.activated,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    }
    const initial = call.creations.get(request.creationId)
    if (initial === undefined) throw new Error('voice: creation not found')
    if (initial.state === 'terminal') {
      if (!sameCreationResult(initial.result, result)) throw new Error('voice: conflicting creation acknowledgement')
      return { creationId: request.creationId, acknowledged: true as const }
    }
    if (request.sessionId !== undefined) await this.requireOrdinary(request.sessionId)
    this.owned(sessionId)
    const current = call.creations.get(request.creationId)
    if (current === undefined) throw new Error('voice: creation not found')
    if (current.state === 'terminal') {
      if (!sameCreationResult(current.result, result)) throw new Error('voice: conflicting creation acknowledgement')
      return { creationId: request.creationId, acknowledged: true as const }
    }
    if (current.state === 'waiting') {
      clearTimeout(current.timer)
      current.resolve(result)
    }
    call.creations.set(request.creationId, { state: 'terminal', result })
    if (request.activated && request.sessionId !== undefined) call.foregroundSessionId = request.sessionId
    return { creationId: request.creationId, acknowledged: true as const }
  }

  /** Stop and drain the global logical call without waiting for Agent work. */
  async stop(sessionId: VoiceSessionIdValue): Promise<VoiceStopResult> {
    const call = this.owned(sessionId); await this.teardown(call)
    return { sessionId, stopped: true }
  }

  private attachCallLifecycle(call: LiveCall): void {
    const root = this.ctx.root
    call.lifecycleDisposers.push(root.on('session/event', (session, event) => { this.onSessionEvent(session, event) }))
    call.lifecycleDisposers.push(root.on('agent/disposed', ({ agent }) => {
      for (const track of call.requests.values()) {
        if (track.agent === agent && track.result === undefined) this.settleTrack(call, track, { state: 'agent_disposed', text: bound(track.text.join('\n')) })
      }
    }))
    call.lifecycleDisposers.push(root.effect(() => () => {
      if (!call.closed) void this.teardown(call, false)
    }, 'voice-openai-realtime.call'))
  }

  private reactivateForStart(): void {
    const owner = this.typertRemote.service
    if (!owner.closing) return
    owner.closing = false
    owner.startAbort = new AbortController()
    this.ctx.logger.warn('voice: reactivated provider for a new Remote start')
  }

  private assertStartupOwner(reservation: StartReservation): void {
    if (reservation.owner.closing || this.lease.starting !== reservation) throw new Error('voice: service is disposing')
    if (this.lease.active !== undefined) throw new Error('voice: a global session is already active')
  }

  private owned(id: VoiceSessionIdValue): LiveCall {
    const call = this.lease.active?.call
    if (call === undefined || call.id !== id) throw new Error('voice: session not found')
    return call
  }

  private async activate(call: LiveCall, rtcCallId: string, apiKey: string): Promise<void> {
    for (let attempt = 1; attempt <= this.config.activationAttempts; attempt += 1) {
      if (call.activationAbort.signal.aborted) throw new Error('aborted')
      try {
        const socket = await this.dependencies.openSideband(`${SIDEBAND_URL}?call_id=${encodeURIComponent(rtcCallId)}`, apiKey, call.activationAbort.signal)
        if (call.closed) { await closeSocketAndWait(socket); return }
        call.socket = socket; call.state = 'active'
        this.ctx.logger.info('voice: provider sideband is active')
        this.startSidebandHeartbeat(call, socket)
        socket.on('message', (data) => { this.onMessage(call, data) })
        socket.on('error', () => { this.ctx.logger.warn('voice: provider sideband transport error') })
        socket.once('close', (code) => {
          this.stopSidebandHeartbeat(call)
          if (!call.closed) this.ctx.logger.warn('voice: provider sideband closed with code %d', code)
          void this.teardown(call, false)
        })
        return
      } catch {
        if (attempt === this.config.activationAttempts) break
        await abortableDelay(this.config.activationRetryMs, call.activationAbort.signal)
      }
    }
    throw new Error('activation-failed')
  }

  private startSidebandHeartbeat(call: LiveCall, socket: WebSocket): void {
    this.stopSidebandHeartbeat(call)
    const heartbeat = () => {
      if (call.closed || call.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      try {
        socket.ping()
      } catch {
        this.ctx.logger.warn('voice: provider sideband heartbeat failed')
        socket.terminate()
      }
    }
    const timer = this.dependencies.setInterval === undefined
      ? setInterval(heartbeat, this.config.sidebandPingIntervalMs)
      : this.dependencies.setInterval(heartbeat, this.config.sidebandPingIntervalMs)
    timer.unref()
    call.sidebandHeartbeat = timer
  }

  private stopSidebandHeartbeat(call: LiveCall): void {
    const timer = call.sidebandHeartbeat
    if (timer === undefined) return
    call.sidebandHeartbeat = undefined
    if (this.dependencies.clearInterval === undefined) clearInterval(timer)
    else this.dependencies.clearInterval(timer)
  }

  private onMessage(call: LiveCall, data: RawData): void {
    if (call.closed) return
    let event: unknown
    try { event = JSON.parse(rawText(data)) } catch { return }
    const created = parseResponseEpoch(event)
    if (created !== undefined) {
      call.responseEpochs.set(created.responseId, created.epoch)
      if (call.responseEpochs.size > MAX_TRACKED_REQUESTS) {
        const oldest = call.responseEpochs.keys().next().value
        if (oldest !== undefined) call.responseEpochs.delete(oldest)
      }
      return
    }
    let request: FunctionCall | undefined
    try { request = parseFunctionCall(event) } catch { this.ctx.logger.warn('voice: rejected malformed provider function call'); return }
    if (request === undefined || call.seenCallIds.has(request.callId)) return
    const epoch = call.responseEpochs.get(request.responseId)
    if (epoch === undefined || call.responseEpoch !== epoch) return
    call.seenCallIds.add(request.callId)
    void this.execute(call, request, epoch).catch(toolFailure).then((output) => {
      call.dispatchTail = call.dispatchTail.then(() => {
        const socket = call.socket
        if (call.closed || call.responseEpoch !== epoch || socket?.readyState !== WebSocket.OPEN) {
          if (!call.closed && request.name === 'wait_for_thread') this.notifySuppressedCompletion(call, request.arguments)
          return
        }
        socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: request.callId, output: bound(output) } }))
        socket.send(JSON.stringify({ type: 'response.create', response: { metadata: { dsh_response_epoch: epoch } } }))
      }).catch(() => {})
    })
  }

  private async execute(call: LiveCall, request: FunctionCall, epoch: VoiceResponseEpochValue): Promise<string> {
    if (request.name === 'find_threads') return this.findThreads(request.arguments)
    if (request.name === 'read_thread') return this.readThread(request.arguments)
    if (request.name === 'create_thread') return this.createThread(call, request.arguments, epoch)
    if (request.name === 'switch_thread') return this.switchThread(call, request.arguments, epoch)
    if (request.name === 'thread_turn') return this.threadTurn(call, request.arguments, epoch)
    if (request.name === 'wait_for_thread') return this.waitForThread(call, request.arguments, epoch)
    if (request.name === 'cancel_thread') return this.cancelThread(call, request.arguments)
    objectArguments(request.arguments, [], [])
    return json({
      voice: { state: call.state, sideband_ready: call.state === 'active', expires_at: call.expiresAt },
      ...(call.foregroundSessionId === undefined ? {} : { foreground_session_id: call.foregroundSessionId }),
      requests: [...call.requests.values()].slice(-20).map(track => ({ request_id: track.id, session_id: track.sessionId, state: track.result?.state ?? (track.turn === undefined ? 'queued' : 'running') })),
    })
  }

  private async findThreads(argumentsJson: string): Promise<string> {
    const value = objectArguments(argumentsJson, ['query', 'state', 'limit'], ['query', 'state', 'limit'])
    const query = stringArgument(value['query'], 'query', 2_048, true).trim()
    const state = enumArgument(value['state'], ['all', 'running', 'idle'] as const, 'state')
    const limit = integerArgument(value['limit'], 1, 10, 'limit')
    const records = (await this.ctx.sessionQuery.listSessions()).filter(record => record.header.origin !== 'subagent')
    const observations = await this.ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
    const observedById = new Map(records.map((record, index) => [record.header.id, observations[index]] as const))
    let found: Array<SessionRecord | SessionSearchHit> = records
    if (query !== '') {
      const normalized = query.toLocaleLowerCase()
      const titleMatches = records.filter((record) => {
        const observed = observedById.get(record.header.id)
        const title = observed?.status === 'fulfilled' ? observed.value.title?.title : undefined
        return [title, workspaceOf(record.header.cwd), String(record.header.id)]
          .some(candidate => candidate?.toLocaleLowerCase().includes(normalized) === true)
      })
      let contentMatches: readonly SessionSearchHit[] = []
      try {
        contentMatches = (await this.ctx.sessionQuery.searchSessions({ query, limit: 10 })).items
      } catch (error) {
        if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SEARCH_DISABLED') throw error
      }
      const matchesById = new Map(titleMatches.map(record => [record.header.id, record] as const))
      for (const match of contentMatches) matchesById.set(match.header.id, match)
      found = [...matchesById.values()]
    }
    const eligible = found.filter((record) => {
      const running = this.ctx.agents.get(record.header.id)?.status === 'running'
      return state === 'all' || (state === 'running' ? running : !running)
    })
    const threads = await Promise.all(eligible.map(async (record) => {
      const observed = observedById.get(record.header.id)
      const title = observed?.status === 'fulfilled' ? observed.value.title?.title : undefined
      let updatedAt = observed?.status === 'fulfilled' ? observed.value.title?.updatedAt : undefined
      try {
        updatedAt = (await this.ctx.sessionQuery.readSurface(record.header.id)).events.at(-1)?.time ?? updatedAt
      } catch {
        /* A list row remains usable when an exact surface read fails. */
      }
      const bestMatch = 'bestMatch' in record ? record.bestMatch.snippet : undefined
      return {
        session_id: record.header.id,
        title: title ?? workspaceOf(record.header.cwd) ?? String(record.header.id),
        ...(workspaceOf(record.header.cwd) === undefined ? {} : { workspace: workspaceOf(record.header.cwd) }),
        running: this.ctx.agents.get(record.header.id)?.status === 'running',
        updated_at: updatedAt ?? record.header.createdAt,
        kind: record.header.origin === 'subagent' ? 'subagent' : 'ordinary',
        ...(bestMatch === undefined ? {} : { match: bound(bestMatch, 1_024) }),
      }
    }))
    threads.sort((left, right) => right.updated_at - left.updated_at)
    return json({ threads: threads.slice(0, limit), has_more: threads.length > limit })
  }

  private async readThread(argumentsJson: string): Promise<string> {
    const value = objectArguments(argumentsJson, ['session_id', 'max_messages'], ['session_id', 'max_messages'])
    const sessionId = SessionId(stringArgument(value['session_id'], 'session_id', 512))
    const maxMessages = integerArgument(value['max_messages'], 1, 12, 'max_messages')
    await this.requireOrdinary(sessionId)
    const [surface, title] = await Promise.all([
      this.ctx.sessionQuery.readSurface(sessionId),
      this.ctx.sessionQuery.readTitle(sessionId),
    ])
    const collected: Array<{ role: 'user' | 'assistant'; text: string }> = []
    for (const event of surface.events) {
      if (event.type === 'user/message') collected.push({ role: 'user', text: textOfMessage(event.data) })
      else if (event.type === 'assistant/message') collected.push({ role: 'assistant', text: textOfMessage(event.data.message) })
    }
    const visible = collected.filter(message => message.text !== '')
    const candidates = visible.slice(-maxMessages)
    let remaining = MAX_THREAD_READ_TEXT_BYTES
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
    let truncated = visible.length > candidates.length
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const message = candidates[index]
      if (message === undefined) continue
      if (remaining <= 0) { truncated = true; break }
      const text = bound(message.text, Math.min(2_048, remaining))
      remaining -= Buffer.byteLength(text)
      if (text !== message.text) truncated = true
      messages.unshift({ role: message.role, text })
    }
    return json({
      session_id: sessionId,
      title: title?.title ?? workspaceOf(surface.session.cwd) ?? String(sessionId),
      captured_through_seq: surface.capturedThroughSeq,
      messages,
      truncated,
    })
  }

  private async createThread(call: LiveCall, argumentsJson: string, epoch: VoiceResponseEpochValue): Promise<string> {
    const value = objectArguments(argumentsJson, ['title'], ['title'])
    const title = stringArgument(value['title'], 'title', 512, true).trim()
    if (call.responseEpoch !== epoch) return json({ created: false, activated: false, disposition: 'superseded' })
    const result = await this.createThroughBrowser(call, title)
    if ('disposition' in result) return json({ disposition: result.disposition, ...(title === '' ? {} : { title }) })
    return json({
      created: result.created,
      activated: result.activated,
      ...(result.sessionId === undefined ? {} : { session_id: result.sessionId }),
      ...(title === '' ? {} : { title }),
    })
  }

  private async switchThread(call: LiveCall, argumentsJson: string, epoch: VoiceResponseEpochValue): Promise<string> {
    const value = objectArguments(argumentsJson, ['query', 'session_id'], [])
    const rawSessionId = value['session_id'] === undefined ? '' : stringArgument(value['session_id'], 'session_id', 512, true).trim()
    const query = value['query'] === undefined ? '' : stringArgument(value['query'], 'query', 2_048, true).trim()
    if ((rawSessionId === '') === (query === '')) throw new VoiceToolError('invalid_arguments', 'Укажите либо query, либо session_id.')
    let sessionId: SessionId
    if (rawSessionId !== '') {
      sessionId = SessionId(rawSessionId)
      await this.requireOrdinary(sessionId)
    } else {
      const records = (await this.ctx.sessionQuery.listSessions()).filter(record => record.header.origin !== 'subagent')
      const observations = await this.ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
      const normalized = query.toLocaleLowerCase()
      const matches = records.flatMap((record, index) => {
        const observed = observations[index]
        const title = observed?.status === 'fulfilled' ? observed.value.title?.title : undefined
        const display = title ?? workspaceOf(record.header.cwd) ?? String(record.header.id)
        return display.toLocaleLowerCase().includes(normalized) ? [{ session_id: record.header.id, title: display }] : []
      })
      const [match] = matches
      if (match === undefined) return json({ activated: false, disposition: 'not_found', query })
      if (matches.length > 1) {
        return json({
          activated: false,
          disposition: 'confirmation_required',
          choices: matches.slice(0, 10),
          has_more: matches.length > 10,
        })
      }
      sessionId = match.session_id
    }
    if (call.responseEpoch !== epoch) return json({ session_id: sessionId, activated: false, disposition: 'superseded' })
    const activated = await this.navigate(call, sessionId, 'user-requested')
    return json({ session_id: sessionId, activated, disposition: activated ? 'activated' : 'navigation_failed' })
  }

  private async threadTurn(call: LiveCall, argumentsJson: string, epoch: VoiceResponseEpochValue): Promise<string> {
    const value = objectArguments(argumentsJson, ['session_id', 'prompt', 'mode', 'reveal'], ['session_id', 'prompt', 'mode', 'reveal'])
    const rawSessionId = stringArgument(value['session_id'], 'session_id', 512, true).trim()
    const sessionId = rawSessionId === '' ? call.foregroundSessionId : SessionId(rawSessionId)
    if (sessionId === undefined) throw new VoiceToolError('thread_required', 'Сначала выберите тред.')
    const prompt = stringArgument(value['prompt'], 'prompt', 32_768).replace(/^(?:\s*БРО(?:\s*[,.:—-]?\s*))+/iu, '').trim()
    if (prompt === '') throw new VoiceToolError('invalid_prompt', 'Запрос после слова активации пуст.')
    const mode = enumArgument(value['mode'], ['followup', 'steer', 'replace'] as const, 'mode')
    const reveal = enumArgument(value['reveal'], ['never', 'immediately', 'on-complete'] as const, 'reveal')
    await this.requireOrdinary(sessionId)
    let title: string | undefined
    try {
      title = (await this.ctx.sessionQuery.readTitle(sessionId))?.title
    } catch {
      /* Request delivery remains available when its optional title read fails. */
    }
    this.pruneSettledRequests(call)
    if (call.requests.size >= MAX_TRACKED_REQUESTS) throw new VoiceToolError('request_limit', 'Слишком много голосовых запросов в этом сеансе.')
    const agent = await this.resolveAgent(sessionId)
    const agentStatus = agent.status
    if (mode === 'steer' && agentStatus === 'idle') return json({ accepted: false, action: mode, disposition: 'agent_idle', agent_status: agentStatus })
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    const requestId = VoiceRequestId(`voice-request-${randomUUID()}`)
    let resolve!: (result: TrackResult) => void
    const track: RequestTrack = {
      id: requestId, sessionId, messageId: message.id, agent, reveal,
      title: bound(title ?? String(sessionId), 512), originEpoch: epoch,
      done: new Promise((done) => { resolve = done }), resolve: (result) => { resolve(result) },
      turn: undefined, text: [], result: undefined, navigation: undefined, completionNotified: false,
    }
    call.requests.set(requestId, track); call.requestsByMessage.set(message.id, track)
    let disposition: 'started' | 'queued' | 'steered' | 'replacing'
    try {
      if (mode === 'steer') { agent.steer(message); disposition = 'steered' }
      else if (mode === 'replace') { agent.cancel({ kind: 'user' }); agent.followup(message); disposition = 'replacing' }
      else { agent.followup(message); disposition = agentStatus === 'idle' ? 'started' : 'queued' }
    } catch (error) {
      this.settleTrack(call, track, { state: 'rejected', text: '' })
      throw error
    }
    void agent.whenIdle().then(() => {
      if (!call.closed && track.result === undefined && track.turn === undefined) this.settleTrack(call, track, { state: 'discarded', text: '' })
    }).catch(() => {
      if (!call.closed && track.result === undefined) this.settleTrack(call, track, { state: 'agent_error', text: '' })
    })
    let activated: boolean | undefined
    if (reveal === 'immediately' && call.responseEpoch === epoch) activated = await this.navigate(call, sessionId, 'user-requested')
    return json({
      accepted: true,
      request_id: requestId,
      session_id: sessionId,
      action: mode,
      disposition,
      agent_status: agentStatus,
      reveal,
      ...(activated === undefined ? {} : { activated }),
    })
  }

  private async waitForThread(call: LiveCall, argumentsJson: string, epoch: VoiceResponseEpochValue): Promise<string> {
    const value = objectArguments(argumentsJson, ['request_id'], ['request_id'])
    const requestId = VoiceRequestId(stringArgument(value['request_id'], 'request_id', 512))
    const track = call.requests.get(requestId)
    if (track === undefined) throw new VoiceToolError('request_not_found', 'Голосовой запрос не найден.')
    const result = await track.done
    let activated: boolean | undefined
    if (track.reveal === 'on-complete' && call.responseEpoch === epoch) {
      track.navigation ??= this.navigate(call, track.sessionId, 'response-ready')
      activated = await track.navigation
    }
    return json({
      request_id: requestId,
      session_id: track.sessionId,
      state: result.state,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.text === '' ? {} : { text: result.text }),
      ...(activated === undefined ? {} : { activated }),
    })
  }

  private async cancelThread(call: LiveCall, argumentsJson: string): Promise<string> {
    const value = objectArguments(argumentsJson, ['session_id', 'request_id'], [])
    const rawRequest = value['request_id'] === undefined
      ? undefined
      : stringArgument(value['request_id'], 'request_id', 512)
    const track = rawRequest === undefined ? undefined : call.requests.get(VoiceRequestId(rawRequest))
    if (rawRequest !== undefined && track === undefined) {
      throw new VoiceToolError('request_not_found', 'Голосовой запрос не найден.')
    }
    const rawSession = value['session_id'] === undefined
      ? ''
      : stringArgument(value['session_id'], 'session_id', 512, true).trim()
    const sessionId = track?.sessionId ?? (rawSession === '' ? call.foregroundSessionId : SessionId(rawSession))
    if (sessionId === undefined) throw new VoiceToolError('thread_required', 'Сначала выберите тред.')
    await this.requireOrdinary(sessionId)
    const agent = track?.agent ?? await this.resolveAgent(sessionId)
    const queuedTurns = agent.inbox.nextTurn.length; const pendingSteers = agent.inbox.nextStep.length
    agent.cancel({ kind: 'user' })
    return json({
      session_id: sessionId,
      cancel_requested: true,
      agent_status: agent.status,
      queued_turns: queuedTurns,
      pending_steers: pendingSteers,
    })
  }

  private async requireOrdinary(sessionId: SessionId): Promise<void> {
    const record = (await this.ctx.sessionQuery.listSessions()).find(candidate => candidate.header.id === sessionId)
    if (record === undefined) throw new VoiceToolError('thread_not_found', 'Тред не найден.')
    if (record.header.origin === 'subagent') throw new VoiceToolError('subagent_unsupported', 'Голосовые запросы в subagent-треды пока не поддерживаются.')
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const lookup = this.ctx.typert.lookups.get('agent')
    if (lookup === undefined) throw new VoiceToolError('thread_unavailable', 'Механизм восстановления тредов недоступен.')
    const resolved = await lookup.resolve(sessionId)
    if (resolved === undefined) throw new VoiceToolError('thread_unavailable', 'Тред нельзя активировать для выполнения.')
    return resolved as Agent
  }

  private createThroughBrowser(call: LiveCall, title: string): Promise<CreationResult> {
    if (call.closed) return Promise.resolve({ created: false, activated: false })
    this.pruneCreations(call)
    if (call.creations.size >= MAX_CREATION_HISTORY) {
      throw new VoiceToolError('creation_capacity', 'Слишком много незавершённых запросов создания треда.')
    }
    const creationId = VoiceCreationId(`voice-creation-${randomUUID()}`)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const current = call.creations.get(creationId)
        if (current?.state !== 'waiting') return
        call.creations.set(creationId, { state: 'timed-out' })
        resolve({ disposition: 'outcome_unknown' })
      }, this.config.creationAckTimeoutMs)
      call.creations.set(creationId, { state: 'waiting', timer, resolve })
      try {
        this.ctx.emit('voice/creation-requested', {
          consumerId: call.consumerId,
          voiceSessionId: call.id,
          creationId,
          activationTimeoutMs: this.config.creationAckTimeoutMs,
          ...(title === '' ? {} : { title }),
        })
      } catch {
        clearTimeout(timer); call.creations.delete(creationId); resolve({ created: false, activated: false })
      }
    })
  }

  private pruneCreations(call: LiveCall): void {
    if (call.creations.size < MAX_CREATION_HISTORY) return
    for (const [creationId, record] of call.creations) {
      if (record.state === 'waiting') continue
      call.creations.delete(creationId)
      if (call.creations.size < MAX_CREATION_HISTORY) return
    }
  }

  private navigate(call: LiveCall, sessionId: SessionId, reason: 'user-requested' | 'response-ready'): Promise<boolean> {
    if (call.closed) return Promise.resolve(false)
    const navigationId = VoiceNavigationId(`voice-navigation-${randomUUID()}`)
    call.issuedNavigations.add(navigationId)
    if (call.issuedNavigations.size > MAX_NAVIGATION_HISTORY) {
      const oldest = call.issuedNavigations.values().next().value
      if (oldest !== undefined) call.issuedNavigations.delete(oldest)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        call.navigations.delete(navigationId)
        resolve(false)
      }, this.config.navigationAckTimeoutMs)
      call.navigations.set(navigationId, { sessionId, timer, resolve })
      try {
        this.ctx.emit('voice/navigation-requested', {
          consumerId: call.consumerId, voiceSessionId: call.id, navigationId, sessionId, reason,
        })
      } catch {
        clearTimeout(timer); call.navigations.delete(navigationId); resolve(false)
      }
    })
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const active = this.lease.active
    if (active?.owner !== this.typertRemote.service) return
    const call = active.call
    if (call.closed) return
    if (event.type === 'user/message') {
      const track = call.requestsByMessage.get(event.data.id)
      if (track !== undefined && track.sessionId === session.id && track.result === undefined) {
        track.turn = activeTurn(session.events, event.seq)
      }
      return
    }
    if (event.type === 'assistant/message') {
      for (const track of call.requests.values()) {
        if (track.result === undefined && track.sessionId === session.id && track.turn === event.data.turn) {
          const text = textOfMessage(event.data.message)
          if (text !== '') track.text.push(text)
        }
      }
      return
    }
    if (event.type !== 'turn/end') return
    for (const track of call.requests.values()) {
      if (track.result === undefined && track.sessionId === session.id && track.turn === event.data.turn) {
        this.settleTrack(call, track, { state: event.data.reason.kind, reason: event.data.reason, text: bound(track.text.join('\n')) })
      }
    }
  }

  private notifySuppressedCompletion(call: LiveCall, argumentsJson: string): void {
    let value: Record<string, unknown>
    try { value = objectArguments(argumentsJson, ['request_id'], ['request_id']) } catch { return }
    const requestId = value['request_id']
    if (typeof requestId !== 'string') return
    const track = call.requests.get(VoiceRequestId(requestId))
    if (track?.result !== undefined) this.notifyCompletion(call, track)
  }

  private notifyCompletion(call: LiveCall, track: RequestTrack): void {
    if (call.closed || track.completionNotified || track.result === undefined) return
    try {
      const request: VoiceCompletionRequest = {
        consumerId: call.consumerId,
        voiceSessionId: call.id,
        requestId: track.id,
        sessionId: track.sessionId,
        title: track.title,
        state: track.result.state,
      }
      this.ctx.emit('voice/completion-requested', request)
      track.completionNotified = true
    } catch {
      /* The settled request remains visible through get_voice_status when event forwarding fails. */
    }
  }

  private settleTrack(call: LiveCall, track: RequestTrack, result: TrackResult): void {
    if (track.result !== undefined) return
    track.result = result; call.requestsByMessage.delete(track.messageId); track.resolve(result)
    if (track.originEpoch !== call.responseEpoch) this.notifyCompletion(call, track)
  }

  private pruneSettledRequests(call: LiveCall): void {
    if (call.requests.size < MAX_TRACKED_REQUESTS) return
    for (const [id, track] of call.requests) {
      if (track.result === undefined) continue
      call.requests.delete(id)
      if (call.requests.size < MAX_TRACKED_REQUESTS) return
    }
  }

  private teardown(call: LiveCall, closeSocket = true, awaitActivation = true): Promise<void> {
    if (call.teardown !== undefined) return call.teardown
    const operation = this.performTeardown(call, closeSocket, awaitActivation)
    call.teardown = operation
    return operation
  }

  private async performTeardown(call: LiveCall, closeSocket: boolean, awaitActivation: boolean): Promise<void> {
    call.closed = true; call.state = 'stopping'; call.activationAbort.abort()
    this.stopSidebandHeartbeat(call)
    if (call.timer !== undefined) clearTimeout(call.timer)
    for (const pending of call.navigations.values()) { clearTimeout(pending.timer); pending.resolve(false) }
    call.navigations.clear()
    for (const record of call.creations.values()) {
      if (record.state !== 'waiting') continue
      clearTimeout(record.timer)
      record.resolve({ created: false, activated: false })
    }
    call.creations.clear()
    for (const track of call.requests.values()) {
      if (track.result === undefined) this.settleTrack(call, track, { state: 'voice_stopped', text: bound(track.text.join('\n')) })
    }
    try {
      if (awaitActivation) await call.activation
      const socket = call.socket
      const socketOpen = socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING
      if (closeSocket && socket !== undefined && socketOpen) await closeSocketAndWait(socket)
    } finally {
      for (const dispose of call.lifecycleDisposers.splice(0)) await dispose()
      if (this.lease.active?.call === call) this.lease.active = undefined
    }
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

function openSocket(url: string, apiKey: string, signal: AbortSignal, agent?: HttpAgent): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` }, agent })
    const onOpen = (): void => { cleanup(); resolve(socket) }
    const onFailure = (): void => { cleanup(); socket.close(); reject(new Error('activation failed')) }
    const onAbort = (): void => {
      cleanup()
      socket.once('error', () => {})
      socket.terminate()
      reject(new Error('activation aborted'))
    }
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
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
    const timer = setTimeout(() => {
      socket.terminate()
      resolve()
    }, 1000)
    socket.once('close', () => { clearTimeout(timer); resolve() })
    socket.close(1000, 'voice session stopped')
  })
}

export default OpenAiRealtimeVoiceService
