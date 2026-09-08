import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceCalibrationSettingsSnapshot } from './calibration-controller.ts'
import type { VoiceSnapshot } from './controller.ts'
import css from './VoiceSettingsSection.module.css'

/** Plain Settings face for browser-local wake-word calibration and confirmation. */
export interface VoiceSettingsInjected {
  hooks: {
    calibration: { getSnapshot(): VoiceCalibrationSettingsSnapshot; subscribe(listener: () => void): () => void }
    voice: { getSnapshot(): VoiceSnapshot; subscribe(listener: () => void): () => void }
  }
  startCalibration(): Promise<void>
  beginCalibrationSample(): Promise<void>
  endCalibrationSample(): Promise<void>
  setWakeSignalEnabled(enabled: boolean): void
}

/** Props composed for the root-scoped Voice Settings section. */
export type VoiceSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'voice'>
  & InjectFace<VoiceSettingsInjected>

/** Browser-local БРО calibration and confirmation settings. */
export function VoiceSettingsSection({
  useCalibration, useVoice, startCalibration, beginCalibrationSample, endCalibrationSample,
  setWakeSignalEnabled, t,
}: VoiceSettingsSectionProps) {
  const snapshot = useCalibration(value => value)
  const voice = useVoice(value => value)
  const calibration = snapshot.calibration
  const needsCalibration = snapshot.wakeReadiness === 'calibration-required'
  const progress = calibration.pending
    ? t('calibration.processing')
    : t('calibration.progress', { count: calibration.sampleCount, required: calibration.requiredSamples })
  const error = snapshot.error ? t('error.calibration') : undefined

  return (
    <section className={css.section} aria-labelledby="voice-settings-title">
      <h2 id="voice-settings-title" className={css.title}>{t('settings.title')}</h2>
      <p className={css.intro}>{t('settings.intro')}</p>
      <div className={css.card}>
        <div className={css.cardCopy}>
          <h3 className={css.cardTitle}>{t('settings.keywordTitle')}</h3>
          <p className={css.cardDescription}>{t('settings.keywordDescription')}</p>
        </div>
        {calibration.active
          ? (
            <div className={css.calibration}>
              <span className={css.progress}>{error ?? progress}</span>
              <button
                type="button"
                className={css.action}
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
            </div>
          )
          : (
            <button type="button" className={css.action} onClick={() => { void startCalibration() }}>
              {needsCalibration ? t('calibration.start') : t('calibration.restart')}
            </button>
          )}
      </div>
      <div className={css.card}>
        <div className={css.cardCopy}>
          <h3 className={css.cardTitle}>{t('settings.wakeSignalTitle')}</h3>
          <p id="voice-wake-signal-description" className={css.cardDescription}>{t('settings.wakeSignalDescription')}</p>
        </div>
        <label className={css.toggle}>
          <input
            type="checkbox"
            checked={voice.wakeSignalEnabled}
            aria-describedby="voice-wake-signal-description"
            onChange={event => { setWakeSignalEnabled(event.currentTarget.checked) }}
          />
          <span>{t('settings.wakeSignalToggle')}</span>
        </label>
      </div>
      <p className={css.privacy}>{t('settings.privacy')}</p>
    </section>
  )
}
