// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WakeWordService } from '../src/client/service.ts'
import {
  installMatcherWorker,
  type MatcherWorkerScope,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/client/worker.ts'

const RATE = 16_000
const STORAGE_KEY = 'test:wake-word-local'

function tone(durationMs: number, frequency: number): Float32Array {
  const pcm = new Float32Array(Math.round(durationMs * RATE / 1_000))
  for (let index = 0; index < pcm.length; index += 1) {
    const edge = Math.min(1, index / 120, (pcm.length - 1 - index) / 120)
    pcm[index] = Math.sin(2 * Math.PI * frequency * index / RATE) * 0.3 * Math.max(0, edge)
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

function sample(shift = 0): Float32Array {
  return join(new Float32Array(800), tone(180, 360 + shift), tone(180, 720 + shift), tone(180, 510 + shift), new Float32Array(800))
}

class InlineFakeWorker {
  static instances: InlineFakeWorker[] = []
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  private readonly scope: MatcherWorkerScope

  constructor() {
    this.scope = {
      onmessage: null,
      postMessage: message => { this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>) },
      close: () => undefined,
    }
    installMatcherWorker(this.scope)
    InlineFakeWorker.instances.push(this)
  }

  postMessage(message: WorkerRequest): void {
    this.scope.onmessage?.({ data: message } as MessageEvent<WorkerRequest>)
  }

  terminate(): void {
    this.terminated = true
  }
}

async function serviceBench() {
  const root = new Context()
  await root.plugin(WakeWordService, {
    storageKey: STORAGE_KEY,
    minTemplates: 2,
    maxTemplates: 4,
    threshold: 0.22,
  }).await()
  const service = root.get('wakeWord') as WakeWordService
  return { root, service }
}

beforeEach(() => {
  localStorage.clear()
  InlineFakeWorker.instances = []
  vi.stubGlobal('Worker', InlineFakeWorker)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-worker') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WakeWordService', () => {
  it('feeds only the Worker and never fetches, opens a socket, or detaches caller PCM', async () => {
    const fetchSpy = vi.fn()
    const socketSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', socketSpy)
    const { service } = await serviceBench()
    const pcm = tone(20, 440)
    const bufferBytes = pcm.buffer.byteLength
    service.feed(pcm, RATE)
    expect(pcm.buffer.byteLength).toBe(bufferBytes)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(socketSpy).not.toHaveBeenCalled()
  })

  it('persists only bounded derived feature templates, never raw samples', async () => {
    const { service } = await serviceBench()
    service.beginCalibration()
    const rawA = sample(0)
    const rawB = sample(7)
    await expect(service.addCalibrationSample(rawA, RATE)).resolves.toBe(1)
    await expect(service.addCalibrationSample(rawB, RATE)).resolves.toBe(2)
    await expect(service.commitCalibration()).resolves.toBe(2)

    const serialized = localStorage.getItem(STORAGE_KEY)
    expect(serialized).not.toBeNull()
    const record = JSON.parse(serialized!) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(['keyword', 'templates', 'version'])
    const templates = record.templates as number[][][]
    expect(templates).toHaveLength(2)
    expect(templates.every(template => template.length < rawA.length && template.every(frame => frame.length === 8))).toBe(true)
    expect(serialized).not.toContain('pcm')
    expect(serialized!.length).toBeLessThan(rawA.byteLength + rawB.byteLength)
    expect(service.getState()).toMatchObject({ ready: true, templateCount: 2, calibration: { active: false } })
  })

  it('enforces frame bounds and terminates its Worker on disposal', async () => {
    const { service } = await serviceBench()
    expect(() => service.feed(new Float32Array(0), RATE)).toThrow(/1-/)
    expect(() => service.feed(new Float32Array(10), 7_999)).toThrow(/8000/)
    expect(() => service.feed(new Float32Array(RATE), RATE)).toThrow(/1-/)
    service.dispose()
    expect(InlineFakeWorker.instances[0]!.terminated).toBe(true)
    expect(() => service.feed(new Float32Array(10), RATE)).toThrow(/disposed/)
  })
})
