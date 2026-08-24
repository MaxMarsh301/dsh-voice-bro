# Voice packages

English

The voice group keeps provider signaling separate from browser capture and from the authoritative DSH Agent. It contains the Host capability seam and provider; browser Consumers live under [`packages/client/`](../client/README.md).

| Package | Role | Cordis service |
|---|---|---|
| [`voice/`](voice/README.md) | Service Definition and Typert Remote operations for one Agent-owned logical voice session | `voice` |
| [`voice-openai-realtime/`](voice-openai-realtime/README.md) | OpenAI Realtime WebRTC signaling, authenticated sideband, and DSH Agent bridge | `voice` provider |

The Host keeps credentials and provider call ids private. Browser Consumers receive an SDP answer and opaque `VoiceSessionId`; they send microphone audio only through an explicitly gated Realtime data channel and never as a peer microphone track.

## Model Experience

The Service Definition itself adds no model input. By default the OpenAI provider gives the Realtime voice shell a bounded Russian instruction and three function schemas for status, safe turn submission, and waiting. Substantive work enters the current DSH Agent as an ordinary user follow-up and therefore uses the Agent's existing tools, approvals, context, and durable session log. Destructive cancellation and replacement require an explicit deployment opt-in.

## Known Limitations and Deferred Work

The group currently has one reviewed provider. Exact text-to-speech reproduction, direct voice-owned subagent spawning, phone background capture, and speaker-independent wake-word recognition remain separate work.
