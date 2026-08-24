# `@deepseek-ai/dsh-voice`

Host Service Definition for browser WebRTC voice sessions owned by a live Agent. Remote calls address the Agent through Typert lookup and expose only branded logical session ids; provider call ids never cross the service API.

## API

`start(agent, { sdp })` returns the browser SDP answer, logical id, and expiry while provider sideband activation may still be in progress. Consumers poll `status`; audio input is safe to release only when `sidebandReady` is true. `stop` tears down the owned session. A provider permits at most one call per Agent.

All request and result fields are JSON-safe. `VoiceSessionId` is opaque and branded.

## Model Experience

### Service calls

#### What the model sees

Nothing directly. `VoiceService` contributes no prompt, schema, result, or model request; a provider owns any Realtime model session.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect. Calling or replacing this service does not alter an Agent request prefix.

## Known Limitations and Deferred Work

- **Host-only seam** — browser capture, playback, and bundle composition remain Consumer responsibilities; this package exposes only Agent-addressed signaling lifecycle operations.
