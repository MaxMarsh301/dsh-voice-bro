import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceSnapshot } from './controller.ts'
import type { VoiceInjected } from './index.ts'
import type { createVoiceSettingsStore } from './store.ts'
import css from './Voice.module.css'

/** Compact tool-row control props. */
export type VoiceControlProps = PropsRuntime<'conversation.input.right'>
  & PropsStore<ReturnType<typeof createVoiceSettingsStore>>
  & InjectFace<VoiceInjected>
  & PropsLocale<'voice'>

/** Composer dock status props. */
export type VoiceStatusProps = PropsRuntime<'conversation.input.dock'>
  & PropsStore<ReturnType<typeof createVoiceSettingsStore>>
  & InjectFace<VoiceInjected>
  & PropsLocale<'voice'>

function busy(snapshot: VoiceSnapshot): boolean {
  return snapshot.phase !== 'idle' && snapshot.phase !== 'error'
}

function formatNanoUsd(nanoUsd: number): string {
  if (nanoUsd === 0) return '$0.00'
  const usd = nanoUsd / 1_000_000_000
  if (usd >= 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(9).replace(/0+$/, '')}`
}

/** Push-to-talk and hands-free controls mounted before the send button. */
export function VoiceControl({ useVoice, useStore, beginPushToTalk, endPushToTalk, setHandsFree, t }: VoiceControlProps) {
  const snapshot = useVoice(value => value)
  const handsFreePreference = useStore(state => state.handsFreeEnabled)
  const interruptible = snapshot.phase === 'thinking' || snapshot.phase === 'speaking'
  const capturing = snapshot.phase === 'interrupting'
    || snapshot.phase === 'requesting-microphone'
    || snapshot.phase === 'connecting'
    || snapshot.phase === 'listening'
  const pttLabel = capturing ? t('ptt.active') : interruptible ? t('ptt.interrupt') : t('ptt.label')
  return (
    <span className={css.controls}>
      <button
        type="button"
        className={css.ptt}
        data-active={capturing || undefined}
        disabled={busy(snapshot) && !capturing && !interruptible}
        aria-label={pttLabel}
        title={pttLabel}
        onContextMenu={(event) => { event.preventDefault() }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          void beginPushToTalk()
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          endPushToTalk()
        }}
        onPointerCancel={endPushToTalk}
      >
        <span className={css.micMark} aria-hidden />
      </button>
      <button
        type="button"
        className={css.handsFree}
        data-active={snapshot.handsFree || undefined}
        data-preferred={handsFreePreference || undefined}
        aria-pressed={snapshot.handsFree}
        aria-label={snapshot.handsFree ? t('handsFree.disable') : t('handsFree.enable')}
        title={snapshot.handsFree ? t('handsFree.disable') : t('handsFree.enable')}
        onClick={() => { void setHandsFree(!snapshot.handsFree) }}
      >
        БРО
      </button>
    </span>
  )
}

/** Session voice status, local calibration, transcript, and cancellation row. */
export function VoiceStatus({
  useVoice, startCalibration, beginCalibrationSample, endCalibrationSample, cancel, t,
}: VoiceStatusProps) {
  const snapshot = useVoice(value => value)
  const status = snapshot.sawToolResponse && snapshot.phase === 'thinking'
    ? t('status.tool')
    : t(`status.${snapshot.phase}`)
  const wake = snapshot.handsFree && snapshot.wakeReadiness === 'ready' ? t('wake.armed') : undefined
  const error = snapshot.errorCode === undefined ? undefined : t(`error.${snapshot.errorCode}`)
  const calibration = snapshot.calibration
  const calibrationText = calibration.pending
    ? t('calibration.processing')
    : t('calibration.progress', { count: calibration.sampleCount, required: calibration.requiredSamples })
  const needsCalibration = snapshot.wakeReadiness === 'calibration-required'
  const cost = snapshot.cost
  const costSummary = cost.sessionReported
    ? t('cost.summary', {
      request: formatNanoUsd(cost.currentRequest.totalNanoUsd),
      session: formatNanoUsd(cost.sessionTotal.totalNanoUsd),
    })
    : undefined
  const costBreakdown = cost.sessionReported
    ? t('cost.breakdown', {
      audio: formatNanoUsd(cost.sessionTotal.audioNanoUsd),
      text: formatNanoUsd(cost.sessionTotal.textNanoUsd),
      cached: formatNanoUsd(cost.sessionTotal.cachedInputNanoUsd),
      transcription: formatNanoUsd(cost.sessionTotal.transcriptionNanoUsd),
    })
    : undefined
  if (
    snapshot.phase === 'idle' && !snapshot.handsFree && snapshot.transcript.length === 0
    && !needsCalibration && !cost.sessionReported
  ) return null
  return (
    <div className={css.status} role="status" aria-live="polite">
      <span className={css.stateDot} data-phase={snapshot.phase} aria-hidden />
      <span className={css.statusText}>{error ?? wake ?? (needsCalibration ? t('wake.calibration') : status)}</span>
      {needsCalibration && !calibration.active && (
        <button type="button" className={css.calibrate} onClick={() => { void startCalibration() }}>
          {t('calibration.start')}
        </button>
      )}
      {needsCalibration && calibration.active && (
        <>
          <span className={css.calibrationProgress}>{calibrationText}</span>
          <button
            type="button"
            className={css.calibrate}
            data-active={calibration.recording || undefined}
            disabled={calibration.pending}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              void beginCalibrationSample()
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              void endCalibrationSample()
            }}
            onPointerCancel={() => { void endCalibrationSample() }}
          >
            {calibration.recording ? t('calibration.release') : t('calibration.hold')}
          </button>
        </>
      )}
      {snapshot.transcript.length > 0 && <span className={css.transcript}>{snapshot.transcript}</span>}
      {costSummary !== undefined && (
        <span className={css.cost} title={costBreakdown}>{costSummary}</span>
      )}
      {busy(snapshot) && (
        <button type="button" className={css.cancel} onClick={() => { void cancel() }}>
          {t('action.cancel')}
        </button>
      )}
    </div>
  )
}
