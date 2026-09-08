# `@deepseek-ai/dsh-voice-openai-realtime`

[English](README.md) | 中文

Host 全局 `ctx.voice` 租约的 OpenAI Realtime 提供商。它通过 `POST /v1/realtime/calls` 交换一个浏览器 SDP offer，立即返回 SDP answer，随后以有界重试激活带认证的服务端 sideband。一个进程只允许一个活跃逻辑 call，并通过 `consumerId` 定址其浏览器标签页；provider call id 始终保持私有。

## 配置

默认模型为 `gpt-realtime-2.1-mini`，转写模型为 `gpt-4o-mini-transcribe`，声音为 `cedar`，会话最长 3300 秒，每个 Realtime 响应最多输出 768 个 token，sideband WebSocket ping 间隔为 30 秒，浏览器导航确认超时为 5 秒，Session 创建确认使用独立的 30 秒超时。模型、转写和声音使用硬编码 allowlist。`maxSessionSeconds`、`maxResponseOutputTokens`、`httpTimeoutMs`、`sidebandPingIntervalMs`、`activationAttempts`、`activationRetryMs`、`navigationAckTimeoutMs` 与 `creationAckTimeoutMs` 均为带边界的部署设置；sideband 间隔允许 5,000 到 300,000 毫秒，创建确认允许 100 到 120,000 毫秒。可选 `proxyURL` 接受不含凭据的绝对 HTTP 或 HTTPS CONNECT 代理 URL，并让 call 创建与已认证 sideband WebSocket 共同使用该代理。

每次 `start` 都通过可选 `ctx.credentials` 解析 `OPENAI_API_KEY`，并回退到进程环境。请求拒绝重定向，携带由 `consumerId` 派生的假名化 `OpenAI-Safety-Identifier`，错误中不会包含提供商响应正文或凭据。

实时会话双向使用 24 kHz PCM16，浏览器以 `recvonly` 接收输出，关闭自动 turn detection，并仅输出音频。受控工具为 `find_threads`、`read_thread`、`create_thread`、`switch_thread`、`thread_turn`、`wait_for_thread`、`cancel_thread` 与 `get_voice_status`。`create_thread` 向所属浏览器发送定向命令，通过规范的 Workspace-backed Session 创建路径创建 Session，可选应用用户标题，并仅在浏览器确认可观察的 current selection 后提交语音前台 Session。它最多等待 `creationAckTimeoutMs`；若未收到确认，则返回 `disposition: 'outcome_unknown'`，且不包含 `created` 或 `activated`，因为浏览器操作仍可能在 Host 截止时间后完成。通话最多保留 128 条非等待中的创建记录：迟到确认会保存最终结果，内容相同的重复确认会幂等成功，冲突确认会被拒绝；活跃创建等待永不被淘汰。`switch_thread` 只在 `ctx.sessionQuery` 可见的普通 Session 中解析标题查询；多个匹配会返回有界候选而不导航，用户确认后必须提交准确 Session id。Session 发现和有界读取使用 `ctx.sessionQuery`，不会恢复 Agent。`find_threads` 始终匹配 Session 标题、workspace basename 与 id；部署启用全文搜索时还会加入事件内容匹配，而 `openAt: 'never'` 仍保留标题发现能力。空查询会先观察最后事件时间，再排序和限制，因此近期活跃的旧 Session 仍会出现在最近列表中；`has_more` 只计算符合所请求运行状态的条目。Turn 与取消操作通过 `ctx.typert.lookups.get('agent')` 解析普通 live 或 persisted Session，复用部署配置的 cold-session resolver；subagent 所属 Session 会明确返回不支持。

`thread_turn` 在交付前把每个已接受操作固定到其 Session 与新消息身份。`wait_for_thread` 通过准确的 `MessageId` 跟踪 durable `user/message`，只采集匹配 Turn 的 assistant 文本，并在匹配的 `turn/end` 结算；whole-Agent idle 仅用于报告一条已交付但在进入 Turn 前消失的消息。`reveal=immediately` 或 `reveal=on-complete` 会针对所属 `consumerId` 发出 `voice/navigation-requested`，并最多等待 `navigationAckTimeoutMs` 的 `ackNavigation`。超时返回 `activated: false`，语音外壳不得声称该线程已显示。

