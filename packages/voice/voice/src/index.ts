/** Service Definition for Host-managed global voice sessions. @module @deepseek-ai/dsh-voice */

import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  VoiceResponseEpoch, VoiceSessionId as VoiceSessionIdValue,
} from './brand.ts'
import type {
  VoiceCreationAckRequest, VoiceCreationAckResult, VoiceForegroundResult, VoiceNavigationAckRequest,
  VoiceNavigationAckResult, VoiceResponseEpochResult, VoiceStartRequest, VoiceStartResult, VoiceStatusResult, VoiceStopResult,
} from './types.ts'

export * from './brand.ts'
export type {
  VoiceCompletionRequest, VoiceCreationAckRequest, VoiceCreationAckResult, VoiceCreationRequest,
  VoiceForegroundResult, VoiceNavigationAckRequest, VoiceNavigationAckResult,
  VoiceNavigationRequest, VoiceResponseEpochResult, VoiceSessionState, VoiceStartRequest, VoiceStartResult,
  VoiceStatusResult, VoiceStopResult, VoiceThreadRequest, VoiceThreadSummary,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { voice: VoiceService }
}

/** Provider-neutral owner of one Host-global live voice call. */
export abstract class VoiceService extends TypertRemoteService {
  protected constructor(ctx: Context) { super(ctx, 'voice') }

  /**
   * Start the global voice call owned by one browser tab.
   * @param request - Browser SDP offer, tab identity, and current Session.
   * @returns Logical id, SDP answer, and expiry.
   */
  abstract start(request: VoiceStartRequest): Promise<VoiceStartResult>

  /**
   * Remote adapter for {@link start}.
   * @param request - Browser SDP offer, tab identity, and current Session.
   * @returns Logical id, SDP answer, and expiry.
   */
  @Remote('start')
  remoteExportStart(request: VoiceStartRequest): Promise<VoiceStartResult> { return this.start(request) }

  /**
   * Inspect one global call.
   * @param sessionId - Logical call id.
   * @returns Current public lifecycle facts.
   */
  abstract status(sessionId: VoiceSessionIdValue): Promise<VoiceStatusResult>

  /**
   * Remote adapter for {@link status}.
   * @param sessionId - Logical call id.
   * @returns Current public lifecycle facts.
   */
  @Remote('status')
  remoteExportStatus(sessionId: VoiceSessionIdValue): Promise<VoiceStatusResult> { return this.status(sessionId) }

  /**
   * Update the Session currently visible in the owning browser tab.
   * @param sessionId - Logical call id.
   * @param foregroundSessionId - Visible Session, or undefined for the empty state.
   * @returns Updated foreground identity.
   */
  abstract setForeground(sessionId: VoiceSessionIdValue, foregroundSessionId: SessionId | undefined): Promise<VoiceForegroundResult>

  /**
   * Remote adapter for {@link setForeground}.
   * @param sessionId - Logical call id.
   * @param foregroundSessionId - Visible Session, or undefined.
   * @returns Updated foreground identity.
   */
  @Remote('setForeground')
  remoteExportSetForeground(sessionId: VoiceSessionIdValue, foregroundSessionId: SessionId | undefined): Promise<VoiceForegroundResult> {
    return this.setForeground(sessionId, foregroundSessionId)
  }

  /**
   * Make one gated phrase the sole owner of future response continuation.
   * @param sessionId - Logical call id.
   * @param epoch - Browser-minted phrase generation.
   * @returns Stable ownership acknowledgement.
   */
  abstract claimResponseEpoch(sessionId: VoiceSessionIdValue, epoch: VoiceResponseEpoch): Promise<VoiceResponseEpochResult>

  /**
   * Remote adapter for {@link claimResponseEpoch}.
   * @param sessionId - Logical call id.
   * @param epoch - Browser-minted phrase generation.
   * @returns Stable ownership acknowledgement.
   */
  @Remote('claimResponseEpoch')
  remoteExportClaimResponseEpoch(sessionId: VoiceSessionIdValue, epoch: VoiceResponseEpoch): Promise<VoiceResponseEpochResult> {
    return this.claimResponseEpoch(sessionId, epoch)
  }

  /**
   * Acknowledge one Host-requested browser navigation.
   * @param sessionId - Logical call id.
   * @param request - Navigation identity and outcome.
   * @returns Stable acknowledgement postcondition.
   */
  abstract ackNavigation(sessionId: VoiceSessionIdValue, request: VoiceNavigationAckRequest): Promise<VoiceNavigationAckResult>

  /**
   * Remote adapter for {@link ackNavigation}.
   * @param sessionId - Logical call id.
   * @param request - Navigation identity and outcome.
   * @returns Stable acknowledgement postcondition.
   */
  @Remote('ackNavigation')
  remoteExportAckNavigation(sessionId: VoiceSessionIdValue, request: VoiceNavigationAckRequest): Promise<VoiceNavigationAckResult> {
    return this.ackNavigation(sessionId, request)
  }

  /**
   * Acknowledge one browser-owned Session creation attempt; an identical repeat returns the same stable postcondition.
   * @param sessionId - Logical call id.
   * @param request - Creation identity and committed browser result.
   * @returns Stable acknowledgement postcondition.
   */
  abstract ackCreation(sessionId: VoiceSessionIdValue, request: VoiceCreationAckRequest): Promise<VoiceCreationAckResult>

  /**
   * Remote adapter for {@link ackCreation}.
   * @param sessionId - Logical call id.
   * @param request - Creation identity and committed browser result.
   * @returns Stable acknowledgement postcondition.
   */
  @Remote('ackCreation')
  remoteExportAckCreation(sessionId: VoiceSessionIdValue, request: VoiceCreationAckRequest): Promise<VoiceCreationAckResult> {
    return this.ackCreation(sessionId, request)
  }

  /**
   * Stop the global call.
   * @param sessionId - Logical call id.
   * @returns Stable stopped postcondition.
   */
  abstract stop(sessionId: VoiceSessionIdValue): Promise<VoiceStopResult>

  /**
   * Remote adapter for {@link stop}.
   * @param sessionId - Logical call id.
   * @returns Stable stopped postcondition.
   */
  @Remote('stop')
  remoteExportStop(sessionId: VoiceSessionIdValue): Promise<VoiceStopResult> { return this.stop(sessionId) }
}

export default VoiceService
