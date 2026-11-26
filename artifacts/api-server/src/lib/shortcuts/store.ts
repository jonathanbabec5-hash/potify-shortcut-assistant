import { randomBytes } from "node:crypto";
import type { ShortcutPlist } from "./catalog";

interface StoredShortcut {
  shortcut: ShortcutPlist;
  createdAt: number;
}

const store = new Map<string, StoredShortcut>();
const TTL_MS = 15 * 60 * 1000; // 15 minutes

export function storeShortcut(shortcut: ShortcutPlist): string {
  const id = randomBytes(16).toString("hex");
  store.set(id, { shortcut, createdAt: Date.now() });
  cleanup();
  return id;
}

export function getStoredShortcut(id: string): ShortcutPlist | undefined {
  const entry = store.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return undefined;
  }
  return entry.shortcut;
}

function cleanup(): void {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (now - entry.createdAt > TTL_MS) {
      store.delete(id);
    }
  }
}
