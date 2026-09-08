import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  VoiceConsumerId, VoiceCreationId, VoiceCreationRequest, VoiceSessionId,
} from './remote-adapter.ts'

/** Browser result sent to the Host after one addressed Session creation attempt. */
export interface VoiceCreationOutcome {
  creationId: VoiceCreationId
  created: boolean
  activated: boolean
  sessionId?: SessionId
}

/** Browser Session selection operations used to confirm one activation. */
export interface VoiceActivationDeps {
  subscribe(listener: () => void): () => void
  open(sessionId: SessionId): void
  current(): SessionId | undefined
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

/**
 * Open one Session and wait until the observable current selection confirms it.
 * @param sessionId - target Session.
 * @param timeoutMs - Host-provided activation budget.
 * @param signal - effect-lifetime cancellation signal.
 * @param deps - observable selection operations.
 * @returns Whether the target became current before cancellation or timeout.
 */
export function openAndWait(
  sessionId: SessionId,
  timeoutMs: number,
  signal: AbortSignal,
  deps: VoiceActivationDeps,
): Promise<boolean> {
  return new Promise((resolve) => {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    let settled = false
    let unsubscribe = (): void => {}
    const finish = (activated: boolean): void => {
      if (settled) return
      settled = true
      unsubscribe()
      combined.removeEventListener('abort', onAbort)
      resolve(activated)
    }
    const onAbort = (): void => { finish(false) }
    const check = (): void => {
      if (deps.current() === sessionId) finish(true)
    }
    unsubscribe = deps.subscribe(check)
    combined.addEventListener('abort', onAbort, { once: true })
    if (combined.aborted) { finish(false); return }
    try { deps.open(sessionId) }
    catch { finish(false); return }
    check()
  })
}

/** Dependencies for one addressed Host-to-browser Session creation command. */
export interface VoiceCreationDeps {
  consumerId: VoiceConsumerId
  ownsVoiceSession(sessionId: VoiceSessionId): boolean
  create(): Promise<SessionId>
  rename(sessionId: SessionId, title: string): Promise<boolean>
  openAndWait(sessionId: SessionId, timeoutMs: number, signal: AbortSignal): Promise<boolean>
}

/**
 * Create, optionally name, and confirm activation for one Session owned by the addressed tab and live call.
 * @param request - forwarded Host command and activation deadline.
 * @param deps - current tab, call, canonical creation, naming, and activation operations.
 * @param signal - effect-lifetime cancellation signal.
 * @returns The stable acknowledgement payload, or undefined after disposal or for another owner.
 */
export async function handleVoiceCreation(
  request: VoiceCreationRequest,
  deps: VoiceCreationDeps,
  signal: AbortSignal,
): Promise<VoiceCreationOutcome | undefined> {
  if (request.consumerId !== deps.consumerId || !deps.ownsVoiceSession(request.voiceSessionId) || isAborted(signal)) return undefined
  let created = false
  let activated = false
  let sessionId: SessionId | undefined
  try {
    sessionId = await deps.create()
    created = true
    if (isAborted(signal)) return undefined
    if (request.title !== undefined && request.title !== '') {
      const renamed = await deps.rename(sessionId, request.title)
      if (isAborted(signal)) return undefined
      if (!renamed) throw new Error('voice: Session title was rejected')
    }
    activated = await deps.openAndWait(sessionId, request.activationTimeoutMs, signal)
    if (isAborted(signal)) return undefined
  } catch {
    activated = false
  }
  if (isAborted(signal)) return undefined
  return {
    creationId: request.creationId,
    created,
    activated,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}
