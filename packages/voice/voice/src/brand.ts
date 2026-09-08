/** Runtime and type identities for Host-managed global voice operations. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque logical id that never reveals a provider call id. */
export type VoiceSessionId = Branded<'VoiceSessionId'>
/** Browser-tab identity used to address navigation without exposing a connection object. */
export type VoiceConsumerId = Branded<'VoiceConsumerId'>
/** Opaque identity of one request submitted by the voice shell to a DSH Session. */
export type VoiceRequestId = Branded<'VoiceRequestId'>
/** Opaque identity of one browser navigation request. */
export type VoiceNavigationId = Branded<'VoiceNavigationId'>
/** Opaque identity of one browser-owned Session creation request. */
export type VoiceCreationId = Branded<'VoiceCreationId'>
/** Opaque browser-minted ownership generation for one gated phrase. */
export type VoiceResponseEpoch = Branded<'VoiceResponseEpoch'>

/**
 * Brand one Host-created logical voice-session id.
 * @param value - Validated opaque value.
 * @returns Branded id.
 */
export const VoiceSessionId = (value: string): VoiceSessionId => value as VoiceSessionId
/**
 * Brand one browser-tab consumer id.
 * @param value - Validated opaque value.
 * @returns Branded id.
 */
export const VoiceConsumerId = (value: string): VoiceConsumerId => value as VoiceConsumerId
/**
 * Brand one voice-dispatched request id.
 * @param value - Validated opaque value.
 * @returns Branded id.
 */
export const VoiceRequestId = (value: string): VoiceRequestId => value as VoiceRequestId
/**
 * Brand one voice navigation id.
 * @param value - Validated opaque value.
 * @returns Branded id.
 */
export const VoiceNavigationId = (value: string): VoiceNavigationId => value as VoiceNavigationId
/**
 * Brand one voice Session-creation request id.
 * @param value - Validated opaque value.
 * @returns Branded id.
 */
export const VoiceCreationId = (value: string): VoiceCreationId => value as VoiceCreationId
/**
 * Brand one browser-minted response ownership generation.
 * @param value - Validated opaque value.
 * @returns Branded epoch.
 */
export const VoiceResponseEpoch = (value: string): VoiceResponseEpoch => value as VoiceResponseEpoch
