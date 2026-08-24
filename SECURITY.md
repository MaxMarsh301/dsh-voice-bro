# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or credential exposure. Use GitHub's private vulnerability reporting for this repository when available.

Never include an OpenAI API key, provider response body, raw wake-word calibration audio, session transcript, or DSH workspace data in a report. Replace sensitive values with minimal synthetic reproductions.

## Credential handling

`OPENAI_API_KEY` belongs in the DSH Host environment or credential service. It must never be embedded in browser configuration, committed files, screenshots, logs, or issue reports.

The browser receives only the SDP answer and an opaque logical voice-session ID. Provider call IDs and authorization headers remain on the Host.
