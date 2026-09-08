/** JSON-safe public types for Host-managed global voice sessions. @module @deepseek-ai/dsh-voice/types */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  VoiceConsumerId, VoiceCreationId, VoiceNavigationId, VoiceRequestId, VoiceResponseEpoch, VoiceSessionId,
} from './brand.ts'
export type {
  VoiceConsumerId, VoiceCreationId, VoiceNavigationId, VoiceRequestId, VoiceResponseEpoch, VoiceSessionId,
} from './brand.ts'

/** Browser WebRTC offer and owning tab accepted by a voice provider. */
export interface VoiceStartRequest {
  /** Complete SDP offer. */
  sdp: string
  /** Ephemeral browser-tab identity used for addressed navigation. */
  consumerId: VoiceConsumerId
  /** Session visible when this call began, when one is selected. */
  foregroundSessionId?: SessionId
}

/** Browser answer and logical identity returned while sideband activation proceeds. */
export interface VoiceStartResult {
  /** Logical Host identity. */
  sessionId: VoiceSessionId
  /** SDP answer to install on the browser peer connection. */
  answerSdp: string
  /** Absolute Unix expiry time in milliseconds. */
  expiresAt: number
}

/** Public voice-session lifecycle, without provider identifiers. */
export type VoiceSessionState = 'connecting' | 'active' | 'stopping'

/** Current public voice-session status. */
export interface VoiceStatusResult {
  sessionId: VoiceSessionId
  state: VoiceSessionState
  /** True only after the authenticated server sideband is open. */
  sidebandReady: boolean
  startedAt: number
  expiresAt: number
  foregroundSessionId?: SessionId
}

/** Stable stopped postcondition. */
export interface VoiceStopResult {
  sessionId: VoiceSessionId
  stopped: true
}

/** Result of updating the browser's selected Session for one live voice call. */
export interface VoiceForegroundResult {
  sessionId: VoiceSessionId
  foregroundSessionId?: SessionId
}

/** Stable response-epoch ownership acknowledgement. */
export interface VoiceResponseEpochResult {
  sessionId: VoiceSessionId
  epoch: VoiceResponseEpoch
  claimed: true
}

/** Browser acknowledgement for one addressed navigation request. */
export interface VoiceNavigationAckRequest {
  navigationId: VoiceNavigationId
  activated: boolean
}

/** Stable acknowledgement postcondition. */
export interface VoiceNavigationAckResult {
  navigationId: VoiceNavigationId
  acknowledged: true
}

/** Host-to-browser request to display one ordinary Session. */
export interface VoiceNavigationRequest {
  consumerId: VoiceConsumerId
  voiceSessionId: VoiceSessionId
  navigationId: VoiceNavigationId
  sessionId: SessionId
  reason: 'user-requested' | 'response-ready'
}

/** Host-to-browser request to create, optionally name, and confirm activation of an ordinary Session within the provider-owned deadline. */
export interface VoiceCreationRequest {
  consumerId: VoiceConsumerId
  voiceSessionId: VoiceSessionId
  creationId: VoiceCreationId
  activationTimeoutMs: number
  title?: string
}

/** Browser result for one addressed Session creation request. */
export interface VoiceCreationAckRequest {
  creationId: VoiceCreationId
  created: boolean
  activated: boolean
  sessionId?: SessionId
}

/** Stable acknowledgement postcondition; providers accept identical repeats of the retained final result. */
export interface VoiceCreationAckResult {
  creationId: VoiceCreationId
  acknowledged: true
}

/** Host-to-browser signal that one voice-dispatched Session request has settled. */
export interface VoiceCompletionRequest {
  consumerId: VoiceConsumerId
  voiceSessionId: VoiceSessionId
  requestId: VoiceRequestId
  sessionId: SessionId
  title: string
  state: string
}

/** Summary exposed to the bounded Realtime voice shell. */
export interface VoiceThreadSummary {
  sessionId: SessionId
  title: string
  workspace?: string
  running: boolean
  updatedAt: number
  kind: 'ordinary' | 'subagent'
}

/** One accepted voice-to-thread operation. */
export interface VoiceThreadRequest {
  requestId: VoiceRequestId
  sessionId: SessionId
  disposition: 'started' | 'queued' | 'steered' | 'replacing'
  reveal: 'never' | 'immediately' | 'on-complete'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Address one browser tab and ask it to display a Session.
     * @param request - JSON-safe navigation command.
     * @mode emit
     */
    'voice/navigation-requested'(request: VoiceNavigationRequest): void
    /**
     * Address one browser tab and ask it to create and activate a Session through the normal Web runtime.
     * @param request - JSON-safe creation command.
     * @mode emit
     */
    'voice/creation-requested'(request: VoiceCreationRequest): void
    /**
     * Address one browser tab when a voice-dispatched Session request settles.
     * @param request - JSON-safe completion command.
     * @mode emit
     */
    'voice/completion-requested'(request: VoiceCompletionRequest): void
  }
}
