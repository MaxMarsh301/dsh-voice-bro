import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

/** Exact generated voice namespace selected by the Client Remote assembly. */
export type VoiceRemote = ClientRemote['voice']

/** Opaque logical Host voice-session id derived from the generated status operation. */
export type VoiceSessionId = Parameters<VoiceRemote['status']>[1]

/** Root face carrying generated Remote namespaces. */
export interface VoiceRemoteRoot { remote: ClientRemote }

/** Select the generated voice namespace. @param ctx - mounted Client Remote root. @returns generated voice operations. */
export function voiceRemoteFrom(ctx: VoiceRemoteRoot): VoiceRemote {
  return ctx.remote.voice
}
