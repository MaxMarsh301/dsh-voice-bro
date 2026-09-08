# `@deepseek-ai/dsh-voice`

English | [中文](README.zh.md)

Host Service Definition for one browser-owned global voice session. Remote calls use an opaque logical id rather than a DSH Agent or provider call id, so one WebRTC call can inspect, address, and navigate ordinary Sessions without becoming part of any Session lifecycle.

## API

`start({ sdp, consumerId, foregroundSessionId? })` returns the browser SDP answer, logical id, and expiry while provider sideband activation may still be in progress. `consumerId` identifies the initiating browser tab for addressed navigation; it is not a credential. Before each gated phrase, the owning browser calls `claimResponseEpoch` with a fresh `VoiceResponseEpoch`; providers suppress delayed continuation work whose captured epoch is no longer current. Consumers poll `status`, update the visible Session through `setForeground`, acknowledge exact `voice/navigation-requested` events through `ackNavigation`, acknowledge canonical browser-owned `voice/creation-requested` outcomes through `ackCreation`, accept addressed `voice/completion-requested` signals for settled background Session work, and call `stop` for teardown. A creation request carries the provider-owned browser activation timeout. Providers retain the final acknowledgement by `VoiceCreationId`: repeating the same outcome is idempotent, while a conflicting outcome is invalid. A provider owns the global call lease and rejects a concurrent call.

All request, event, and result fields are JSON-safe. `VoiceSessionId`, `VoiceConsumerId`, `VoiceRequestId`, `VoiceNavigationId`, `VoiceCreationId`, and `VoiceResponseEpoch` are opaque and branded. Service events address only the matching browser consumer. Navigation still requires browser acknowledgement, while a completion signal contains bounded request identity, Session identity, title, and terminal state but no assistant result text.

## Model Experience

### Service calls

#### What the model sees

Nothing directly. `VoiceService` contributes no prompt, schema, result, or model request; a provider owns any Realtime shell and bounded Session operations.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct effect. Calling or replacing this service does not alter a DSH Agent request prefix.

## Known Limitations and Deferred Work

- **Browser-owned live call** — WebRTC state is ephemeral and cannot resume across a page reload. A persisted hands-free preference may create a new call only after browser media requirements are satisfied.
- **Addressed event, not connection identity** — navigation uses a random per-tab consumer id over the Host event carrier. The receiving client filters that id and acknowledges the exact navigation operation.
