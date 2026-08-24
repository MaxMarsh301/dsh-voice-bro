# `@deepseek-ai/dsh-voice-openai-realtime`

English

OpenAI Realtime provider for `ctx.voice`. It exchanges a browser SDP offer through `POST /v1/realtime/calls`, returns the SDP answer immediately, then activates an authenticated server sideband with bounded retries. The provider call id remains private.

## Configuration

Defaults are `gpt-realtime-2.1`, `gpt-4o-mini-transcribe`, voice `cedar`, a 3300-second maximum session, and 768 maximum output tokens per Realtime response. Model, transcription, and voice values use hard allowlists. `maxResponseOutputTokens`, `httpTimeoutMs`, `activationAttempts`, and `activationRetryMs` are bounded deployment settings. `allowDestructiveVoiceActions` defaults to `false`; cancellation and cancel-and-replace are omitted from the Realtime tools and rejected by the Host unless the deployment explicitly opts in.

`OPENAI_API_KEY` is resolved for every `start` through optional `ctx.credentials`, falling back to the process environment. Requests reject redirects, carry a pseudonymous `OpenAI-Safety-Identifier`, and never include provider bodies or credentials in errors.

The realtime session uses PCM16 at 24 kHz in both directions, requires every active browser audio section to be `recvonly`, disables automatic turn detection, and emits audio output. The safe default exposes `dsh_turn` with follow-up and steering modes, `wait_for_agent`, and `get_voice_status`; explicit `allowDestructiveVoiceActions: true` also exposes cancellation and cancel-and-replace. The Host enforces that setting even for an unadvertised provider call. `get_voice_status` and `wait_for_agent` can return only assistant text created after this voice session accepted its current action, never earlier Session history. The voice shell compresses results into at most 45 Russian words and directs the user to the complete on-screen answer. Function call ids are deduplicated, settled sideband writes are serialized, and stopping voice prevents late output.

## Model Experience

### Realtime voice-shell request

#### What the model sees

The independent Realtime request receives the Russian `VOICE_CORE` instruction, user audio and transcription, and three controlled function schemas by default. It can inspect Agent status and queue counts, submit follow-up or steering actions, and wait for whole-Agent quiescence. Explicitly enabling destructive actions adds `cancel_turn` and the replace mode. It receives no DSH tool schemas, provider ids, pre-trigger audio, or assistant history from before the accepted voice action. Agent completion text is bounded to 16 KiB before summarization, while each Realtime response is capped at the configured output-token limit.

##### `VOICE_CORE`

```markdown
Ты — только голосовая оболочка DSH. Не добавляй к запросу служебные пояснения, мета-инструкции или слова, которых пользователь не произносил. Для любой содержательной работы, рассуждения или использования инструментов всегда сначала вызывай get_voice_status, затем dsh_turn и wait_for_agent; ожидание может длиться, пока пользователь подтверждает действия на экране. Если Agent уже работает: mode=steer корректирует текущую работу на ближайшем шаге; mode=followup ставит отдельный запрос после неё; mode=replace допустим только после явной просьбы прервать текущую работу. Если намерение неоднозначно, сначала голосом уточни: скорректировать текущую задачу, поставить следующую или прервать и заменить. Не заявляй о завершении до получения результата функции. Если требуется подтверждение, скажи, что подтверждение ожидает на экране, и жди. После результата функции произнеси по-русски максимум 45 слов в двух-трёх коротких предложениях: итог, важное ограничение или следующий шаг. Даже очень длинный ответ сожми; не зачитывай списки, код, логи и подробности, а скажи, что полный ответ доступен на экране.
```

#### Token effect

The Realtime model has an independent audio request containing the fixed instruction and four schemas, followed by transcription, function calls, bounded results, and spoken output. An accepted `dsh_turn` adds an ordinary follow-up or steering message to the current DSH Agent; replace also cancels existing work first. The Agent retains its normal context and tools.

#### KV Cache effect

The Realtime request has an independent cache lifetime; changing the model, instruction, or schemas invalidates its reusable prefix. Audio and function traffic grow after that prefix. The DSH Agent cache changes as for an ordinary follow-up, steering input, or cancel-and-replace sequence; Realtime audio and provider transcripts never enter its request.

## Known Limitations and Deferred Work

- **No direct subagent spawning** — ownership and result narration require a dedicated voice interaction design, so the shell exposes only the current Agent turn, cancellation, and status functions.
- **Consumer-owned browser peer** — signaling orchestration and `recvonly` peer-connection construction remain browser Consumer responsibilities.
- **Terminal activation failure** — exhausted sideband retries remove the logical call; a later status request returns `session not found`.
