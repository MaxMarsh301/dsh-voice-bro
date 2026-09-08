# @deepseek-ai/dsh-client-ui-voice

[English](README.md) | 中文

本包为一个 Host 托管的全局语音通话提供浏览器 UI 与音频传输。插件向 `sidebar.footer.action` 注入紧凑的全局语音入口，向 `conversation.input.dock` 注入标准的生命周期、转写、取消、唤醒就绪与费用面板，并向 `settings.section` 注入浏览器本地校准。按住说话和免手持控件位于全局语音面板，`conversation.input.right` 中不包含语音按钮。一个 root scope 的 `VoiceSessionController` 会跨前台 Session 切换持续存在；侧边栏入口与面板调用同一个控制器。

插件为每个浏览器标签页创建一个 `VoiceConsumerId`，通过 session storage 让它跨 reload 与 HMR 保持稳定，并在新标签页导航时轮换复制来的值。存在前台 Session 时，插件将其随通话启动请求提交。插件观察 `ctx.sessions.list.current`，并通过 `voice.setForeground` 发布后续选择变化。只有 consumer id 与 voice-session id 都属于当前页面的 `voice/creation-requested`、`voice/navigation-requested` 和 `voice/completion-requested` 事件才会被接受。创建通过 `ctx.workspaces.createSession()` 执行，因此目标只来自显式、当前或最近的可访问 Workspace，并沿用普通 Host `session.create` 策略；插件可选通过 Session face 重命名，在打开前先订阅 selection，并且只在 Host 提供的期限内从可观察 current selection 中看到新 Session 后报告激活。每个 creation id 都保留稳定的确认 payload；重复投递不会再次创建 Session，而会重试尚未确认的 ACK。Effect 卸载会中止激活等待并移除订阅。导航通过 `ctx.sessions.open` 打开目标，验证同步更新后的 current selection，再确认结果。Completion 信号进入有界队列，只在持久通话空闲时开始语音播报。其他标签页与过期通话会被忽略。

按下指针会打开采集门并开始麦克风和 WebRTC 建连。抬起指针只会在门内 PCM 超过已配置的语音活动阈值后提交；空白、静音或低能量噪声不会发送 `input_audio_buffer.commit` 或 `response.create`，而一个有声 PCM 块仍足以提交短语。本地音频可在建连时缓冲，但只有有序 `oai-events` 数据通道已打开且 Host `sidebandReady` 为真后才会发送。

麦克风由 `AudioContext` 和内联 Blob `AudioWorklet` 采集，因此动态客户端插件不需要音频资源。同一活动 context 会在本地合成 160 ms 的唤醒确认音，不会把它加入捕获 PCM 或 WebRTC Peer。单声道 Float32 经过线性重采样，转换为 24 kHz PCM16 小端并以 base64 发送。麦克风轨道绝不会加入 `RTCPeerConnection`；Peer 只有 recvonly 音频 transceiver 和有序数据通道。远端 RTP 由控制器拥有的隐藏 audio 元素播放。

协议顺序为：完整 ICE offer → `voice.start({ sdp, consumerId, foregroundSessionId? })` → 安装 answer → 等待数据通道与 Host sideband。每个短语先声明新的 Host response epoch，再发送 `input_audio_buffer.clear` → 零个或多个 `append` → `commit` → 携带该 epoch 的 `response.create`。最终 `response.done` 只表示生成完成；控制器等待同一响应的 `output_audio_buffer.stopped` 后让短语回到空闲，而 WebRTC peer、数据通道、Host sideband、provider 对话、进程全局 lease 与累计费用继续存活。在生成或播放期间，新的按住说话手势或免手持唤醒会立即暂停本地 audio 元素，即使生成已经结束也会清除 provider 输出，并且只在 provider response 仍打开时取消它，然后退役旧 epoch。如果现有麦克风采集仍在，替换门会在 Host 声明完成前打开，从而保留很短的有声纠正；commit 与 `response.create` 仍由新的 Host owner 保护，声明完成后的第二次输出清除会移除在声明期间竞态到达的音频。仅含工具的 `response.done` 会让后台 Session 工作继续，但它不再是活跃 provider response，因此新短语不会发送无效 cancel 或关闭通话。退役 epoch 的迟到创建、完成、转写、播放、错误、计时器与 Host 工具续写都不能修改或结束新短语，被打断的 completion 播报也不会重新排队播放。手动取消、致命传输或 provider 错误、卸载、麦克风所有者转移与 Host expiry 会关闭通话。首个工具响应出现后，不再使用普通语音响应超时，因为审批和 Harness 工具可能长时间等待；显式取消和 Host 上限仍然有效。退役 Session 工作结算后，定向 completion 队列会声明新 epoch，要求 Realtime 壳层读取准确 request 结果，播报所属 Session，并在导航前询问；多个 completion 会在不替换通话的情况下串行播报。

侧边栏入口在宽侧边栏与紧凑图标栏中始终可见。它显示语音可用状态，在输入卡片上方的 composer dock 中打开标准语音面板，并在再次选择时关闭该面板。持久化展开模式初始为 `auto`：空闲时面板保持关闭，出现回答文本或 Realtime 壳层选择 allowlist 中的操作时自动打开；用户显式关闭或打开后，该选择会跨活动更新、打断、返回空闲、重新挂载与页面重载保持。回答文本与所有费用数值只在 composer 面板中显示。面板保留最近六个有序操作，标记当前和已完成步骤，把有界 `thread_turn` prompt 显示为即将发送给目标 Session 的明确文本，并把最终语音 transcript 保留到下一次短语或取消。窗口不显示隐藏推理、原始工具结果、provider 错误或 Session 历史。

