import { describe, expect, it } from 'vitest'
import {
  createMatcherWorkerSource,
  installMatcherWorker,
  type MatcherWorkerScope,
  type WorkerMatcherConfig,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/client/worker.ts'

const RATE = 16_000

function tone(durationMs: number, frequency: number, phase = 0, amplitude = 0.32): Float32Array {
  const length = Math.round(durationMs * RATE / 1_000)
  const pcm = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const edge = Math.min(1, index / 160, (length - 1 - index) / 160)
    pcm[index] = Math.sin(2 * Math.PI * frequency * index / RATE + phase) * amplitude * Math.max(0, edge)
  }
  return pcm
}

function join(...parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function bro(shift = 0, phase = 0): Float32Array {
  return join(
    new Float32Array(80 * RATE / 1_000),
    tone(170, 360 + shift, phase),
    tone(170, 720 + shift, phase / 2),
    tone(170, 510 + shift, phase / 3),
    new Float32Array(80 * RATE / 1_000),
  )
}

const config: WorkerMatcherConfig = {
  threshold: 0.22,
  vadRms: 0.018,
  cooldownMs: 100,
  minTemplates: 2,
  maxTemplates: 4,
  minSampleMs: 250,
  maxSampleMs: 2_000,
}

function bench() {
  const responses: WorkerResponse[] = []
  const scope: MatcherWorkerScope = {
    onmessage: null,
    postMessage: response => { responses.push(response) },
    close: () => undefined,
  }
  installMatcherWorker(scope)
  const send = (message: WorkerRequest): void => {
    scope.onmessage?.({ data: message } as MessageEvent<WorkerRequest>)
  }
  send({ type: 'init', config, templates: [] })
  return { responses, send }
}

function calibrate(send: (message: WorkerRequest) => void): void {
  send({ type: 'beginCalibration' })
  send({ type: 'addCalibration', id: 1, pcm: bro(0, 0), sampleRate: RATE })
  send({ type: 'addCalibration', id: 2, pcm: bro(8, 0.15), sampleRate: RATE })
  send({ type: 'commitCalibration', id: 3 })
}

describe('inline matcher Worker', () => {
  it('matches БРО during continued voiced command audio without waiting for trailing silence', () => {
    const { responses, send } = bench()
    calibrate(send)
    const wake = bro(0, 0.03).subarray(0, bro().length - 80 * RATE / 1_000)
    const command = join(tone(350, 1_050, 0.2), tone(350, 900, 0.4), tone(350, 1_250, 0.1))
    const stream = join(wake, command)
    let detectedAfterSamples: number | undefined
    for (let offset = 0; offset < stream.length; offset += 160) {
      send({ type: 'feed', pcm: stream.slice(offset, offset + 160), sampleRate: RATE })
      if (responses.some(response => response.type === 'detected')) {
        detectedAfterSamples = Math.min(stream.length, offset + 160)
        break
      }
    }
    expect(detectedAfterSamples).toBeDefined()
    expect(detectedAfterSamples!).toBeLessThan(wake.length + 250 * RATE / 1_000)
    expect(detectedAfterSamples!).toBeLessThan(stream.length)
    expect(responses.filter(response => response.type === 'detected')).toHaveLength(1)
  })

  it('rejects calibration without speech and enforces the minimum template count', () => {
    const { responses, send } = bench()
    send({ type: 'beginCalibration' })
    send({ type: 'addCalibration', id: 10, pcm: new Float32Array(RATE), sampleRate: RATE })
    send({ type: 'commitCalibration', id: 11 })
    expect(responses).toContainEqual(expect.objectContaining({ type: 'requestError', id: 10 }))
    expect(responses).toContainEqual(expect.objectContaining({ type: 'requestError', id: 11 }))
  })

  it('builds an executable self-contained blob source without speech or network APIs', () => {
    const source = createMatcherWorkerSource()
    const responses: WorkerResponse[] = []
    const scope: MatcherWorkerScope = {
      onmessage: null,
      postMessage: response => { responses.push(response) },
      close: () => undefined,
    }
    new Function('self', source)(scope)
    scope.onmessage?.({ data: { type: 'init', config, templates: [] } } as unknown as MessageEvent<WorkerRequest>)
    expect(responses).toContainEqual({ type: 'ready', templateCount: 0 })
    expect(source).toContain('installMatcherWorker')
    expect(source).not.toMatch(/SpeechRecognition|webkitSpeechRecognition|fetch\s*\(|WebSocket|EventSource/)
  })
})
