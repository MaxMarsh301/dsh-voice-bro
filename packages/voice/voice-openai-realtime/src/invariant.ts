/** Package invariant companion for the OpenAI Realtime voice provider. @module @deepseek-ai/dsh-voice-openai-realtime/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
/** No runtime invariant: provider call ids, sockets, and teardown state are private to one service instance and have no independent authoritative event stream. */
const install: InvariantInstaller = () => {}
/** Cordis companion plugin name. */
export const name = 'voice-openai-realtime-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
/** Register provider ownership; lifecycle is private and unit-tested. @param ctx - invariant context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-voice-openai-realtime', install))
