/**
 * Browser-only local wake-word plugin, host half. The empty host plugin lets the
 * Loader discover the separately bundled `./client` implementation.
 */

/** Host plugin body; microphone frames and matching stay in the browser. */
export function apply(): void {}
