# @deepseek-ai/dsh-client-wake-word-local

[English](README.md) | 中文

浏览器本地 Cordis 服务，通过用户校准模板检测俄语唤醒词字面量 **БРО**。它不是通用或预训练语音模型：每个浏览器配置都需要先采集该用户的若干独立样本，服务才进入可检测状态。

本包不负责采集麦克风。消费插件负责 `getUserMedia`、AudioWorklet、重采样策略和权限界面，再把有界的单声道 `Float32Array` 或有符号 `Int16Array` 帧传给 `ctx.wakeWord`。服务不使用 `SpeechRecognition`、`webkitSpeechRecognition`、`fetch`、`WebSocket`、`EventSource` 或其他网络路径。音频会被复制到内联 blob Web Worker，VAD、特征提取与匹配全部在 Worker 中执行，不占用 UI 线程进行声学推理。

## 服务 API

`ctx.wakeWord` 提供：

- `feed(pcm, sampleRate)`：输入流式推理帧；
- `onDetection(listener)`：订阅经过阈值和冷却限制的本地检测；
- `getState()` 与 `subscribe(listener)`：读取 Worker 就绪状态、启用状态、模板数量、错误和校准进度；
- `beginCalibration()`、`addCalibrationSample(pcm, sampleRate)` 与 `commitCalibration()`：执行替换式校准事务；
- `setEnabled(enabled)`：不删除校准数据地暂停或恢复推理；
- `dispose()`：终止 Worker、拒绝待处理校准调用并移除监听器。

消费插件应采集至少 `minTemplates` 个清晰的 **БРО** 发音，保持相似的麦克风位置，并让语速和音高有少量变化。`addCalibrationSample` 接收一个完整发音，仅在 Worker 将其转换为有界特征矩阵后才完成。`commitCalibration` 原子替换旧模板，并把派生矩阵写入 `localStorage`。原始 PCM 不会被存储、序列化或从 Worker 返回。清除配置的存储键即可在下次加载时删除校准。

## 匹配器

Worker 将音频重采样到 16 kHz，执行 RMS VAD 和静音裁剪，按 25 ms 窗长、10 ms 步长计算 Hamming 窗频谱，把 16 个 Mel 间隔对数滤波能量投影成八个归一化倒谱系数，再用带宽受限的归一化 DTW 比较有界候选窗口和说话人模板。在连续有声音频中，Worker 每四个 10 ms VAD 块评估一次模板长度的滑动窗口，因此 **БРО** 可在后续命令结束前触发，不要求唤醒词后有停顿。尾部 120 ms 静音或时长上限还会对完整 VAD 分段进行兜底评估。流式匹配成功后立即丢弃候选 PCM，为后续命令音频重置分段并进入冷却。最低距离必须不高于 `threshold`；阈值越低，误触越少但漏检越多。

输入限制为 8–48 kHz、非空且单次不超过 `maxFeedMs`；校准输入不超过 `maxSampleMs` 的两倍。VAD 裁剪后的发音必须位于 `minSampleMs` 到 `maxSampleMs` 之间。模板数量、特征维度、帧数、系数幅度、持久化字节数与 Worker 消息都在跨边界时受限或校验。

默认配置为 `threshold: 0.16`、`vadRms: 0.018`、`cooldownMs: 1500`、`minTemplates: 3`、`maxTemplates: 8`、`minSampleMs: 250`、`maxSampleMs: 2200`、`maxFeedMs: 250`、`enabled: true`，存储键为 `dsh:wake-word-local:БРО:v1`。部署方应按麦克风和环境噪声调整 `threshold` 与 `vadRms`，不要把默认值视为通用准确率承诺。

本包有意不包含 bundle composition 条目。将其加入某个 Web composition 后，其他浏览器插件可声明 Cordis 注入 `wakeWord` 来消费服务。

## 模型体验

### 浏览器本地检测

#### 模型可见内容

无。`ctx.wakeWord` 检测结果只作为浏览器本地回调数据；本包不增加模型输入、提示词、工具或会话日志事件。

#### Token 影响

无。本包不增加请求内容，也不发送模型提供方请求。

#### KV Cache 影响

无。本包不组装请求，也不改变先前请求 token。

## 已知限制与延期工作

- 准确率依赖说话人、麦克风、房间和校准质量。轻量匹配器没有音素模型、降噪、回声消除或预训练多语言表征。
- 滑动匹配按 40 ms 节奏检查，并仍依赖 VAD 找到发音起点。连续音乐、重叠语音、混响或过低的 VAD 阈值会降低准确率并增加误触。
- 校准数据只保存在当前浏览器配置中，不会同步。派生模板可被同源且能访问 `localStorage` 的脚本读取；它们不是原始音频，但仍属于语音派生数据，不再需要时应清除。
- 本包只提供帧匹配。麦克风采集、AudioWorklet 集成、权限界面、校准界面和检测后的动作由消费插件负责。
