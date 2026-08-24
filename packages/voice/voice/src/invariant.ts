/** Package invariant companion for `@deepseek-ai/dsh-voice`. @module @deepseek-ai/dsh-voice/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
/** No runtime invariant: the Service Definition owns no mutable data; concrete providers own voice-session lifecycle relations. */
const install: InvariantInstaller = () => {}
/** Cordis companion plugin name. */
export const name = 'voice-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
/** Register the package ownership slot; providers own mutable lifecycle relations. @param ctx - invariant context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-voice', install))
