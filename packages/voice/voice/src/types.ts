/** JSON-safe public types for Host-managed voice sessions. @module @deepseek-ai/dsh-voice/types */

import type { VoiceSessionId } from './brand.ts'
export type { VoiceSessionId } from './brand.ts'

/** Browser WebRTC offer accepted by a voice provider. */
export interface VoiceStartRequest {
  /** Complete SDP offer. */
  sdp: string
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
}

/** Stable stopped postcondition. */
export interface VoiceStopResult {
  sessionId: VoiceSessionId
  stopped: true
}
