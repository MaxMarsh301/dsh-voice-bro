/** Exact provider token counts used by the Realtime price calculator. */
export interface RealtimeTokenUsage {
  inputTextTokens: number
  inputAudioTokens: number
  cachedTextTokens: number
  cachedAudioTokens: number
  outputTextTokens: number
  outputAudioTokens: number
}

/** Exact token counts reported by the input transcription service. */
export interface TranscriptionTokenUsage {
  inputTokens: number
  outputTokens: number
}

/** Integer nano-USD totals grouped for voice-session presentation. */
export interface VoiceCostBreakdown {
  audioNanoUsd: number
  textNanoUsd: number
  cachedInputNanoUsd: number
  transcriptionNanoUsd: number
  totalNanoUsd: number
}

/** Current-request and controller-lifetime voice costs. */
export interface VoiceCostSnapshot {
  currentRequest: VoiceCostBreakdown
  sessionTotal: VoiceCostBreakdown
  currentRequestReported: boolean
  sessionReported: boolean
}

const NANO_USD_PER_REALTIME_TEXT_INPUT_TOKEN = 600
const NANO_USD_PER_REALTIME_CACHED_TEXT_INPUT_TOKEN = 60
const NANO_USD_PER_REALTIME_TEXT_OUTPUT_TOKEN = 2_400
const NANO_USD_PER_REALTIME_AUDIO_INPUT_TOKEN = 10_000
const NANO_USD_PER_REALTIME_CACHED_AUDIO_INPUT_TOKEN = 300
const NANO_USD_PER_REALTIME_AUDIO_OUTPUT_TOKEN = 20_000
const NANO_USD_PER_TRANSCRIPTION_INPUT_TOKEN = 1_250
const NANO_USD_PER_TRANSCRIPTION_OUTPUT_TOKEN = 5_000
const MAX_NANO_USD_PER_TOKEN = NANO_USD_PER_REALTIME_AUDIO_OUTPUT_TOKEN
const MAX_REPORTED_TOKENS = Math.floor(Number.MAX_SAFE_INTEGER / MAX_NANO_USD_PER_TOKEN)

