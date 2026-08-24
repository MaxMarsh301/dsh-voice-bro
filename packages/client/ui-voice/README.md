# @deepseek-ai/dsh-client-ui-voice

English

Browser UI and audio transport for Host-managed voice sessions. The plugin contributes a compact push-to-talk and hands-free control to `conversation.input.right` and a lifecycle, transcript, cancellation, and wake calibration row to `conversation.input.dock`. Both entries are strict session scope and share one controller per Session.

Pointer down opens the push-to-talk gate and begins microphone/transport setup. Pointer up or cancellation commits only after at least one gated PCM chunk was captured; releasing before permission or audio delivery tears down without sending an empty `input_audio_buffer.commit`. The plugin buffers gated audio while WebRTC connects, but sends no append before the gate and no buffered audio before both the ordered `oai-events` data channel and Host `sidebandReady` status are ready.

Microphone capture uses an `AudioContext` and inline Blob `AudioWorklet`; dynamic client plugins therefore require no audio asset. Mono Float32 input is linearly resampled to signed PCM16 little-endian at 24 kHz and base64-encoded for Realtime events. The microphone stream is never passed to `addTrack`, `addTransceiver`, or another `RTCRtpSender`. The peer contains only a recvonly audio transceiver and the ordered data channel. Remote RTP is assigned to a hidden audio element owned by the controller.

The WebRTC sequence is complete ICE offer → `voice.start(sessionId, { sdp })` → install answer → wait for data-channel open and bounded `voice.status` polling with `sidebandReady` → `input_audio_buffer.clear` → zero or more `append` events. Phrase completion sends `commit` immediately followed by `response.create`. Buffered-amount high/low water marks pause and resume appends. A completed final `response.done` marks generation complete but does not close playback; the controller waits for the matching `output_audio_buffer.stopped` before stopping transport, so queued WebRTC audio is not cut off. During generation or playback, another push-to-talk gesture or a hands-free wake detection first sends `response.cancel` and `output_audio_buffer.clear`, stops the current logical call, and opens a fresh gated phrase; the new voice shell can steer, queue, cancel, or explicitly replace the still-authoritative Agent process. Releasing push-to-talk while that teardown is pending abandons the new phrase instead of sending an empty commit. Manual cancellation uses the same playback-first teardown. A completed tool response removes the ordinary spoken-response timeout because approval and Harness tools may remain pending; the voice shell announces that required confirmation is waiting on screen, while user cancellation and the Host voice-session maximum remain authoritative.

Hands-free activation is always a user gesture: it acquires the microphone and enables the injected `ctx.wakeWord` service. Original Float32 worklet frames are fed locally before voice resampling. Only a provider detection whose literal keyword is `БРО` opens the phrase gate; local RMS VAD closes it. The package does not claim universal keyword recognition. An unready matcher exposes calibration in the dock: the user records the provider-required number of isolated `БРО` samples, each sample is converted by the wake provider into a derived template, and the transaction commits after the required count. Raw calibration PCM exists only in bounded in-memory arrays, is zeroed after staging, and is never persisted; the provider persists derived templates only.

Only one controller owns a microphone across mounted Sessions. A capture gesture in another Session cancels and tears down the previous Session before obtaining media. HMR/plugin disposal unsubscribes wake listeners and stops tracks, worklet nodes, `AudioContext`, data channel, peer, timers, Blob URL, audio element, local buffers, and Host voice session. Host stop rejection is contained as a generic connection failure and cannot prevent local media cleanup or coordinator release. It never calls `wakeWord.dispose()` because Cordis owns the provider service.

Provider data-channel input is parsed as untrusted JSON. The UI accepts only known lifecycle and string transcript fields. Provider error messages and status details are discarded and mapped to localized generic error codes.

The controller prices only complete provider-reported token usage. `response.done` usage uses the official `gpt-realtime-2.1` text, audio, and cached-input rates, while input-transcription completion uses the separate `gpt-4o-mini-transcribe` rates. Cached tokens remain a subset of modality input and are charged once. Integer nano-US-dollar accumulators retain the latest phrase and Session totals across transport teardown, split into audio, text, cache, and transcription categories. The dock keeps non-zero reported cost visible while idle; malformed, incomplete, duration-based, or absent usage is not estimated. Rate sources are the OpenAI [model pricing](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [transcription pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe), and [Realtime cost guide](https://developers.openai.com/api/docs/guides/realtime-costs). OpenAI's [Tokenizer](https://platform.openai.com/tokenizer) remains suitable for text estimates, not the displayed billing total.

## Configuration

The browser plugin validates deployment tunables through `Config`: `maxBufferedChunks`, `channelHighWaterBytes`, `channelLowWaterBytes`, `statusAttempts`, `statusIntervalMs`, `iceTimeoutMs`, `channelTimeoutMs`, `responseTimeoutMs`, `vadThreshold`, and `vadSilenceMs`. The low buffered-amount mark must remain below the high mark. Host session expiry and provider protocol constants are not browser tunables.

The `/client` public API contains only Cordis loading values (`apply`, `inject`, `Config`), the settings-store factory needed for derived component props, and shared types. Components, protocol helpers, adapters, and audio utilities remain package-internal.

## Model Experience

### Gated Realtime audio

#### What the model sees

After local wake or push-to-talk activation, `VoiceSessionController` sends bounded PCM append events to the Host-selected Realtime session. The package contributes no textual prompt, tool schema, system instruction, or ordinary conversation event; the Host provider owns transcription and the durable Agent bridge.

#### Token effect

No direct text tokens. The selected Realtime provider may tokenize or otherwise meter gated audio and its transcript independently; pre-trigger local audio contributes nothing.

#### KV Cache effect

The ordinary DSH Agent request prefix is unchanged until the Host provider submits an ordinary follow-up. The Realtime provider retains an independent session context; this browser package does not control that cache, but its cost meter reports cached-input usage when the provider includes complete modality details.

## Known Limitations and Deferred Work

- Wake recognition is browser-profile, speaker, microphone, and room dependent. Calibration-required is a first-class state, not an error or a promise that three samples produce production-grade keyword spotting.
- Calibration templates are local to the wake provider's browser storage and do not synchronize across browsers.
- The dock shows safe transcript lifecycle events emitted by the selected provider. Unsupported provider event names are ignored.
