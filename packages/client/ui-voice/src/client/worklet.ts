/** Inline AudioWorklet source because dynamic client plugins cannot ship assets. */
export const CAPTURE_PROCESSOR_SOURCE = `
class DshVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      const copy = channel.slice(0)
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor('dsh-voice-capture', DshVoiceCapture)
`

/**
 * Create a revocable Blob URL for the inline capture processor.
 * @returns processor URL and its idempotent revoker.
 */
export function createCaptureWorkletUrl(): { url: string; revoke: () => void } {
  const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR_SOURCE], { type: 'text/javascript' }))
  let revoked = false
  return {
    url,
    revoke: () => {
      if (revoked) return
      revoked = true
      URL.revokeObjectURL(url)
    },
  }
}