const EMPTY_COST: VoiceCostBreakdown = {
  audioNanoUsd: 0,
  textNanoUsd: 0,
  cachedInputNanoUsd: 0,
  transcriptionNanoUsd: 0,
  totalNanoUsd: 0,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function tokens(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REPORTED_TOKENS
    ? value as number
    : undefined
}

function sumCost(left: VoiceCostBreakdown, right: VoiceCostBreakdown): VoiceCostBreakdown | undefined {
  const sum: VoiceCostBreakdown = {
    audioNanoUsd: left.audioNanoUsd + right.audioNanoUsd,
    textNanoUsd: left.textNanoUsd + right.textNanoUsd,
    cachedInputNanoUsd: left.cachedInputNanoUsd + right.cachedInputNanoUsd,
    transcriptionNanoUsd: left.transcriptionNanoUsd + right.transcriptionNanoUsd,
    totalNanoUsd: left.totalNanoUsd + right.totalNanoUsd,
  }
  return Object.values(sum).every(value => Number.isSafeInteger(value) && value >= 0) ? sum : undefined
}

function breakdownIssue(name: string, cost: VoiceCostBreakdown): string | undefined {
  const values = Object.values(cost)
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return `${name} contains an invalid nano-USD value`
  const categories = cost.audioNanoUsd + cost.textNanoUsd + cost.cachedInputNanoUsd + cost.transcriptionNanoUsd
  if (!Number.isSafeInteger(categories) || categories !== cost.totalNanoUsd) return `${name} total does not match its categories`
  return undefined
}

/**
 * Validate the cost relation consumed by the voice plaque.
 * @param snapshot - controller-published request and call totals.
 * @returns a stable diagnostic without provider content, or undefined when display is safe.
 */
export function voiceCostSnapshotIssue(snapshot: VoiceCostSnapshot): string | undefined {
  const requestIssue = breakdownIssue('current request', snapshot.currentRequest)
  if (requestIssue !== undefined) return requestIssue
  const sessionIssue = breakdownIssue('session', snapshot.sessionTotal)
  if (sessionIssue !== undefined) return sessionIssue
  if (snapshot.currentRequestReported && !snapshot.sessionReported) {
    return 'reported current request has no reported session total'
  }
  if (!snapshot.currentRequestReported && snapshot.currentRequest.totalNanoUsd !== 0) {
    return 'unreported current request has a non-zero total'
  }
  if (!snapshot.sessionReported && snapshot.sessionTotal.totalNanoUsd !== 0) {
    return 'unreported session has a non-zero total'
  }
  const request = snapshot.currentRequest
  const session = snapshot.sessionTotal
  if (
    request.audioNanoUsd > session.audioNanoUsd
    || request.textNanoUsd > session.textNanoUsd
    || request.cachedInputNanoUsd > session.cachedInputNanoUsd
    || request.transcriptionNanoUsd > session.transcriptionNanoUsd
    || request.totalNanoUsd > session.totalNanoUsd
  ) return 'current request exceeds the accumulated session total'
  return undefined
}

/**
 * Parse a complete, internally consistent Realtime token report.
 * @param value - `response.done.response.usage` from the provider.
 * @returns normalized modality counts, or undefined for incomplete data.
 */
export function parseRealtimeTokenUsage(value: unknown): RealtimeTokenUsage | undefined {
  const usage = record(value)
  const inputDetails = record(usage?.input_token_details)
  const cachedDetails = record(inputDetails?.cached_tokens_details)
  const outputDetails = record(usage?.output_token_details)
  const totalTokens = tokens(usage?.total_tokens)
  const inputTokens = tokens(usage?.input_tokens)
  const outputTokens = tokens(usage?.output_tokens)
  const inputTextTokens = tokens(inputDetails?.text_tokens)
  const inputAudioTokens = tokens(inputDetails?.audio_tokens)
  const cachedTokens = tokens(inputDetails?.cached_tokens)
  const cachedTextTokens = tokens(cachedDetails?.text_tokens)
  const cachedAudioTokens = tokens(cachedDetails?.audio_tokens)
  const outputTextTokens = tokens(outputDetails?.text_tokens)
  const outputAudioTokens = tokens(outputDetails?.audio_tokens)
  if (
    totalTokens === undefined || inputTokens === undefined || outputTokens === undefined
    || inputTextTokens === undefined || inputAudioTokens === undefined || cachedTokens === undefined
    || cachedTextTokens === undefined || cachedAudioTokens === undefined
    || outputTextTokens === undefined || outputAudioTokens === undefined
  ) return undefined
  if (
    inputTextTokens + inputAudioTokens !== inputTokens
    || outputTextTokens + outputAudioTokens !== outputTokens
    || inputTokens + outputTokens !== totalTokens
    || cachedTextTokens + cachedAudioTokens !== cachedTokens
    || cachedTextTokens > inputTextTokens
    || cachedAudioTokens > inputAudioTokens
  ) return undefined
  return {
    inputTextTokens,
    inputAudioTokens,
    cachedTextTokens,
    cachedAudioTokens,
    outputTextTokens,
    outputAudioTokens,
  }
}

/**
 * Parse token-form input transcription usage without estimating duration-form billing.
 * @param value - `conversation.item.input_audio_transcription.completed.usage`.
 * @returns exact token totals, or undefined for duration/incomplete data.
 */
export function parseTranscriptionTokenUsage(value: unknown): TranscriptionTokenUsage | undefined {
  const usage = record(value)
  if (usage?.type !== 'tokens') return undefined
  const totalTokens = tokens(usage.total_tokens)
  const inputTokens = tokens(usage.input_tokens)
  const outputTokens = tokens(usage.output_tokens)
  if (
    totalTokens === undefined || inputTokens === undefined || outputTokens === undefined
    || inputTokens + outputTokens !== totalTokens
  ) return undefined
  return { inputTokens, outputTokens }
}

/**
 * Price one Realtime response using gpt-realtime-2.1-mini modality rates.
 * @param usage - normalized complete provider usage.
 * @returns exact integer nano-USD category totals.
 */
export function calculateRealtimeCost(usage: RealtimeTokenUsage): VoiceCostBreakdown {
  const uncachedTextInput = usage.inputTextTokens - usage.cachedTextTokens
  const uncachedAudioInput = usage.inputAudioTokens - usage.cachedAudioTokens
  const textNanoUsd = uncachedTextInput * NANO_USD_PER_REALTIME_TEXT_INPUT_TOKEN
    + usage.outputTextTokens * NANO_USD_PER_REALTIME_TEXT_OUTPUT_TOKEN
  const audioNanoUsd = uncachedAudioInput * NANO_USD_PER_REALTIME_AUDIO_INPUT_TOKEN
    + usage.outputAudioTokens * NANO_USD_PER_REALTIME_AUDIO_OUTPUT_TOKEN
  const cachedInputNanoUsd = usage.cachedTextTokens * NANO_USD_PER_REALTIME_CACHED_TEXT_INPUT_TOKEN
    + usage.cachedAudioTokens * NANO_USD_PER_REALTIME_CACHED_AUDIO_INPUT_TOKEN
  return {
    audioNanoUsd,
    textNanoUsd,
    cachedInputNanoUsd,
    transcriptionNanoUsd: 0,
    totalNanoUsd: audioNanoUsd + textNanoUsd + cachedInputNanoUsd,
  }
}

/**
 * Price one gpt-4o-mini-transcribe token report.
 * @param usage - normalized complete provider usage.
 * @returns exact integer nano-USD category totals.
 */
export function calculateTranscriptionCost(usage: TranscriptionTokenUsage): VoiceCostBreakdown {
  const transcriptionNanoUsd = usage.inputTokens * NANO_USD_PER_TRANSCRIPTION_INPUT_TOKEN
    + usage.outputTokens * NANO_USD_PER_TRANSCRIPTION_OUTPUT_TOKEN
  return {
    ...EMPTY_COST,
    transcriptionNanoUsd,
    totalNanoUsd: transcriptionNanoUsd,
  }
}

/** Accumulates deduplicated request and controller-lifetime reported costs. */
export class VoiceCostAccumulator {
  private currentRequest: VoiceCostBreakdown = EMPTY_COST
  private sessionTotal: VoiceCostBreakdown = EMPTY_COST
  private currentRequestReported = false
  private sessionReported = false
  private readonly responseIds = new Set<string>()
  private readonly transcriptionEventIds = new Set<string>()

  constructor(private readonly reportError: (message: string) => void = (message) => {
    console.error(`[ui-voice] cost accounting failed: ${message}`)
  }) {}

  /** Reset request-local totals while preserving the controller-lifetime session total. */
  beginRequest(): void {
    this.currentRequest = EMPTY_COST
    this.currentRequestReported = false
  }

  /**
   * Add one Realtime report unless its response id was already seen.
   * @param usage - normalized response usage.
   * @param responseId - provider response id when present.
   * @param includeCurrentRequest - whether this report belongs to the active phrase.
   * @returns whether the report was accumulated.
   */
  addRealtime(usage: RealtimeTokenUsage, responseId?: string, includeCurrentRequest = true): boolean {
    if (responseId !== undefined && this.responseIds.has(responseId)) return false
    if (!this.add(calculateRealtimeCost(usage), includeCurrentRequest)) return false
    if (responseId !== undefined) this.responseIds.add(responseId)
    return true
  }

  /**
   * Add one transcription report unless its event id was already seen.
   * @param usage - normalized transcription usage.
   * @param eventId - provider event id when present.
   * @param includeCurrentRequest - whether this report belongs to the latest committed phrase.
   * @returns whether the report was accumulated.
   */
  addTranscription(usage: TranscriptionTokenUsage, eventId?: string, includeCurrentRequest = true): boolean {
    if (eventId !== undefined && this.transcriptionEventIds.has(eventId)) return false
    if (!this.add(calculateTranscriptionCost(usage), includeCurrentRequest)) return false
    if (eventId !== undefined) this.transcriptionEventIds.add(eventId)
    return true
  }

  /**
   * Create a detached cost view.
   * @returns Immutable copy of the current request and session totals.
   */
  snapshot(): VoiceCostSnapshot {
    return {
      currentRequest: { ...this.currentRequest },
      sessionTotal: { ...this.sessionTotal },
      currentRequestReported: this.currentRequestReported,
      sessionReported: this.sessionReported,
    }
  }

  private add(cost: VoiceCostBreakdown, includeCurrentRequest = true): boolean {
    const costIssue = breakdownIssue('provider increment', cost)
    if (costIssue !== undefined) {
      this.reportError(costIssue)
      return false
    }
    const currentRequest = includeCurrentRequest ? sumCost(this.currentRequest, cost) : this.currentRequest
    const sessionTotal = sumCost(this.sessionTotal, cost)
    if (currentRequest === undefined || sessionTotal === undefined) {
      this.reportError('cumulative nano-USD total exceeded the safe integer range')
      return false
    }
    this.currentRequest = currentRequest
    this.sessionTotal = sessionTotal
    if (includeCurrentRequest) this.currentRequestReported = true
    this.sessionReported = true
    return true
  }
}
