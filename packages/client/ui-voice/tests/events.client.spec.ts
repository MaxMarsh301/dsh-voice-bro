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
    })).toEqual({ kind: 'response-error', code: 'provider-response', detail: 'content_filter', responseId: 'speech-2' })
  })

  it('normalizes allowlisted model actions and bounds the planned thread request', () => {
    expect(parseVoiceEvent({
      type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'thread_turn',
      arguments: JSON.stringify({ prompt: '  Проверить архитектуру  ' }),
    })).toEqual({
      kind: 'activity-step', callId: 'call-1', tool: 'thread_turn', plannedText: 'Проверить архитектуру',
    })
    expect(parseVoiceEvent({
      type: 'response.output_item.done', item: {
        type: 'function_call', call_id: 'call-2', name: 'wait_for_thread', arguments: '{}',
      },
    })).toEqual({ kind: 'activity-step', callId: 'call-2', tool: 'wait_for_thread' })
    const bounded = parseVoiceEvent({
      type: 'response.function_call_arguments.done', call_id: 'call-3', name: 'thread_turn',
      arguments: JSON.stringify({ prompt: 'x'.repeat(2_100) }),
    })
    expect(bounded).toMatchObject({ kind: 'activity-step', plannedText: 'x'.repeat(2_000) })
  })

  it('labels known actions without reflecting malformed or unknown arguments', () => {
    expect(parseVoiceEvent({
      type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'thread_turn', arguments: '{',
    })).toEqual({ kind: 'activity-step', callId: 'call-1', tool: 'thread_turn' })
    expect(parseVoiceEvent({
      type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'shell', arguments: '{}',
    })).toEqual({ kind: 'ignored' })
    expect(parseVoiceEvent({
      type: 'response.function_call_arguments.done', call_id: '', name: 'read_thread', arguments: '{}',
    })).toEqual({ kind: 'ignored' })
  })

  it('accepts only owned string transcript fields', () => {
    expect(parseVoiceEvent('{"type":"response.audio_transcript.delta","response_id":"speech-1","delta":"safe"}'))
      .toEqual({ kind: 'transcript-delta', responseId: 'speech-1', text: 'safe' })
    expect(parseVoiceEvent({ type: 'response.audio_transcript.delta', response_id: 'speech-1', delta: { html: '<b>x</b>' } }))
      .toEqual({ kind: 'ignored' })
    expect(parseVoiceEvent({ type: 'response.audio_transcript.delta', delta: 'unowned' }))
      .toEqual({ kind: 'ignored' })
  })

  it('parses the response id and metadata that establish ownership', () => {
    expect(parseVoiceEvent({
      type: 'response.created', response: { id: 'speech-1', metadata: { dsh_response_epoch: 'epoch-1' } },
    })).toEqual({ kind: 'response-started', responseId: 'speech-1', epoch: 'epoch-1' })
    expect(parseVoiceEvent({ type: 'response.created', response: { id: 'speech-1' } })).toEqual({ kind: 'ignored' })
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

  it('parses committed item ownership and token-form transcription usage', () => {
    expect(parseVoiceEvent({ type: 'input_audio_buffer.committed', item_id: 'item-1' }))
      .toEqual({ kind: 'input-committed', itemId: 'item-1' })
    expect(parseVoiceEvent({ type: 'input_audio_buffer.committed' })).toEqual({ kind: 'ignored' })
    expect(parseVoiceEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      event_id: 'transcription-1',
      usage: { type: 'tokens', total_tokens: 12, input_tokens: 9, output_tokens: 3 },
    })).toEqual({
      kind: 'transcription-usage', itemId: 'item-1', eventId: 'transcription-1', usage: { inputTokens: 9, outputTokens: 3 },
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
    expect(parseVoiceEvent({ type: 'error', error: { code: 'audio_buffer_too_small', message: '<secret provider detail>' } }))
      .toEqual({ kind: 'response-error', code: 'provider-response', detail: 'audio_buffer_too_small' })
  })
})
