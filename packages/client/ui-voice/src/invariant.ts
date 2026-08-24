/** Package invariant companion for `@deepseek-ai/dsh-client-ui-voice`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-voice'

/** Cordis companion plugin name. */
export const name = 'client-ui-voice-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: media and WebRTC ownership is browser-local and is
 * verified through controller teardown and plugin-fiber disposal tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
