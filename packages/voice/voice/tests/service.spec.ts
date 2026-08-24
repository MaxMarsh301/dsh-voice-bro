import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import VoiceService, { VoiceSessionId } from '../src/index.ts'

class MemoryVoice extends VoiceService {
  constructor(ctx: Context) { super(ctx) }
  async start(): Promise<never> { throw new Error('unused') }
  async status(_agent: Agent, sessionId: VoiceSessionId) { return { sessionId, state: 'active' as const, sidebandReady: true, startedAt: 1, expiresAt: 2 } }
  async stop(_agent: Agent, sessionId: VoiceSessionId) { return { sessionId, stopped: true as const } }
}

describe('VoiceService remote adapters', () => {
  it('delegates generated remote methods without changing logical ids', async () => {
    const service = new MemoryVoice(new Context())
    const agent = {} as Agent
    const id = VoiceSessionId('voice-test')
    await expect(service.remoteExportStatus(agent, id)).resolves.toEqual({ sessionId: id, state: 'active', sidebandReady: true, startedAt: 1, expiresAt: 2 })
    await expect(service.remoteExportStop(agent, id)).resolves.toEqual({ sessionId: id, stopped: true })
  })
})
