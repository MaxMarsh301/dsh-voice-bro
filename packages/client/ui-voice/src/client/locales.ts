/** Simplified Chinese dictionary (key-set source of truth). */
export const zh = {
  'ptt.label': '按住说话',
  'ptt.active': '松开发送',
  'ptt.interrupt': '按住并打断回答',
  'handsFree.enable': '开启免手持',
  'handsFree.disable': '关闭免手持',
  'status.idle': '语音就绪',
  'status.interrupting': '正在打断语音回答',
  'status.requesting-microphone': '正在请求麦克风',
  'status.connecting': '正在连接语音',
  'status.listening': '正在聆听',
  'status.thinking': '正在处理语音',
  'status.speaking': '正在播放回答',
  'status.stopping': '正在停止语音',
  'status.error': '语音暂不可用',
  'status.tool': '工具已完成，等待语音回答',
  'cost.summary': '本次 {request} · 会话 {session}',
  'cost.breakdown': '音频 {audio} · 文本 {text} · 缓存输入 {cached} · 转录 {transcription}',
  'wake.armed': '说“БРО”开始',
  'wake.calibration': '唤醒词需要校准',
  'calibration.start': '校准 БРО',
  'calibration.hold': '按住并说 БРО',
  'calibration.release': '松开保存样本',
  'calibration.progress': '校准样本 {count}/{required}',
  'calibration.processing': '正在提取本地声纹特征',
  'action.cancel': '取消语音',
  'error.microphone': '无法使用麦克风',
  'error.connection': '语音连接失败；请在设置 → 模型中检查 OpenAI 密钥',
  'error.wake-word': '本地唤醒失败',
  'error.response': '语音回答失败',
  'error.calibration': '唤醒词校准失败，请重试',
} satisfies Record<string, string>

/** Voice locale key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, complete against the Chinese key set. */
export const en = {
  'ptt.label': 'Hold to talk',
  'ptt.active': 'Release to send',
  'ptt.interrupt': 'Hold to interrupt and talk',
  'handsFree.enable': 'Enable hands-free',
  'handsFree.disable': 'Disable hands-free',
  'status.idle': 'Voice ready',
  'status.interrupting': 'Interrupting spoken response',
  'status.requesting-microphone': 'Requesting microphone',
  'status.connecting': 'Connecting voice',
  'status.listening': 'Listening',
  'status.thinking': 'Processing voice',
  'status.speaking': 'Playing response',
  'status.stopping': 'Stopping voice',
  'status.error': 'Voice unavailable',
  'status.tool': 'Tool finished; waiting for spoken response',
  'cost.summary': 'Request {request} · session {session}',
  'cost.breakdown': 'Audio {audio} · text {text} · cached input {cached} · transcription {transcription}',
  'wake.armed': 'Say “БРО” to begin',
  'wake.calibration': 'Wake word needs calibration',
  'calibration.start': 'Calibrate БРО',
  'calibration.hold': 'Hold and say БРО',
  'calibration.release': 'Release to save sample',
  'calibration.progress': 'Calibration sample {count}/{required}',
  'calibration.processing': 'Deriving local voice features',
  'action.cancel': 'Cancel voice',
  'error.microphone': 'Microphone unavailable',
  'error.connection': 'Voice connection failed; check the OpenAI key in Settings → Models',
  'error.wake-word': 'Local wake failed',
  'error.response': 'Voice response failed',
  'error.calibration': 'Wake calibration failed; try again',
} satisfies Record<VoiceKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Voice capture, wake, and playback copy. */
    voice: VoiceKey
  }
}
