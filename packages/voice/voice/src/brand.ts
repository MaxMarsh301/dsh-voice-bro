/** Runtime and type identity for Host-managed logical voice sessions. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque logical id that never reveals a provider call id. */
export type VoiceSessionId = Branded<'VoiceSessionId'>

/** Brand one Host-created logical voice-session id. @param value - validated opaque value. @returns branded id. */
export const VoiceSessionId = (value: string): VoiceSessionId => value as VoiceSessionId
