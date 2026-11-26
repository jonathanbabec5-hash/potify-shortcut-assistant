import bplist from "bplist-creator";
import type { ShortcutPlist } from "./catalog";

export function encodeShortcutToPlist(shortcut: ShortcutPlist): Buffer {
  return bplist(shortcut);
}

export function encodeShortcutToBase64(shortcut: ShortcutPlist): string {
  return encodeShortcutToPlist(shortcut).toString("base64");
}