免手持必须由用户手势启用。插件获取麦克风并启用 `ctx.wakeWord`，把原始 Float32 工作线程帧送入本地匹配器。只有字面量 `БРО` 的 provider 检测会打开短语门，本地 RMS VAD 会结束短语。被接受的检测会在短语门设置前至多播放一次本地确认音；短语门生命周期拒绝的重复检测保持静音。播放默认开启，可在 Voice Settings 中独立关闭，并持久化到浏览器存储；音频输出失败不能阻止已接受的唤醒。本插件不声称提供通用关键词识别。Voice Settings 页面为未就绪的匹配器提供首次校准，也为已就绪的匹配器提供重新校准。开始任一 Settings 事务都会取得独占麦克风所有权并停用免手持检测；用户录制 provider 要求数量的独立 `БРО` 样本，wake provider 只在所需样本全部提交后原子替换旧的派生模板。原始 PCM 只短暂存在于有界内存，送入 provider 后会清零，永不持久化；provider 只保存派生模板。

唯一的语音控制器与 Settings 校准控制器共享一个麦克风 coordinator。HMR 或插件卸载会取消 wake、Session selection、创建、导航和 completion 订阅，并停止轨道、worklet、`AudioContext`、数据通道、Peer、定时器、Blob URL、audio 元素、本地缓冲与 Host 语音通话。Host stop 拒绝会被收敛为通用连接失败，不能阻止本地媒体清理或 coordinator 释放；插件不会调用由 Cordis 拥有的 `wakeWord.dispose()`。

数据通道 JSON 按不可信输入解析。UI 只接受已知生命周期事件和字符串转写字段；provider 原始错误消息与状态详情会被丢弃，只显示本地化的通用错误。

控制器只对 provider 报告的完整 token 用量计费。`response.done` 用量采用官方 `gpt-realtime-2.1-mini` 文本、音频和按模态区分的缓存输入费率，输入转写完成事件则采用独立的 `gpt-4o-mini-transcribe` 费率。缓存 token 仍是模态输入的子集，只计费一次。整数纳美元累加器跨传输清理保留最近一次已提交短语与全局通话总额，并分为音频、文本、缓存和转写类别。已提交输入 item 与 response epoch 的归属关系保证被打断短语的迟到用量只增加通话总额，不会加入替换短语。展开后的语音面板是唯一费用显示位置，其中包含本次请求、通话总额与分类明细。渲染前会校验总额、分类与报告状态的关系，并记录被拒绝的计费或显示更新而不暴露 provider 详情；格式错误、字段不完整、按时长计费、缺失或不一致的用量不会被估算。费率来源为 OpenAI 的[模型定价](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)、[转写定价](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)与 [Realtime 费用指南](https://developers.openai.com/api/docs/guides/realtime-costs)。

## 配置

`Config` 校验以下部署参数：`maxBufferedChunks`、`channelHighWaterBytes`、`channelLowWaterBytes`、`statusAttempts`、`statusIntervalMs`、`iceTimeoutMs`、`channelTimeoutMs`、`responseTimeoutMs`、`vadThreshold`、`vadSilenceMs` 与 `wakeSignalDefault`。提示音默认值为 `true`；显式浏览器偏好会覆盖它。低水位必须小于高水位。Host 会话过期与 provider 协议常量不是浏览器参数。

`/client` 公共 API 只包含 Cordis 加载值（`apply`、`inject`、`Config`）、派生组件属性所需的 settings store factory 与共享类型。组件、协议 helper、adapter 和音频工具保持包内私有。

## 模型体验

### 门控 Realtime 音频

#### 模型看到什么

本地唤醒或按住说话激活后，`VoiceSessionController` 才会向 Host 选择的全局 Realtime 通话发送有界 PCM append 事件。前台 Session 变化和导航确认不添加模型内容。收到定向后台 completion 后，控制器会添加一条有界 system message，其中只包含 request id、Session id、标题与终止状态；它要求 Realtime 壳层通过 `wait_for_thread` 读取结果、总结并在导航前询问用户。转写、结果正文与 thread routing 由 Host provider 负责。

#### Token 影响

没有直接文本 token。所选 Realtime provider 可以独立计量门控音频及其 transcript；触发前的本地音频不产生任何贡献。

#### KV Cache 影响

在 Host provider 提交普通 follow-up 之前，DSH Agent 的普通请求前缀不变。Realtime provider 跨前台 Session 切换保留独立通话上下文；本浏览器包不控制该 cache，但当 provider 提供完整模态明细时，费用计量器会报告缓存输入用量。

## 已知限制与延后工作

- 唤醒识别依赖浏览器配置、说话人、麦克风和房间。`需要校准` 是明确状态，不代表少量样本就能得到生产级关键词识别。
- 校准模板保存在 wake provider 的本地浏览器存储中，不跨浏览器同步。
- 页面重载后无法恢复实时 WebRTC 通话；只有浏览器本地偏好和唤醒模板会持久化。
- Provider 通话只在手动取消、致命故障、卸载或重载、麦克风所有者转移或 Host expiry 时丢弃短期 Realtime 对话上下文。普通目标 Session 中的工作仍通过常规 Session 日志与记忆路径持久化。
