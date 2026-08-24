/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-wake-word-local`.
 * @module @deepseek-ai/dsh-client-wake-word-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-wake-word-local'

/** Cordis companion plugin name. */
export const name = 'client-wake-word-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: matching and calibration are confined to a browser
 * Worker, and the package emits no Cordis event or cross-plugin mutable record.
 * Worker disposal, derived-only persistence, and detection publication are
 * exercised by package tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
