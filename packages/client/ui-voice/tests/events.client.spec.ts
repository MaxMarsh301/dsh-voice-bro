import { describe, expect, it } from 'vitest'
import { parseVoiceEvent } from '../src/client/events.ts'

describe('voice data-channel events', () => {
  it('separates tool, generation, and matching playback completion', () => {
    const tool = parseVoiceEvent(JSON.stringify({
      type: 'response.done', response: { id: 'tool-1', status: 'completed', output: [{ type: 'function_call' }] },
    }))
    const generated = parseVoiceEvent(JSON.stringify({
      type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [{ type: 'message' }] },
    }))
    const drained = parseVoiceEvent(JSON.stringify({
      type: 'output_audio_buffer.stopped', response_id: 'speech-1',
    }))
    expect([tool, generated, drained]).toEqual([
      { kind: 'response-tool', responseId: 'tool-1' },
      { kind: 'response-generation-final', responseId: 'speech-1' },
      { kind: 'response-playback-stopped', responseId: 'speech-1' },
    ])
  })

  it('finishes token-capped audio but rejects other incomplete responses', () => {
    expect(parseVoiceEvent({
      type: 'response.done',
      response: { id: 'speech-1', status: 'incomplete', status_details: { reason: 'max_output_tokens' } },
    })).toEqual({ kind: 'response-generation-final', responseId: 'speech-1' })
    expect(parseVoiceEvent({
      type: 'response.done',
      response: { id: 'speech-2', status: 'incomplete', status_details: { reason: 'content_filter' } },
    })).toEqual({ kind: 'response-error', code: 'provider-response', responseId: 'speech-2' })
  })

  it('accepts only string transcript fields', () => {
    expect(parseVoiceEvent('{"type":"response.audio_transcript.delta","delta":"safe"}'))
      .toEqual({ kind: 'transcript-delta', text: 'safe' })
    expect(parseVoiceEvent({ type: 'response.audio_transcript.delta', delta: { html: '<b>x</b>' } }))
      .toEqual({ kind: 'ignored' })
  })

  it('attaches exact Realtime usage without breaking lifecycle parsing when usage is malformed', () => {
    const response = {
      id: 'speech-usage', status: 'completed', output: [{ type: 'message' }],
      usage: {
        total_tokens: 18, input_tokens: 11, output_tokens: 7,
        input_token_details: {
          text_tokens: 5, audio_tokens: 6, cached_tokens: 3,
          cached_tokens_details: { text_tokens: 1, audio_tokens: 2 },
        },
        output_token_details: { text_tokens: 3, audio_tokens: 4 },
      },
    }
    expect(parseVoiceEvent({ type: 'response.done', response })).toEqual({
      kind: 'response-generation-final',
      responseId: 'speech-usage',
      usage: {
        inputTextTokens: 5, inputAudioTokens: 6, cachedTextTokens: 1,
        cachedAudioTokens: 2, outputTextTokens: 3, outputAudioTokens: 4,
      },
    })
    expect(parseVoiceEvent({
      type: 'response.done', response: { ...response, usage: { total_tokens: 18 } },
    })).toEqual({ kind: 'response-generation-final', responseId: 'speech-usage' })
  })

  it('parses token-form transcription usage separately and ignores duration usage', () => {
    expect(parseVoiceEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'transcription-1',
      usage: { type: 'tokens', total_tokens: 12, input_tokens: 9, output_tokens: 3 },
    })).toEqual({
      kind: 'transcription-usage', eventId: 'transcription-1', usage: { inputTokens: 9, outputTokens: 3 },
    })
    expect(parseVoiceEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'transcription-2',
      usage: { type: 'duration', seconds: 1.5 },
    })).toEqual({ kind: 'ignored' })
  })

  it('discards malformed input and raw provider errors', () => {
    expect(parseVoiceEvent('{')).toEqual({ kind: 'ignored' })
    expect(parseVoiceEvent({ type: 'error', error: { message: '<secret provider detail>' } }))
      .toEqual({ kind: 'response-error', code: 'provider-response' })
  })
})
