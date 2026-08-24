# @deepseek-ai/dsh-client-wake-word-local

English

Browser-only Cordis service for detecting the literal Russian wake word **БРО** from speaker-calibrated templates. It is not a universal or pretrained speech model: each browser profile needs several isolated samples from its user before detection becomes ready.

The package does not capture a microphone. A consumer owns `getUserMedia`, AudioWorklet, resampling policy, and permission UX, then feeds bounded mono `Float32Array` or signed `Int16Array` frames to `ctx.wakeWord`. The service never uses `SpeechRecognition`, `webkitSpeechRecognition`, `fetch`, `WebSocket`, `EventSource`, or another network path. Audio is copied into an inline blob Web Worker for all VAD, feature extraction, and matching, so the UI thread does not perform acoustic inference.

## Service API

`ctx.wakeWord` exposes:

- `feed(pcm, sampleRate)` for streaming inference frames;
- `onDetection(listener)` for thresholded, cooldown-limited local detections;
- `getState()` and `subscribe(listener)` for Worker readiness, enabled state, template count, errors, and calibration progress;
- `beginCalibration()`, `addCalibrationSample(pcm, sampleRate)`, and `commitCalibration()` for a replacing calibration transaction;
- `setEnabled(enabled)` to stop or resume inference without deleting calibration; and
- `dispose()` to terminate the Worker, reject pending calibration calls, and remove listeners.

A consumer should collect at least `minTemplates` clean pronunciations of **БРО** with similar microphone placement but modest variation in pace and pitch. `addCalibrationSample` accepts one complete utterance and resolves only after the Worker has converted it to a bounded feature matrix. `commitCalibration` atomically replaces prior templates and stores those derived matrices in `localStorage`. Raw PCM is never stored, serialized, or returned from the Worker. Clearing the configured storage key removes calibration on the next load.

## Matcher

The Worker resamples to 16 kHz, applies RMS VAD, trims silence, computes 25 ms / 10 ms-hop Hamming-windowed spectra, projects 16 mel-spaced log filter energies to eight normalized cepstral coefficients, and compares bounded candidate windows with speaker templates using band-limited normalized DTW. During voiced audio it evaluates a template-length sliding window every four 10 ms VAD blocks, so **БРО** can fire before a following command ends and does not require a pause after the word. A trailing 120 ms silence or the duration cap also evaluates the complete VAD segment as a fallback. A successful streaming match immediately discards its candidate PCM, resets segmentation for following command audio, and applies the cooldown. The lowest distance must be at or below `threshold`; lower thresholds trade recall for fewer false triggers.

Input is bounded to 8–48 kHz, one non-empty frame no longer than `maxFeedMs`, and calibration input no longer than twice `maxSampleMs`. VAD-trimmed utterances must remain between `minSampleMs` and `maxSampleMs`. Template count, feature dimensions, frame count, coefficient magnitude, persisted bytes, and Worker messages are bounded or validated at their crossing points.

Configuration defaults are `threshold: 0.16`, `vadRms: 0.018`, `cooldownMs: 1500`, `minTemplates: 3`, `maxTemplates: 8`, `minSampleMs: 250`, `maxSampleMs: 2200`, `maxFeedMs: 250`, `enabled: true`, and storage key `dsh:wake-word-local:БРО:v1`. Deployments should tune `threshold` and `vadRms` against their microphone and ambient-noise conditions rather than treating these defaults as universal accuracy claims.

This package deliberately contains no bundle-composition row. Another browser plugin can consume the service by declaring Cordis injection `wakeWord` after the package is added to a chosen Web composition.

## Model Experience

### Browser-local detection

#### What the model sees

Nothing. `ctx.wakeWord` detections remain browser-local callback data; this package adds no model input, prompt text, tool, or session-log event.

#### Token effect

None. The package adds no request content and sends no provider request.

#### KV Cache effect

None. The package neither assembles a request nor changes earlier request tokens.

## Known Limitations and Deferred Work

- Accuracy is speaker-, microphone-, room-, and calibration-dependent. The lightweight matcher has no phoneme model, noise suppression, echo cancellation, or pretrained multilingual representation.
- Sliding matching is checked at a 40 ms cadence and still depends on VAD finding the start of the utterance. Continuous music, overlapping speech, reverberation, or a very low VAD threshold can reduce accuracy and increase false triggers.
- Calibration is browser-profile local and is not synchronized. Derived templates remain readable to scripts with access to the same origin's `localStorage`; they are not raw audio, but they are still voice-derived data and should be cleared when no longer wanted.
- The package supplies frame matching only. Microphone capture, AudioWorklet integration, permission UI, calibration UI, and the consumer action triggered by a detection belong to consuming plugins.
