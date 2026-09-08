import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { handleVoiceNavigation } from '../src/client/navigation.ts'
import type {
  VoiceConsumerId, VoiceNavigationId, VoiceNavigationRequest, VoiceSessionId,
} from '../src/client/remote-adapter.ts'

const consumerId = 'consumer-1' as VoiceConsumerId
const voiceSessionId = 'voice-1' as VoiceSessionId
const navigationId = 'navigation-1' as VoiceNavigationId
const sid = (value: string): SessionId => value as SessionId

function request(patch: Partial<VoiceNavigationRequest> = {}): VoiceNavigationRequest {
  return {
    consumerId,
    voiceSessionId,
    navigationId,
    sessionId: sid('target'),
    reason: 'user-requested',
    ...patch,
  }
}

function bench() {
  let current: SessionId | undefined = sid('before')
  const open = vi.fn((sessionId: SessionId) => { current = sessionId })
  const ackNavigation = vi.fn(async (_sessionId, value) => ({
    ok: true as const,
    value: { navigationId: value.navigationId, acknowledged: true as const },
  }))
  return {
    current: () => current,
    open,
    ackNavigation,
    deps: {
      consumerId,
      ownsVoiceSession: (value: VoiceSessionId) => value === voiceSessionId,
      open,
      current: () => current,
      remote: { ackNavigation },
    },
  }
}

describe('global voice navigation', () => {
  it('opens, verifies, and acknowledges an addressed current-call request', async () => {
    const b = bench()
    await handleVoiceNavigation(request(), b.deps)
    expect(b.open).toHaveBeenCalledWith('target')
    expect(b.current()).toBe('target')
    expect(b.ackNavigation).toHaveBeenCalledWith(voiceSessionId, { navigationId, activated: true })
  })

  it('ignores another tab and a stale call without navigating or acknowledging', async () => {
    for (const foreign of [
      request({ consumerId: 'consumer-2' as VoiceConsumerId }),
      request({ voiceSessionId: 'voice-2' as VoiceSessionId }),
    ]) {
      const b = bench()
      await handleVoiceNavigation(foreign, b.deps)
      expect(b.open).not.toHaveBeenCalled()
      expect(b.ackNavigation).not.toHaveBeenCalled()
    }
  })

  it('acknowledges false when the target cannot become current', async () => {
    const b = bench()
    b.deps.open = vi.fn(() => { throw new Error('unknown Session') })
    await handleVoiceNavigation(request(), b.deps)
    expect(b.ackNavigation).toHaveBeenCalledWith(voiceSessionId, { navigationId, activated: false })
  })
})
