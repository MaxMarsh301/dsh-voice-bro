import { describe, expect, it, vi } from 'vitest'
import {
  VoiceCostAccumulator, calculateRealtimeCost, calculateTranscriptionCost,
  parseRealtimeTokenUsage, parseTranscriptionTokenUsage, voiceCostSnapshotIssue,
} from '../src/client/cost.ts'

const realtimeReport = {
  total_tokens: 220,
  input_tokens: 150,
  output_tokens: 70,
  input_token_details: {
    text_tokens: 100,
    audio_tokens: 50,
    cached_tokens: 30,
    cached_tokens_details: { text_tokens: 20, audio_tokens: 10 },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 40 },
}

const realtimeUsage = {
  inputTextTokens: 100,
  inputAudioTokens: 50,
  cachedTextTokens: 20,
  cachedAudioTokens: 10,
  outputTextTokens: 30,
  outputAudioTokens: 40,
}

const transcriptionUsage = { inputTokens: 80, outputTokens: 20 }

describe('voice cost accounting', () => {
  it('parses complete consistent modality and cached token details', () => {
    expect(parseRealtimeTokenUsage(realtimeReport)).toEqual(realtimeUsage)
    expect(parseRealtimeTokenUsage({
      ...realtimeReport,
      input_token_details: { ...realtimeReport.input_token_details, cached_tokens: 31 },
    })).toBeUndefined()
    expect(parseRealtimeTokenUsage({
      ...realtimeReport,
      output_token_details: { text_tokens: 30 },
    })).toBeUndefined()
    expect(parseRealtimeTokenUsage({
      total_tokens: Number.MAX_SAFE_INTEGER,
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
      input_token_details: {
        text_tokens: Number.MAX_SAFE_INTEGER,
        audio_tokens: 0,
        cached_tokens: 0,
        cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 0, audio_tokens: 0 },
    })).toBeUndefined()
  })

  it('parses only complete transcription token reports', () => {
    expect(parseTranscriptionTokenUsage({
      type: 'tokens', total_tokens: 100, input_tokens: 80, output_tokens: 20,
    })).toEqual(transcriptionUsage)
    expect(parseTranscriptionTokenUsage({ type: 'duration', seconds: 4.2 })).toBeUndefined()
    expect(parseTranscriptionTokenUsage({ type: 'tokens', input_tokens: 80 })).toBeUndefined()
  })

  it('subtracts cached tokens by modality and charges cached input once', () => {
    expect(calculateRealtimeCost(realtimeUsage)).toEqual({
      audioNanoUsd: 1_200_000,
      textNanoUsd: 120_000,
      cachedInputNanoUsd: 4_200,
      transcriptionNanoUsd: 0,
      totalNanoUsd: 1_324_200,
    })
    expect(calculateTranscriptionCost(transcriptionUsage)).toEqual({
      audioNanoUsd: 0,
      textNanoUsd: 0,
      cachedInputNanoUsd: 0,
      transcriptionNanoUsd: 200_000,
      totalNanoUsd: 200_000,
    })
  })

  it('uses distinct cached text and audio rates', () => {
    expect(calculateRealtimeCost({
      inputTextTokens: 1, inputAudioTokens: 0, cachedTextTokens: 1, cachedAudioTokens: 0,
      outputTextTokens: 0, outputAudioTokens: 0,
    }).cachedInputNanoUsd).toBe(60)
    expect(calculateRealtimeCost({
      inputTextTokens: 0, inputAudioTokens: 1, cachedTextTokens: 0, cachedAudioTokens: 1,
      outputTextTokens: 0, outputAudioTokens: 0,
    }).cachedInputNanoUsd).toBe(300)
  })

  it('rejects malicious reports and cumulative totals that cannot remain exact', () => {
    const maxSafeTokens = Math.floor(Number.MAX_SAFE_INTEGER / 20_000)
    const oversized = {
      total_tokens: maxSafeTokens + 1,
      input_tokens: 0,
      output_tokens: maxSafeTokens + 1,
      input_token_details: {
        text_tokens: 0, audio_tokens: 0, cached_tokens: 0,
        cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 0, audio_tokens: maxSafeTokens + 1 },
    }
    expect(parseRealtimeTokenUsage(oversized)).toBeUndefined()

    const maximum = parseRealtimeTokenUsage({
      ...oversized,
      total_tokens: maxSafeTokens,
      output_tokens: maxSafeTokens,
      output_token_details: { text_tokens: 0, audio_tokens: maxSafeTokens },
    })
    expect(maximum).toBeDefined()
    const costs = new VoiceCostAccumulator()
    expect(costs.addRealtime(maximum!, 'maximum-1')).toBe(true)
    const exactTotal = costs.snapshot().sessionTotal.totalNanoUsd
    expect(Number.isSafeInteger(exactTotal)).toBe(true)
    expect(costs.addRealtime(maximum!, 'maximum-2')).toBe(false)
    expect(costs.snapshot().sessionTotal.totalNanoUsd).toBe(exactTotal)
  })

  it('deduplicates ids and resets only the current request', () => {
    const costs = new VoiceCostAccumulator()
    expect(costs.addRealtime(realtimeUsage, 'response-1')).toBe(true)
    expect(costs.addRealtime(realtimeUsage, 'response-1')).toBe(false)
    expect(costs.addTranscription(transcriptionUsage, 'event-1')).toBe(true)
    expect(costs.addTranscription(transcriptionUsage, 'event-1')).toBe(false)
    expect(costs.snapshot()).toMatchObject({
      currentRequest: { totalNanoUsd: 1_524_200 },
      sessionTotal: { totalNanoUsd: 1_524_200 },
      currentRequestReported: true,
      sessionReported: true,
    })

    costs.beginRequest()
    expect(costs.snapshot()).toMatchObject({
      currentRequest: { totalNanoUsd: 0 },
      sessionTotal: { totalNanoUsd: 1_524_200 },
      currentRequestReported: false,
      sessionReported: true,
    })
    expect(costs.addRealtime(realtimeUsage, 'retired-response', false)).toBe(true)
    expect(costs.snapshot()).toMatchObject({
      currentRequest: { totalNanoUsd: 0 },
      sessionTotal: { totalNanoUsd: 2_848_400 },
      currentRequestReported: false,
    })
    expect(costs.addTranscription(transcriptionUsage, 'retired-transcription', false)).toBe(true)
    expect(costs.snapshot()).toMatchObject({
      currentRequest: { totalNanoUsd: 0 },
      sessionTotal: { totalNanoUsd: 3_048_400 },
    })
    expect(costs.addRealtime(realtimeUsage)).toBe(true)
    expect(costs.snapshot().sessionTotal.totalNanoUsd).toBe(4_372_600)
  })

  it('validates every relation consumed by the voice plaque', () => {
    const costs = new VoiceCostAccumulator()
    costs.addRealtime(realtimeUsage)
    const valid = costs.snapshot()
    expect(voiceCostSnapshotIssue(valid)).toBeUndefined()
    expect(voiceCostSnapshotIssue({
      ...valid,
      currentRequest: { ...valid.currentRequest, totalNanoUsd: valid.currentRequest.totalNanoUsd + 1 },
    })).toBe('current request total does not match its categories')
    expect(voiceCostSnapshotIssue({ ...valid, sessionReported: false })).toBe('reported current request has no reported session total')
    expect(voiceCostSnapshotIssue({
      ...valid,
      currentRequest: { ...valid.currentRequest, audioNanoUsd: valid.sessionTotal.audioNanoUsd + 1, totalNanoUsd: valid.sessionTotal.totalNanoUsd + 1 },
    })).toBe('current request exceeds the accumulated session total')
  })

  it('logs and preserves exact totals when accumulation would overflow', () => {
    const report = vi.fn()
    const costs = new VoiceCostAccumulator(report)
    const maxSafeTokens = Math.floor(Number.MAX_SAFE_INTEGER / 20_000)
    const maximum = parseRealtimeTokenUsage({
      total_tokens: maxSafeTokens,
      input_tokens: 0,
      output_tokens: maxSafeTokens,
      input_token_details: {
        text_tokens: 0, audio_tokens: 0, cached_tokens: 0,
        cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 0, audio_tokens: maxSafeTokens },
    })!
    expect(costs.addRealtime(maximum, 'first')).toBe(true)
    expect(costs.addRealtime(maximum, 'second')).toBe(false)
    expect(report).toHaveBeenCalledWith('cumulative nano-USD total exceeded the safe integer range')
  })
})
