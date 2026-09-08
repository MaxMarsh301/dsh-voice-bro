# Voice packages

English

The voice group keeps provider signaling separate from browser capture and from the authoritative DSH Agent. It contains the Host capability seam and provider; browser capture and global controls live in [`ui-voice`](../client/ui-voice/README.md).

| Package | Role | Cordis service |
|---|---|---|
| [`voice/`](voice/README.md) | Service Definition and Typert Remote operations for a global voice call with thread routing | `voice` |
| [`voice-openai-realtime/`](voice-openai-realtime/README.md) | OpenAI Realtime WebRTC signaling, authenticated sideband, and DSH Agent bridge | `voice` provider |

The Host keeps credentials and provider call ids private. Browser Consumers receive an SDP answer and opaque `VoiceSessionId`; they send microphone audio only through an explicitly gated Realtime data channel and never as a peer microphone track.

## Model Experience

The Service Definition itself adds no model input. The [OpenAI provider](voice-openai-realtime/README.md#model-experience) owns the Realtime voice shell's instructions, thread-routing tools, and bounded result delivery. Substantive work uses the selected DSH Agent's existing tools, approvals, context, and durable session log. Destructive cancellation and replacement require an explicit deployment opt-in.

## Known Limitations and Deferred Work

The group currently has one reviewed provider. Exact text-to-speech reproduction, direct voice-owned subagent spawning, phone background capture, and speaker-independent wake-word recognition remain separate work.
