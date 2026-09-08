import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  VoiceConsumerId, VoiceNavigationRequest, VoiceRemote, VoiceSessionId,
} from './remote-adapter.ts'

/** Dependencies for one addressed Host-to-browser navigation command. */
export interface VoiceNavigationDeps {
  consumerId: VoiceConsumerId
  ownsVoiceSession(sessionId: VoiceSessionId): boolean
  open(sessionId: SessionId): void
  current(): SessionId | undefined
  remote: Pick<VoiceRemote, 'ackNavigation'>
}

/**
 * Open and acknowledge one navigation command only for its owning tab and live call.
 * @param request - forwarded Host command.
 * @param deps - current tab, call, navigation, and Remote operations.
 */
export async function handleVoiceNavigation(
  request: VoiceNavigationRequest,
  deps: VoiceNavigationDeps,
): Promise<void> {
  if (request.consumerId !== deps.consumerId || !deps.ownsVoiceSession(request.voiceSessionId)) return
  let activated = false
  try {
    deps.open(request.sessionId)
    activated = deps.current() === request.sessionId
  } catch {
    activated = false
  }
  await deps.remote.ackNavigation(request.voiceSessionId, {
    navigationId: request.navigationId,
    activated,
  })
}