浏览器在每个短语前声明新的 response epoch，并通过 `response.create` metadata 携带它。Sideband 将 provider response id 映射到该 epoch；每个函数调用捕获自己的 response owner，串行输出会在写入 `function_call_output` 及保留 metadata 的续写前再次检查当前 Host epoch。因此 barge-in 会抑制退役 response 的迟到工具，而同一个 WebRTC 通话继续保留短期对话上下文。退役的 `wait_for_thread` 不会执行迟到的 `reveal=on-complete` 导航；其已结算请求会改为发出一次定向 `voice/completion-requested` 信号。所属浏览器声明新 epoch，在现有通话上启动通知 response；壳层通过 `wait_for_thread` 读取保留的准确结果，播报所属 Session，并在 `switch_thread` 前询问。多个 Session 请求和 completion 信号分别由 request id 标识。函数 call id 仍会去重，所以长时间的 `wait_for_thread` 或导航等待不会阻塞状态、取消或其他工具。WebSocket 协议 ping 会在这些等待不产生应用流量时保持已认证 sideband 活跃。停止、过期、sideband 失败或插件卸载会先阻止延迟输出，结算内部 waiter，停止 heartbeat，清除导航 timer，释放全局租约，再关闭 provider 资源，而不会等待 Agent 工作。在旧通话已经处于 stopping 时到达的 start 请求会先加入该 teardown，再获取租约。来自同一浏览器标签页 `consumerId` 的重连会等待尚未完成的 start，清理其遗留的活跃通话，再获取新租约；不同 consumer 仍不能替换活跃或尚在启动的通话。

## 模型体验

### Realtime 语音外壳请求

#### 模型看到什么

独立 Realtime 请求接收俄语 `VOICE_CORE` 指令、用户音频与转写，以及八个受控函数 schema。它最多能看到十个有界线程摘要、一个明确选中的普通线程中最多十二条 user/assistant 消息与 10 KiB 文本、有界状态和请求事实、一条只包含 request 与 Session metadata 的有界浏览器 completion message，以及匹配 Turn 最多 16 KiB 的 assistant 文本。它不会接收 DSH 工具 schema、工具结果、provider id、触发前音频、完整 Session 语料库或 subagent transcript。每个 Realtime 响应还受配置的输出 token 上限约束。

##### `VOICE_CORE`

```markdown
Ты — глобальная голосовая оболочка DSH. Не добавляй к запросу служебные пояснения, мета-инструкции или слова, которых пользователь не произносил. Тред — это Session: находи его через find_threads, читай только явно выбранный тред через read_thread и не угадывай при неоднозначности. create_thread создаёт Session через обычный браузерный путь и активирует её только после подтверждённого успеха. Для переключения используй switch_thread: сначала передай произнесённое название в query; если возвращено confirmation_required, перечисли варианты и дождись явного выбора пользователя, затем передай session_id выбранного варианта. Не выдавай неоднозначный выбор за подтверждённый. Для содержательной работы вызывай thread_turn, затем wait_for_thread с полученным request_id. Пользователь может прервать ожидание, запустить работу в других тредах и продолжить голосовой разговор; не считай это ошибкой и не отменяй уже запущенные запросы. Пустой session_id означает foreground_session_id из get_voice_status; если его нет, попроси пользователя выбрать тред. mode=steer корректирует активную работу, mode=followup ставит отдельный запрос, mode=replace допустим только после явной просьбы прервать текущую работу. switch_thread открывает тред в браузере, но утверждай, что он открыт, только когда activated=true. Не открывай завершившийся тред без подтверждения пользователя: сначала назови сессию, кратко озвучь результат и спроси, переключить ли браузер на неё. Не заявляй о завершении до результата wait_for_thread. Если требуется подтверждение на экране, скажи об этом и продолжай ждать. После результата произнеси по-русски максимум 45 слов в двух-трёх коротких предложениях: итог, важное ограничение или следующий шаг. Не зачитывай списки, код, логи и подробности; скажи, что полный ответ доступен на экране только если activated=true.
```

#### Token 影响

Realtime 模型拥有独立的音频请求，其中包含固定指令与八个 schema，之后追加转写、有界函数调用和结果以及语音输出。`find_threads` 与 `read_thread` 只把有界结果加入该请求。接受的 `thread_turn` 会向所选 DSH Agent 添加普通 follow-up 或 steering message；replace 会先取消既有工作。目标 Agent 保留其常规上下文与工具。

#### KV Cache 影响

Realtime 请求拥有独立的 cache 生命周期；改变模型、指令或 schema 会使其可复用前缀失效。音频与函数流量在该前缀之后增长。所选 DSH Agent cache 的变化与普通 follow-up、steering input 或 cancel-and-replace 序列一致；Realtime 音频、provider transcript、线程列表与读取片段绝不会进入其请求。

## 已知限制与延期工作

- **仅支持普通 Session** — 发现、读取、创建、切换、turn 交付与取消都会排除 subagent Session，直到具备专门的 subagent 交付与结果所有权设计。
- **单进程全局租约** — 提供商只允许一个活跃 call，但不会跨进程或浏览器 reload 持久化或恢复 WebRTC 状态。
- **浏览器 peer 由 Consumer 拥有** — 信令编排、`consumerId` 生命周期、麦克风采集、barge-in、播放、导航执行与确认仍由浏览器 Consumer 负责。
- **激活失败即终止** — sideband 重试耗尽后会删除逻辑 call；之后查询状态会返回 `session not found`。
