/**
 * A stable, anonymous identifier for this browser.
 *
 * It exists for exactly one reason: so a person can be asked for consent, and
 * can later withdraw it and have their data deleted. Without a stable id there
 * is no "their data" to delete.
 *
 * It is a random value with no relationship to anything about the user, it
 * never leaves this device in raw form (the server hashes it on arrival), and
 * clearing site data destroys it. Generating it does not enable collection —
 * nothing is retained until consent is granted separately.
 */

const KEY = "potify.studio.subject";

function randomId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let cached: string | null = null;

export function getSubjectId(): string {
  if (cached) return cached;

  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.length >= 16) {
      cached = existing;
      return existing;
    }
    const created = randomId();
    localStorage.setItem(KEY, created);
    cached = created;
    return created;
  } catch {
    // Private browsing, or storage disabled. Use a per-session id: consent will
    // simply not persist across reloads, which is the safe direction.
    cached ??= randomId();
    return cached;
  }
}

/** Forgets the local identifier. Server-side deletion is a separate call. */
export function forgetSubjectId(): void {
  cached = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — the in-memory value is already cleared.
  }
}
