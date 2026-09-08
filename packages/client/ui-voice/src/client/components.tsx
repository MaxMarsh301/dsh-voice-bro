import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useId } from 'react'
import type { VoiceActivityTool } from './events.ts'
import type { VoiceSnapshot } from './controller.ts'
import { voiceCostSnapshotIssue, type VoiceCostSnapshot } from './cost.ts'
import type { VoiceInjected } from './index.ts'
import { voiceOverlayDisclosure, type createVoiceSettingsStore } from './store.ts'
import css from './Voice.module.css'

/** Session composer voice-shortcut props. */
export type VoiceControlProps = PropsRuntime<'conversation.input.right'>
  & InjectFace<VoiceInjected>
  & PropsLocale<'voice'>

/** Sidebar launcher props for the page-global voice window. */
export type VoiceSidebarLauncherProps = PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createVoiceSettingsStore>>
  & InjectFace<VoiceInjected>
  & PropsLocale<'voice'>

/** Session composer dock props for the page-global voice panel. */
export type VoiceOverlayProps = PropsRuntime<'conversation.input.dock'>
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

function costBreakdown(cost: VoiceCostSnapshot, t: VoiceOverlayProps['t']): string {
  return t('cost.breakdown', {
    audio: formatNanoUsd(cost.sessionTotal.audioNanoUsd),
    text: formatNanoUsd(cost.sessionTotal.textNanoUsd),
    cached: formatNanoUsd(cost.sessionTotal.cachedInputNanoUsd),
    transcription: formatNanoUsd(cost.sessionTotal.transcriptionNanoUsd),
  })
}

function VoiceCostPanel({ cost, issue, t }: Pick<VoiceOverlayProps, 't'> & {
  cost: VoiceCostSnapshot
  issue: string | undefined
}) {
  if (!cost.sessionReported && issue === undefined) return null
  return (
    <section className={css.costPanel} aria-label={t('cost.title')}>
      <div className={css.costHeader}>
        <span>{t('cost.title')}</span>
        {issue === undefined && <span className={css.costSession}>{formatNanoUsd(cost.sessionTotal.totalNanoUsd)}</span>}
      </div>
      {issue === undefined
        ? (
          <>
            <div className={css.costTotals}>
              <span>{t('cost.request')}</span>
              <strong>{formatNanoUsd(cost.currentRequest.totalNanoUsd)}</strong>
              <span>{t('cost.session')}</span>
              <strong>{formatNanoUsd(cost.sessionTotal.totalNanoUsd)}</strong>
            </div>
            <p className={css.costBreakdown}>{costBreakdown(cost, t)}</p>
          </>
        )
        : <p className={css.costError}>{t('cost.unavailable')}</p>}
    </section>
  )
}

function VoiceTranscriptPanel({ snapshot, t }: Pick<VoiceOverlayProps, 't'> & { snapshot: VoiceSnapshot }) {
  if (snapshot.transcript === '' || snapshot.transcript === snapshot.activity.finalText) return null
  return (
    <section className={css.transcriptPanel} aria-label={t('transcript.title')}>
      <span className={css.transcriptTitle}>{t('transcript.title')}</span>
      <p>{snapshot.transcript}</p>
    </section>
  )
}

function activityLabel(tool: VoiceActivityTool, t: VoiceOverlayProps['t']): string {
  return t(`activity.step.${tool}`)
}

function VoiceActivityPanel({ snapshot, t }: Pick<VoiceOverlayProps, 't'> & { snapshot: VoiceSnapshot }) {
  const activity = snapshot.activity
  const visible = activity.steps.length > 0 || activity.plannedText !== '' || activity.finalText !== ''
  if (!visible) return null
  return (
    <section className={css.activityPanel} aria-label={t('activity.title')}>
      <div className={css.activityHeader}>
        <span>{t('activity.title')}</span>
        <span className={css.activityState}>{t(activity.finalText === '' ? 'activity.inProgress' : 'activity.complete')}</span>
      </div>
      {activity.steps.length > 0 && (
        <ol className={css.stepList} aria-label={t('activity.steps')}>
          {activity.steps.map(step => (
            <li key={step.callId} className={css.step} data-status={step.status}>
              <span className={css.stepMark} aria-hidden>{step.status === 'completed' ? '✓' : '·'}</span>
              <span>{activityLabel(step.tool, t)}</span>
              <span className={css.stepStatus}>{t(`activity.${step.status}`)}</span>
            </li>
          ))}
        </ol>
      )}
      {activity.plannedText !== '' && (
        <div className={css.activityBlock}>
          <span className={css.activityLabel}>{t('activity.plan')}</span>
          <p>{activity.plannedText}</p>
        </div>
      )}
      {activity.finalText !== '' && (
        <div className={css.activityBlock} data-kind="final">
          <span className={css.activityLabel}>{t('activity.result')}</span>
          <p>{activity.finalText}</p>
        </div>
      )}
    </section>
  )
}

type ControlProps = Pick<VoiceControlProps,
  'beginPushToTalk' | 'endPushToTalk' | 'setHandsFree' | 't'> & {
    snapshot: VoiceSnapshot
    handsFreePreference: boolean
  }

