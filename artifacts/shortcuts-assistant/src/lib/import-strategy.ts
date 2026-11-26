/**
 * Centralized import strategy module.
 * Implements the 3-path import flow used identically by Generate, Validate (post-repair), and Builder.
 *
 * Path C (primary): open shortcuts://import-shortcut?url=<hosted-file-url>
 *   → prompt "Did Shortcuts open?" Yes / No
 *   → Yes → success
 *   → No  → Path D
 *
 * Path D (fallback): offer file download + manual import instructions
 *
 * Path E (always-present): link to Builder tab for visual step-by-step reference
 */

import { useState, useCallback } from 'react';

export type ImportStage = 'idle' | 'path-c-prompt' | 'path-d' | 'success';

export interface ImportStrategyResult {
  stage: ImportStage;
  /** Open the shortcuts:// URL scheme and advance to the confirmation prompt. */
  startImport: () => void;
  /** User confirmed Shortcuts opened successfully. */
  confirmSuccess: () => void;
  /** User reported Shortcuts did not open; fall through to file download. */
  fallbackToDownload: () => void;
  /** Download the .shortcut file directly (Path D). */
  triggerDownload: () => void;
  /** Reset state back to idle. */
  reset: () => void;
  /** The absolute file URL, or undefined if not yet available. */
  absoluteFileUrl: string | undefined;
}

/**
 * Hook that encodes the 3-path import logic.
 *
 * @param apiFileUrl The relative URL returned by the API (e.g. /api/shortcuts/file/abc123)
 * @returns ImportStrategyResult — bind startImport to the primary CTA, wire Yes/No buttons
 *          to confirmSuccess/fallbackToDownload, and always show a Path E link to Builder.
 */
export function useImportStrategy(apiFileUrl: string | undefined): ImportStrategyResult {
  const [stage, setStage] = useState<ImportStage>('idle');

  const absoluteFileUrl = apiFileUrl
    ? window.location.origin + apiFileUrl
    : undefined;

  const startImport = useCallback(() => {
    if (!absoluteFileUrl) return;
    // Path C: attempt URL scheme import
    window.location.href = `shortcuts://import-shortcut?url=${encodeURIComponent(absoluteFileUrl)}`;
    // After 1.2 s (enough for Shortcuts to open), show the confirmation prompt
    setTimeout(() => setStage('path-c-prompt'), 1200);
  }, [absoluteFileUrl]);

  const confirmSuccess = useCallback(() => {
    setStage('success');
  }, []);

  const fallbackToDownload = useCallback(() => {
    setStage('path-d');
  }, []);

  const triggerDownload = useCallback(() => {
    if (!apiFileUrl) return;
    const a = document.createElement('a');
    a.href = apiFileUrl;
    a.download = 'shortcut.shortcut';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [apiFileUrl]);

  const reset = useCallback(() => {
    setStage('idle');
  }, []);

  return {
    stage,
    startImport,
    confirmSuccess,
    fallbackToDownload,
    triggerDownload,
    reset,
    absoluteFileUrl,
  };
}
