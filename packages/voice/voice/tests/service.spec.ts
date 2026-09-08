import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import VoiceService, { VoiceCreationId, VoiceNavigationId, VoiceResponseEpoch, VoiceSessionId } from '../src/index.ts'

class MemoryVoice extends VoiceService {
  constructor(ctx: Context) { super(ctx) }
  async start(): Promise<never> { throw new Error('unused') }
  async status(sessionId: VoiceSessionId) { return { sessionId, state: 'active' as const, sidebandReady: true, startedAt: 1, expiresAt: 2 } }
  async setForeground(sessionId: VoiceSessionId, foregroundSessionId: never) { return { sessionId, foregroundSessionId } }
  async claimResponseEpoch(sessionId: VoiceSessionId, epoch: VoiceResponseEpoch) { return { sessionId, epoch, claimed: true as const } }
  async ackNavigation(_sessionId: VoiceSessionId, request: { navigationId: VoiceNavigationId; activated: boolean }) { return { navigationId: request.navigationId, acknowledged: true as const } }
  async ackCreation(_sessionId: VoiceSessionId, request: Parameters<VoiceService['ackCreation']>[1]) { return { creationId: request.creationId, acknowledged: true as const } }
  async stop(sessionId: VoiceSessionId) { return { sessionId, stopped: true as const } }
}

describe('VoiceService remote methods', () => {
  it('preserves logical ids across the global lifecycle', async () => {
    const service = new MemoryVoice(new Context())
    const id = VoiceSessionId('voice-test')
    const navigationId = VoiceNavigationId('navigation-test')
    const creationId = VoiceCreationId('creation-test')
    const epoch = VoiceResponseEpoch('response-epoch-test')
    await expect(service.status(id)).resolves.toEqual({ sessionId: id, state: 'active', sidebandReady: true, startedAt: 1, expiresAt: 2 })
    await expect(service.claimResponseEpoch(id, epoch)).resolves.toEqual({ sessionId: id, epoch, claimed: true })
    await expect(service.ackNavigation(id, { navigationId, activated: true })).resolves.toEqual({ navigationId, acknowledged: true })
    await expect(service.ackCreation(id, { creationId, created: false, activated: false })).resolves.toEqual({ creationId, acknowledged: true })
    await expect(service.stop(id)).resolves.toEqual({ sessionId: id, stopped: true })
  })
})
