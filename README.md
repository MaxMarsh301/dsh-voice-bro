# dsh-voice-bro

[Русский](README.ru.md) · English

**Russian voice mode plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** with OpenAI Realtime, WebRTC audio, push-to-talk, hands-free activation, and the local wake word **«БРО»**.

`dsh-voice-bro` turns the DSH Web GUI into a speech-to-speech voice assistant while keeping the normal DSH Agent authoritative. Spoken requests become ordinary Agent follow-ups, steering messages, or explicit cancel-and-replace actions, so existing tools, approvals, session history, and on-screen results continue to work.

> **Experimental source plugin.** DSH does not yet publish the voice service or a stable third-party client-bundle build API. This repository therefore installs reviewed source packages into a compatible DSH checkout instead of pretending that a standalone `npm install` is sufficient. The compatibility baseline is DSH commit [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e).

## Features

- **Push-to-talk** control embedded in each DSH conversation.
- **Hands-free mode** activated by the literal Russian wake word **БРО**.
- **Local wake-word matching** after speaker and microphone calibration.
- **OpenAI Realtime speech-to-speech** over WebRTC.
- **Agent-aware interruption:** follow up or steer active work; cancellation and replacement require an explicit Host opt-in.
- **Approval-aware waiting:** voice can tell the user that confirmation is waiting on screen.
- **Safe audio transport:** the browser never attaches the microphone as a WebRTC sender; only gated 24 kHz PCM reaches the ordered Realtime data channel.
- **Usage cost meter** for complete provider-reported Realtime and transcription token usage.
- **Russian-first voice shell** that gives a short spoken summary and leaves full output in the GUI.

## Architecture

The repository carries four native Cordis/DSH plugin packages:

| Package | Responsibility |
|---|---|
| `@deepseek-ai/dsh-voice` | Host voice-session service and generated Remote operations |
| `@deepseek-ai/dsh-voice-openai-realtime` | OpenAI Realtime signaling, authenticated sideband, and Agent bridge |
| `@deepseek-ai/dsh-client-wake-word-local` | Browser-local speaker-calibrated matcher for «БРО» |
| `@deepseek-ai/dsh-client-ui-voice` | Microphone capture, WebRTC playback, controls, transcript, and cost UI |

The installer also adds the required packages to the official DSH Web composition and mounts the generated voice Remote namespace in the current Client Remote assembly.

## Requirements

- Linux or macOS development environment.
- Node.js `^22.19.0` or `>=24`.
- pnpm through Corepack.
- A compatible [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) source checkout.
- `OPENAI_API_KEY` with access to `gpt-realtime-2.1` and `gpt-4o-mini-transcribe`.
- A browser with WebRTC, `AudioContext`, `AudioWorklet`, and microphone permission.
- `localhost` or HTTPS, because browsers restrict microphone capture in insecure contexts.

OpenAI Realtime and transcription usage is billable. Review current [OpenAI API pricing](https://openai.com/api/pricing/) before enabling hands-free mode.

## Install into DSH

Start with a clean DSH checkout. The installer refuses to overwrite existing voice package directories unless `--force` is supplied deliberately.

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
git clone https://github.com/MaxMarsh301/dsh-voice-bro.git

node dsh-voice-bro/scripts/install-into-dsh.mjs ./deepseek-harness
cd deepseek-harness
corepack enable
pnpm install
pnpm run build
```

Set the credential only in the runtime environment; never commit it:

```bash
export OPENAI_API_KEY='your-key-here'
pnpm dsh web
```

Open the DSH Web URL, allow microphone access, and use the microphone control in a conversation. Hands-free mode asks for local «БРО» calibration before it can trigger.

## Updating

The installer is source-oriented and intentionally fails when an insertion point has changed. For a newer DSH revision:

1. Update both repositories.
2. Review DSH changes since the compatibility baseline.
3. Apply the installer to a clean branch.
4. Run the DSH build and GUI test suites.
5. Verify microphone gating, interruption, playback drain, and cleanup in the actual Web GUI.

Do not use `--force` over unreviewed local changes.

## Privacy and security

- Raw wake-word calibration PCM is held only in bounded memory and is zeroed after derived templates are staged.
- Derived wake templates remain in browser-local storage.
- Pre-trigger audio is not sent to OpenAI.
- Provider call IDs and `OPENAI_API_KEY` stay on the Host.
- Provider error bodies are not exposed to the browser.
- The OpenAI provider receives triggered speech, transcription context, the voice-shell instruction, controlled function calls, and bounded Agent results needed to speak the response.

Read the package references for exact lifecycle and data-handling behavior:

- [`packages/voice/voice-openai-realtime/README.md`](packages/voice/voice-openai-realtime/README.md)
- [`packages/client/ui-voice/README.md`](packages/client/ui-voice/README.md)
- [`packages/client/wake-word-local/README.md`](packages/client/wake-word-local/README.md)

## Development

Repository-level checks validate package identity, expected search terms, source cleanliness, and common secret patterns:

```bash
npm run check
```

Behavioral tests and builds run after installing the source into the compatible DSH monorepo, where the necessary TypeScript project graph, Typert generator, client plugin bundler, and real Web composition live.

## Discoverability

Relevant GitHub search terms: **DeepSeek Harness voice plugin**, **DSH voice mode**, **OpenAI Realtime WebRTC**, **Russian voice assistant**, **wake word БРО**, **push-to-talk**, **speech-to-speech**, and **Cordis plugin**.

## License

MIT. Extracted DSH source retains the upstream DeepSeek copyright notice. See [`LICENSE`](LICENSE).
