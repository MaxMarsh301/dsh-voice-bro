import {
  parseRealtimeTokenUsage, parseTranscriptionTokenUsage,
  type RealtimeTokenUsage, type TranscriptionTokenUsage,
} from './cost.ts'

/** Safe UI-relevant interpretation of a Realtime data-channel event. */
export type VoiceEvent =
  | { kind: 'transcript-delta'; text: string }
  | { kind: 'transcript-final'; text: string }
  | { kind: 'transcription-usage'; eventId?: string; usage: TranscriptionTokenUsage }
  | { kind: 'response-started' }
  | { kind: 'response-tool'; responseId: string; usage?: RealtimeTokenUsage }
  | { kind: 'response-generation-final'; responseId: string; usage?: RealtimeTokenUsage }
  | { kind: 'response-playback-stopped'; responseId: string }
  | { kind: 'response-error'; code: 'provider-response'; responseId?: string; usage?: RealtimeTokenUsage }
  | { kind: 'ignored' }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse only lifecycle and transcript events used by the UI. Unknown and
 * malformed events are ignored rather than reflected into the DOM.
 * @param raw - data-channel payload.
 * @returns one normalized UI event.
 */
export function parseVoiceEvent(raw: unknown): VoiceEvent {
  let decoded: unknown = raw
  if (typeof raw === 'string') {
    try {
      decoded = JSON.parse(raw) as unknown
    } catch {
      return { kind: 'ignored' }
    }
  }
  const event = record(decoded)
  const type = text(event?.type)
  if (type === 'response.created') return { kind: 'response-started' }
  if (type === 'output_audio_buffer.stopped') {
    const responseId = text(event?.response_id)
    return responseId === undefined ? { kind: 'ignored' } : { kind: 'response-playback-stopped', responseId }
  }
  if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {
    const delta = text(event?.delta)
    return delta === undefined ? { kind: 'ignored' } : { kind: 'transcript-delta', text: delta }
  }
  if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {
    const transcript = text(event?.transcript)
    return transcript === undefined ? { kind: 'ignored' } : { kind: 'transcript-final', text: transcript }
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    const usage = parseTranscriptionTokenUsage(event?.usage)
    if (usage === undefined) return { kind: 'ignored' }
    const eventId = text(event?.event_id)
    return eventId === undefined
      ? { kind: 'transcription-usage', usage }
      : { kind: 'transcription-usage', eventId, usage }
  }
  if (type === 'error') return { kind: 'response-error', code: 'provider-response' }
  if (type !== 'response.done') return { kind: 'ignored' }

  const response = record(event?.response)
  const responseId = text(response?.id)
  if (responseId === undefined) return { kind: 'ignored' }
  const usage = parseRealtimeTokenUsage(response?.usage)
  const output = Array.isArray(response?.output) ? response.output : []
  const containsTool = output.some((item) => {
    const outputItem = record(item)
    return outputItem?.type === 'function_call' || outputItem?.type === 'tool_call'
  })
  if (containsTool) return { kind: 'response-tool', responseId, ...(usage === undefined ? {} : { usage }) }

  const status = text(response?.status)
  const statusDetails = record(response?.status_details)
  if (status === 'incomplete' && text(statusDetails?.reason) === 'max_output_tokens') {
    return { kind: 'response-generation-final', responseId, ...(usage === undefined ? {} : { usage }) }
  }
  if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
    return { kind: 'response-error', code: 'provider-response', responseId, ...(usage === undefined ? {} : { usage }) }
  }
  return { kind: 'response-generation-final', responseId, ...(usage === undefined ? {} : { usage }) }
}

/** Events sent over the ordered `oai-events` data channel. */
export const clientEvent = {
  clear: () => ({ type: 'input_audio_buffer.clear' }),
  append: (audio: string) => ({ type: 'input_audio_buffer.append', audio }),
  commit: () => ({ type: 'input_audio_buffer.commit' }),
  createResponse: () => ({ type: 'response.create' }),
  cancelResponse: () => ({ type: 'response.cancel' }),
  clearOutput: () => ({ type: 'output_audio_buffer.clear' }),
} as const
