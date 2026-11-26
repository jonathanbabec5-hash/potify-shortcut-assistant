/**
 * The client build identifier, sent as run provenance.
 *
 * Guarded with `typeof` so the module stays importable anywhere the vite
 * `define` has not been applied (unit tests, node tooling) instead of throwing
 * a ReferenceError at import time.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
