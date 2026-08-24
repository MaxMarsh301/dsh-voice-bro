/** Service Definition for Host-managed voice sessions addressed by live Agent lookup. @module @deepseek-ai/dsh-voice */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { VoiceSessionId as VoiceSessionIdValue } from './brand.ts'
import type { VoiceStartRequest, VoiceStartResult, VoiceStatusResult, VoiceStopResult } from './types.ts'

export * from './brand.ts'
export type { VoiceSessionState, VoiceStartRequest, VoiceStartResult, VoiceStatusResult, VoiceStopResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { voice: VoiceService }
}

/** Provider-neutral owner of at most one live voice call per Agent. */
export abstract class VoiceService extends TypertRemoteService {
  protected constructor(ctx: Context) { super(ctx, 'voice') }

  /** Start a voice call for one exact live Agent. @param agent - Agent resolved from the wire agent id. @param request - Browser SDP offer. @returns logical id, SDP answer, and expiry. */
  abstract start(agent: Agent, request: VoiceStartRequest): Promise<VoiceStartResult>

  /** Remote adapter for {@link start}. @param agent - Agent resolved from the wire agent id. @param request - Browser SDP offer. @returns logical id, SDP answer, and expiry. */
  @Remote('start')
  remoteExportStart(agent: Agent, request: VoiceStartRequest): Promise<VoiceStartResult> { return this.start(agent, request) }

  /** Inspect one call owned by the addressed Agent. @param agent - Agent resolved from the wire agent id. @param sessionId - Logical call id. @returns current public lifecycle facts. */
  abstract status(agent: Agent, sessionId: VoiceSessionIdValue): Promise<VoiceStatusResult>

  /** Remote adapter for {@link status}. @param agent - Agent resolved from the wire agent id. @param sessionId - Logical call id. @returns current public lifecycle facts. */
  @Remote('status')
  remoteExportStatus(agent: Agent, sessionId: VoiceSessionIdValue): Promise<VoiceStatusResult> { return this.status(agent, sessionId) }

  /** Stop one call owned by the addressed Agent. @param agent - Agent resolved from the wire agent id. @param sessionId - Logical call id. @returns stable stopped postcondition. */
  abstract stop(agent: Agent, sessionId: VoiceSessionIdValue): Promise<VoiceStopResult>

  /** Remote adapter for {@link stop}. @param agent - Agent resolved from the wire agent id. @param sessionId - Logical call id. @returns stable stopped postcondition. */
  @Remote('stop')
  remoteExportStop(agent: Agent, sessionId: VoiceSessionIdValue): Promise<VoiceStopResult> { return this.stop(agent, sessionId) }
}

export default VoiceService
