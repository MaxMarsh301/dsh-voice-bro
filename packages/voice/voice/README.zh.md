# `@deepseek-ai/dsh-voice`

[English](README.md) | 中文

面向一个由浏览器拥有的全局语音会话的 Host 服务定义。远程调用使用不透明逻辑 ID，而不是 DSH Agent 或 provider call id，因此一个 WebRTC 通话可以检查、寻址和导航普通 Session，而不成为任何 Session 生命周期的一部分。

## API

`start({ sdp, consumerId, foregroundSessionId? })` 返回浏览器 SDP answer、逻辑 ID 和到期时间，此时 provider sideband 可能仍在激活。`consumerId` 用于给发起通话的浏览器标签页定向导航；它不是凭据。拥有通话的浏览器会在每个门控短语前以新的 `VoiceResponseEpoch` 调用 `claimResponseEpoch`；provider 会抑制 captured epoch 已不再有效的迟到续写工作。Consumer 轮询 `status`，通过 `setForeground` 更新可见 Session，通过 `ackNavigation` 确认准确的 `voice/navigation-requested` 事件，通过 `ackCreation` 确认使用规范浏览器路径处理的 `voice/creation-requested` 结果，接收定向的 `voice/completion-requested` 信号以处理已结算的后台 Session 工作，并调用 `stop` 清理。创建请求会携带由 provider 所有的浏览器激活超时。Provider 按 `VoiceCreationId` 保留最终确认：重复提交相同结果会幂等成功，提交冲突结果则无效。Provider 拥有全局通话 lease，并拒绝并发通话。

所有请求、事件和结果字段均可安全表示为 JSON。`VoiceSessionId`、`VoiceConsumerId`、`VoiceRequestId`、`VoiceNavigationId`、`VoiceCreationId` 与 `VoiceResponseEpoch` 都是不透明品牌类型。服务事件只定向到匹配的浏览器 consumer。导航仍需浏览器确认；completion 信号只包含有界 request identity、Session identity、标题与终止状态，不包含 assistant 结果正文。

## 模型体验

### 服务调用

#### 模型看到什么

没有直接内容。`VoiceService` 不贡献 prompt、schema、结果或模型请求；Realtime 壳层与有界 Session 操作由 provider 负责。

#### Token 影响

直接 token 数为零。

#### KV Cache 影响

没有直接影响。调用或替换该服务不会改变 DSH Agent 请求前缀。

## 已知限制与延期工作

- **浏览器拥有实时通话** — WebRTC 状态是临时的，页面重载后不能恢复。持久化 hands-free 偏好只能在满足浏览器媒体要求后创建新通话。
- **定向事件而非连接身份** — 导航通过 Host 事件 carrier 使用随机的每标签页 consumer id。接收客户端会过滤该 id，并确认准确的导航操作。
