import type { ClientRemote, RpcResult, SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/** Ephemeral browser-tab identity accepted by the global voice Remote. */
export type VoiceConsumerId = string & { readonly __voiceConsumerId: unique symbol }

/** Opaque logical Host voice-session identity. */
export type VoiceSessionId = string & { readonly __voiceSessionId: unique symbol }

/** Opaque Host navigation command identity. */
export type VoiceNavigationId = string & { readonly __voiceNavigationId: unique symbol }

/** Opaque identity of one browser-owned Session creation request. */
export type VoiceCreationId = string & { readonly __voiceCreationId: unique symbol }

/** Opaque identity of one voice-dispatched Session request. */
export type VoiceRequestId = string & { readonly __voiceRequestId: unique symbol }

/** Opaque ownership generation for one gated phrase. */
export type VoiceResponseEpoch = string & { readonly __voiceResponseEpoch: unique symbol }

/** Browser offer and tab ownership sent to the global voice service. */
export interface VoiceStartRequest {
  sdp: string
  consumerId: VoiceConsumerId
  foregroundSessionId?: SessionId
}

/** Public global voice-call start result. */
export interface VoiceStartResult {
  sessionId: VoiceSessionId
  answerSdp: string
  expiresAt: number
}

/** Public global voice-call status. */
export interface VoiceStatusResult {
  sessionId: VoiceSessionId
  state: 'connecting' | 'active' | 'stopping'
  sidebandReady: boolean
  startedAt: number
  expiresAt: number
  foregroundSessionId?: SessionId
}

/** Host-to-browser request to display one Session. */
export interface VoiceNavigationRequest {
  consumerId: VoiceConsumerId
  voiceSessionId: VoiceSessionId
  navigationId: VoiceNavigationId
  sessionId: SessionId
  reason: 'user-requested' | 'response-ready'
}

/** Host-to-browser command to create and activate a Session through the normal Web runtime. */
export interface VoiceCreationRequest {
  consumerId: VoiceConsumerId
  voiceSessionId: VoiceSessionId
  creationId: VoiceCreationId
  activationTimeoutMs: number
  title?: string
}

/** Host-to-browser signal for a settled voice-dispatched Session request. */
export interface VoiceCompletionRequest {
  consumerId: VoiceConsumerId
  voiceSessionId: VoiceSessionId
  requestId: VoiceRequestId
  sessionId: SessionId
  title: string
  state: string
}

/** Global voice Remote operations consumed by this browser plugin. */
export interface VoiceRemote {
  start(request: VoiceStartRequest): Promise<RpcResult<VoiceStartResult>>
  status(sessionId: VoiceSessionId): Promise<RpcResult<VoiceStatusResult>>
  setForeground(
    sessionId: VoiceSessionId,
    foregroundSessionId: SessionId | undefined,
  ): Promise<RpcResult<{ sessionId: VoiceSessionId; foregroundSessionId?: SessionId }>>
  claimResponseEpoch(
    sessionId: VoiceSessionId,
    epoch: VoiceResponseEpoch,
  ): Promise<RpcResult<{ sessionId: VoiceSessionId; epoch: VoiceResponseEpoch; claimed: true }>>
  ackNavigation(
    sessionId: VoiceSessionId,
    request: { navigationId: VoiceNavigationId; activated: boolean },
  ): Promise<RpcResult<{ navigationId: VoiceNavigationId; acknowledged: true }>>
  ackCreation(
    sessionId: VoiceSessionId,
    request: { creationId: VoiceCreationId; created: boolean; activated: boolean; sessionId?: SessionId },
  ): Promise<RpcResult<{ creationId: VoiceCreationId; acknowledged: true }>>
  stop(sessionId: VoiceSessionId): Promise<RpcResult<{ sessionId: VoiceSessionId; stopped: true }>>
}

/** Root face carrying generated Remote namespaces. */
export interface VoiceRemoteRoot { remote: ClientRemote }

const CONSUMER_STORAGE_KEY = 'dsh.voice.consumer-id'
const CONSUMER_PAGE_KEY = Symbol.for('@deepseek-ai/dsh-client-ui-voice/consumer-id')

function storedConsumerId(): string | undefined {
  try {
    return sessionStorage.getItem(CONSUMER_STORAGE_KEY) ?? undefined
  } catch {
    /* Storage can be unavailable under browser privacy policy; page-local ownership still works. */
    return undefined
  }
}

function persistConsumerId(value: string): void {
  try {
    sessionStorage.setItem(CONSUMER_STORAGE_KEY, value)
  } catch {
    /* Storage can be unavailable under browser privacy policy; page-local ownership still works. */
  }
}

function isFreshNavigation(): boolean {
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return navigation?.type === 'navigate'
  } catch {
    /* Older browsers without Navigation Timing reuse the session-scoped identity. */
    return false
  }
}

/**
 * Create one browser-tab identity that survives reload and HMR but rotates for a new tab navigation.
 * @returns Stable identity for the current browser tab.
 */
export function createVoiceConsumerId(): VoiceConsumerId {
  const page = globalThis as unknown as Record<PropertyKey, unknown>
  const current = page[CONSUMER_PAGE_KEY]
  if (typeof current === 'string') return current as VoiceConsumerId
  const stored = storedConsumerId()
  const value = stored !== undefined && !isFreshNavigation() ? stored : crypto.randomUUID()
  page[CONSUMER_PAGE_KEY] = value
  persistConsumerId(value)
  return value as VoiceConsumerId
}

/**
 * Select the generated global voice namespace.
 * @param ctx - Mounted Client Remote root.
 * @returns Generated voice operations.
 */
export function voiceRemoteFrom(ctx: VoiceRemoteRoot): VoiceRemote {
  return ctx.remote.voice as unknown as VoiceRemote
}