function Controls({
  snapshot, handsFreePreference, beginPushToTalk, endPushToTalk, setHandsFree, t,
}: ControlProps) {
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

/** Push-to-talk and hands-free shortcuts mounted before every Session send button. */
export function VoiceControl(props: VoiceControlProps) {
  const snapshot = props.useVoice(value => value)
  return <Controls {...props} snapshot={snapshot} handsFreePreference={snapshot.handsFree} />
}

function hasVoiceResponse(snapshot: VoiceSnapshot): boolean {
  return snapshot.transcript !== ''
    || snapshot.activity.steps.length > 0
    || snapshot.activity.plannedText !== ''
    || snapshot.activity.finalText !== ''
}

function voiceWindowVisible(snapshot: VoiceSnapshot, disclosure: ReturnType<typeof voiceOverlayDisclosure>): boolean {
  return disclosure === 'expanded' || (disclosure === 'auto' && hasVoiceResponse(snapshot))
}

function voiceStatus(snapshot: VoiceSnapshot, t: VoiceOverlayProps['t']): string {
  if (snapshot.errorCode !== undefined) return t(`error.${snapshot.errorCode}`)
  if (snapshot.calibration.active) return t('calibration.replacing')
  if (snapshot.handsFree && snapshot.wakeReadiness === 'ready') return t('wake.armed')
  if (snapshot.wakeReadiness === 'calibration-required') return t('wake.calibration')
  if (snapshot.sawToolResponse && snapshot.phase === 'thinking') return t('status.tool')
  return t(`status.${snapshot.phase}`)
}

/** Compact sidebar panel that toggles the page-global voice window. */
export function VoiceSidebarLauncher(props: VoiceSidebarLauncherProps) {
  const snapshot = props.useVoice(value => value)
  const persistedDisclosure = props.useStore(state => voiceOverlayDisclosure(state.overlayDisclosure))
  const disclosure = props.useVoiceWindow(value => value.disclosure)
  const visible = voiceWindowVisible(snapshot, disclosure)
  useEffect(() => { props.setOverlayDisclosure(persistedDisclosure) }, [persistedDisclosure, props.setOverlayDisclosure])
  const label = props.t(visible ? 'panel.collapse' : 'panel.expand')
  return (
    <button
      type="button"
      className={css.sidebarLauncher}
      data-wide={props.wide || undefined}
      data-active={snapshot.handsFree || undefined}
      aria-label={label}
      aria-expanded={visible}
      title={label}
      onClick={() => { props.setOverlayDisclosure(visible ? 'collapsed' : 'expanded') }}
    >
      <span className={css.sidebarMic} aria-hidden><span className={css.micMark} /></span>
      {props.wide && (
        <span className={css.sidebarCopy}>
          <strong>{props.t('sidebar.title')}</strong>
          <span>{voiceStatus(snapshot, props.t)}</span>
        </span>
      )}
      <span className={css.stateDot} data-phase={snapshot.phase} aria-hidden />
    </button>
  )
}

/** Floating window that remains mounted while the foreground Session changes. */
export function VoiceOverlay(props: VoiceOverlayProps) {
  const detailsId = useId()
  const snapshot = props.useVoice(value => value)
  const disclosure = props.useVoiceWindow(value => value.disclosure)
  const handsFreePreference = snapshot.handsFree
  const visible = voiceWindowVisible(snapshot, disclosure)
  const cost = snapshot.cost
  const costIssue = voiceCostSnapshotIssue(cost)

  useEffect(() => {
    if (costIssue !== undefined) console.error(`[ui-voice] cost display rejected: ${costIssue}`)
  }, [costIssue])

  if (!visible) return null
  return (
    <section className={css.overlay} aria-label={props.t('panel.title')} aria-live="polite">
      <div className={css.summary}>
        <Controls {...props} snapshot={snapshot} handsFreePreference={handsFreePreference} />
        <span className={css.stateDot} data-phase={snapshot.phase} aria-hidden />
        <span className={css.statusText}>{voiceStatus(snapshot, props.t)}</span>
        {busy(snapshot) && (
          <button type="button" className={css.cancel} onClick={() => { void props.cancel() }}>
            {props.t('action.cancel')}
          </button>
        )}
        <button
          type="button"
          className={css.disclosure}
          aria-controls={detailsId}
          aria-expanded="true"
          aria-label={props.t('panel.collapse')}
          onClick={() => { props.setOverlayDisclosure('collapsed') }}
        >
          <span aria-hidden>−</span>
        </button>
      </div>
      <div id={detailsId} className={css.details}>
        <VoiceActivityPanel snapshot={snapshot} t={props.t} />
        <VoiceTranscriptPanel snapshot={snapshot} t={props.t} />
        <VoiceCostPanel cost={cost} issue={costIssue} t={props.t} />
      </div>
    </section>
  )
}

/** Legacy component-test alias for the root global status surface. */
export type VoiceStatusProps = VoiceOverlayProps
/** Render the global status surface through its former name. */
export const VoiceStatus = VoiceOverlay
