/**
 * Deterministic PII / secret detection and redaction.
 *
 * This module is a PREREQUISITE for any interaction collection. Nothing in the
 * learning subsystem may retain user text that has not passed through `redact`.
 *
 * Design rules (deliberate, do not relax without review):
 *
 *  1. **No LLM.** Detection is pure regex + Luhn. It must be deterministic and
 *     auditable, and it must work when the model provider is down.
 *  2. **Findings never carry the matched value.** A `PiiFinding` records the
 *     class and the offsets only. If findings were allowed to carry raw text,
 *     the redaction audit trail would itself become a PII store.
 *  3. **Over-redaction is the safe failure.** Where a pattern is ambiguous the
 *     class is emitted with `confidence: "medium"` and still redacted. Losing a
 *     capitalised product name to `[[PERSON_1]]` costs a little training signal;
 *     leaking a real name costs trust.
 *  4. **Secrets are not merely redacted — they poison the record.** Any
 *     `secret` or `credentialed-url` hit sets `containsSecret`, and the
 *     collector must drop (not redact) the whole interaction. A prompt that
 *     contained a live key is evidence of a mistake we should not archive.
 *  5. **Placeholders are stable within one text.** The same value maps to the
 *     same token so relational structure ("message Ann ... tell Ann") survives
 *     for learning. The value→token map is local to the call and discarded on
 *     return; it is never returned or logged.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PiiClass =
  | "secret"
  | "credentialed-url"
  | "email"
  | "payment-card"
  | "coordinates"
  | "ip-address"
  | "phone"
  | "street-address"
  | "handle"
  | "person-name"
  | "personal-relation";

/** Positions and class only — never the matched text. See rule 2 above. */
export interface PiiFinding {
  class: PiiClass;
  start: number;
  end: number;
  length: number;
  confidence: "high" | "medium";
}

export interface RedactionResult {
  /** The input with every finding replaced by a stable `[[CLASS_n]]` token. */
  redacted: string;
  findings: PiiFinding[];
  /** Unique classes present, sorted. Safe to persist as record metadata. */
  classes: PiiClass[];
  /**
   * True when a live credential was detected. The interaction must be DROPPED,
   * not stored — redaction is not sufficient remediation for a leaked key.
   */
  containsSecret: boolean;
  /** True when no findings at all. */
  clean: boolean;
}

// ── Class priority ────────────────────────────────────────────────────────────

/**
 * Higher wins when two patterns overlap. Secrets outrank everything so a token
 * that also looks like a hex string or a phone number is still classed secret.
 */
const CLASS_PRIORITY: Record<PiiClass, number> = {
  secret: 100,
  "credentialed-url": 95,
  email: 90,
  "payment-card": 85,
  coordinates: 80,
  "ip-address": 75,
  "street-address": 70,
  phone: 65,
  handle: 60,
  "person-name": 40,
  "personal-relation": 35,
};

const SECRET_CLASSES: ReadonlySet<PiiClass> = new Set<PiiClass>([
  "secret",
  "credentialed-url",
]);

// ── Patterns ──────────────────────────────────────────────────────────────────

interface PatternSpec {
  cls: PiiClass;
  re: RegExp;
  confidence: "high" | "medium";
  /** Optional extra test; return false to reject a candidate match. */
  accept?: (match: string) => boolean;
}

/**
 * Words that are capitalised in ordinary shortcut descriptions and are NOT
 * people. Without this list "Open Spotify" yields a phantom person.
 */
const NON_PERSON_CAPITALISED = new Set(
  [
    // Apple surface
    "iphone", "ipad", "mac", "watch", "siri", "apple", "shortcuts", "shortcut",
    "homekit", "carplay", "airdrop", "airplay", "facetime", "imessage", "icloud",
    // first-party apps
    "safari", "maps", "notes", "reminders", "calendar", "weather", "photos",
    "music", "podcasts", "mail", "messages", "phone", "clock", "health",
    "wallet", "files", "camera", "contacts", "home", "news", "books", "stocks",
    // common third-party
    "spotify", "whatsapp", "telegram", "signal", "slack", "gmail", "outlook",
    "youtube", "netflix", "uber", "strava", "notion", "todoist", "instagram",
    "twitter", "facebook", "tiktok", "linkedin", "discord", "zoom", "teams",
    // tech nouns
    "wifi", "bluetooth", "gps", "nfc", "vpn", "url", "api", "json", "ios",
    "airpods", "lte", "sms",
    // shortcut-domain nouns that are routinely title-cased in descriptions
    "app", "apps", "store", "screen", "mode", "focus", "battery", "location",
    "time", "date", "text", "list", "note", "reminder", "event", "alarm",
    "timer", "playlist", "album", "song", "video", "photo", "level", "current",
    "low", "power", "do", "not", "disturb", "silent", "dark", "light",
    "airplane", "hotspot", "brightness", "volume", "workout", "steps", "walk",
    "state", "status", "level", "shortcut", "action", "folder", "file",
    // time words
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "today", "tomorrow", "yesterday", "tonight", "morning", "afternoon",
    "evening", "night", "am", "pm",
    // sentence-openers that are frequently capitalised mid-text
    "if", "when", "then", "otherwise", "and", "or", "the", "a", "an", "get",
    "set", "open", "send", "create", "add", "run", "check", "take", "make",
    "turn", "play", "show", "save", "start", "stop", "every", "each", "my",
  ].map((w) => w.toLowerCase()),
);

/** Verbs / prepositions after which a capitalised token is very likely a person. */
const PERSON_INTRODUCER_WORDS = [
  "to", "for", "from", "with",
  "call", "calls", "called",
  "text", "texts", "texted",
  "message", "messages", "messaged",
  "email", "emails", "emailed",
  "tell", "tells", "told",
  "ask", "asks", "asked",
  "remind", "reminds", "reminded",
  "notify", "notifies", "notified",
];

/**
 * Only the FIRST letter is case-permissive ("Tell" at a sentence start, "tell"
 * mid-sentence).
 *
 * The `i` flag must never be applied to a pattern that also requires a
 * capitalised name: under `i`, both `[A-Z]` and `\p{Lu}` match lowercase, which
 * made "message to" a detected person named "to" while leaving the actual name
 * untouched.
 */
const PERSON_INTRODUCERS = `(?:${PERSON_INTRODUCER_WORDS.map(
  (w) => `[${w[0]!.toUpperCase()}${w[0]}]${w.slice(1)}`,
).join("|")})`;

/**
 * Word edges for names. `\b` is ASCII-only even under the `u` flag, so it cuts
 * "José" down to "Jos" and leaves a recognisable fragment in the output.
 */
const NAME_EDGE_BEFORE = "(?<![\\p{L}'’-])";
const NAME_EDGE_AFTER = "(?![\\p{L}'’-])";

const PATTERNS: PatternSpec[] = [
  // ── Secrets (highest priority) ────────────────────────────────────────────
  {
    cls: "secret",
    // OpenAI / Stripe / generic prefixed keys
    re: /\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{16,}\b/g,
    confidence: "high",
  },
  {
    cls: "secret",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
    confidence: "high",
  },
  {
    cls: "secret",
    re: /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
    confidence: "high",
  },
  {
    cls: "secret",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
    confidence: "high",
  },
  {
    cls: "secret",
    // JWT: three base64url segments
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    confidence: "high",
  },
  {
    cls: "secret",
    re: /\b(?:bearer|token|api[_-]?key|apikey|password|passwd|secret)\s*[:=]\s*\S{8,}/gi,
    confidence: "high",
  },
  {
    cls: "secret",
    // Bare long hex — session ids, raw keys. Medium: could be a hash the user
    // legitimately wants in the shortcut, but we still refuse to archive it.
    re: /\b[a-f0-9]{32,}\b/gi,
    confidence: "medium",
  },
  {
    cls: "credentialed-url",
    re: /https?:\/\/[^\s/@]+:[^\s/@]+@\S+/gi,
    confidence: "high",
  },
  {
    cls: "credentialed-url",
    re: /https?:\/\/\S*?(?:token|api[_-]?key|access[_-]?token|password|secret)=[^\s&]+\S*/gi,
    confidence: "high",
  },

  // ── Direct identifiers ────────────────────────────────────────────────────
  {
    cls: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: "high",
  },
  {
    cls: "payment-card",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    confidence: "high",
    accept: (m) => luhn(m.replace(/\D/g, "")),
  },
  {
    cls: "coordinates",
    re: /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g,
    confidence: "high",
  },
  {
    cls: "ip-address",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: "medium",
    accept: (m) => m.split(".").every((o) => Number(o) <= 255),
  },
  {
    cls: "street-address",
    re: /\b\d{1,5}\s+(?:[A-Z][A-Za-z]*\s+){0,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Close|Crescent|Parade|Square|Sq)\b\.?/g,
    confidence: "medium",
  },
  {
    cls: "phone",
    re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,4}/g,
    confidence: "medium",
    accept: (m) => {
      const digits = m.replace(/\D/g, "");
      // 7–15 digits is the E.164-ish band. Below 7 it is a time, a threshold,
      // or a percentage — all extremely common in shortcut descriptions.
      return digits.length >= 7 && digits.length <= 15;
    },
  },
  {
    cls: "handle",
    re: /(?:^|[\s(])@[A-Za-z0-9_]{2,30}\b/g,
    confidence: "medium",
  },

  // ── Personal context ──────────────────────────────────────────────────────
  {
    cls: "personal-relation",
    re: /\bmy\s+(?:wife|husband|partner|spouse|mum|mom|mother|dad|father|parents|son|daughter|kid|kids|child|children|boss|manager|colleague|girlfriend|boyfriend|brother|sister|neighbour|neighbor|landlord|doctor|dentist|therapist|roommate|flatmate)\b/gi,
    confidence: "high",
  },
  {
    cls: "person-name",
    // "First Last" — two consecutive capitalised tokens.
    re: new RegExp(
      `${NAME_EDGE_BEFORE}\\p{Lu}[\\p{L}'’-]{1,}\\s+\\p{Lu}[\\p{L}'’-]{1,}${NAME_EDGE_AFTER}`,
      "gu",
    ),
    confidence: "medium",
    accept: (m) => m.split(/\s+/).every((w) => !isNonPerson(w)),
  },
  {
    cls: "person-name",
    // A capitalised token in a person-introducing position.
    re: new RegExp(
      `${NAME_EDGE_BEFORE}${PERSON_INTRODUCERS}\\s+(\\p{Lu}[\\p{L}'’-]{1,})${NAME_EDGE_AFTER}`,
      "gu",
    ),
    confidence: "medium",
    accept: (m) => {
      const parts = m.split(/\s+/);
      const name = parts[parts.length - 1] ?? "";
      return !isNonPerson(name);
    },
  },
];

function isNonPerson(word: string): boolean {
  const bare = word.replace(/[^\p{L}]/gu, "").toLowerCase();
  if (bare.length === 0) return true;
  if (NON_PERSON_CAPITALISED.has(bare)) return true;
  // All-caps acronyms (NASA, BBC) are organisations, not people.
  if (word.length > 1 && word === word.toUpperCase()) return true;
  return false;
}

/** Luhn checksum — separates real card numbers from long digit runs. */
function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Returns non-overlapping findings sorted by position.
 *
 * Overlap resolution: higher CLASS_PRIORITY wins; on a tie the longer match
 * wins; on a further tie the earlier match wins. This is what stops a JWT from
 * being reported as three separate "long hex" fragments.
 */
export function detectPii(text: string): PiiFinding[] {
  const raw: PiiFinding[] = [];

  for (const spec of PATTERNS) {
    // Fresh regex per call: /g patterns carry lastIndex between uses.
    const re = new RegExp(spec.re.source, spec.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let matched = m[0];
      let start = m.index;

      // Leading delimiter captured by the handle pattern — trim it back.
      if (spec.cls === "handle" && !matched.startsWith("@")) {
        const at = matched.indexOf("@");
        start += at;
        matched = matched.slice(at);
      }

      if (spec.accept && !spec.accept(matched)) continue;
      if (matched.trim().length === 0) continue;

      raw.push({
        class: spec.cls,
        start,
        end: start + matched.length,
        length: matched.length,
        confidence: spec.confidence,
      });

      if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
    }
  }

  // The introducer pattern matches "to Jane" — narrow it to "Jane".
  const narrowed = raw.map((f) => {
    if (f.class !== "person-name") return f;
    const slice = text.slice(f.start, f.end);
    const match = /\s(\p{Lu}[\p{L}'’-]+)$/u.exec(slice);
    if (!match || !slice.match(new RegExp(`^${PERSON_INTRODUCERS}\\s`, "u"))) return f;
    const nameStart = f.end - match[1]!.length;
    return { ...f, start: nameStart, length: f.end - nameStart };
  });

  return resolveOverlaps(narrowed);
}

function resolveOverlaps(findings: PiiFinding[]): PiiFinding[] {
  const sorted = [...findings].sort((a, b) => {
    const p = CLASS_PRIORITY[b.class] - CLASS_PRIORITY[a.class];
    if (p !== 0) return p;
    if (b.length !== a.length) return b.length - a.length;
    return a.start - b.start;
  });

  const kept: PiiFinding[] = [];
  for (const f of sorted) {
    const clashes = kept.some((k) => f.start < k.end && k.start < f.end);
    if (!clashes) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// ── Redaction ─────────────────────────────────────────────────────────────────

const TOKEN_PREFIX: Record<PiiClass, string> = {
  secret: "SECRET",
  "credentialed-url": "URL",
  email: "EMAIL",
  "payment-card": "CARD",
  coordinates: "COORDS",
  "ip-address": "IP",
  phone: "PHONE",
  "street-address": "ADDRESS",
  handle: "HANDLE",
  "person-name": "PERSON",
  "personal-relation": "RELATION",
};

/**
 * Replaces every detected span with a stable `[[CLASS_n]]` placeholder.
 *
 * The value→placeholder map lives only for the duration of this call. It is not
 * returned, logged, or persisted — re-identification must be impossible from
 * anything this function hands back.
 */
export function redact(text: string): RedactionResult {
  const findings = detectPii(text);

  if (findings.length === 0) {
    return {
      redacted: text,
      findings: [],
      classes: [],
      containsSecret: false,
      clean: true,
    };
  }

  const counters = new Map<PiiClass, number>();
  const assigned = new Map<string, string>(); // discarded on return
  const out: string[] = [];
  let cursor = 0;

  for (const f of findings) {
    out.push(text.slice(cursor, f.start));
    const value = text.slice(f.start, f.end);
    const key = `${f.class}:${value.toLowerCase()}`;
    let token = assigned.get(key);
    if (!token) {
      const n = (counters.get(f.class) ?? 0) + 1;
      counters.set(f.class, n);
      token = `[[${TOKEN_PREFIX[f.class]}_${n}]]`;
      assigned.set(key, token);
    }
    out.push(token);
    cursor = f.end;
  }
  out.push(text.slice(cursor));

  const classes = [...new Set(findings.map((f) => f.class))].sort();

  return {
    redacted: out.join(""),
    findings,
    classes,
    containsSecret: findings.some((f) => SECRET_CLASSES.has(f.class)),
    clean: false,
  };
}

// ── Guards ────────────────────────────────────────────────────────────────────

export class PiiLeakError extends Error {
  readonly classes: PiiClass[];
  constructor(classes: PiiClass[]) {
    super(
      `Refusing to persist text containing unredacted PII: ${classes.join(", ")}`,
    );
    this.name = "PiiLeakError";
    this.classes = classes;
  }
}

/**
 * Last-line guard for the collector. Call immediately before any write.
 *
 * Fails closed: if detection finds anything at all in text that is supposed to
 * be already-redacted, the write is refused rather than sanitised, because a
 * hit here means an earlier stage is broken.
 */
export function assertRedacted(text: string): void {
  const findings = detectPii(text);
  if (findings.length > 0) {
    throw new PiiLeakError([...new Set(findings.map((f) => f.class))].sort());
  }
}

// ── Pseudonymous subject ids ──────────────────────────────────────────────────

/**
 * Stable pseudonym for a subject, salted per deployment.
 *
 * The salt is derived from a deployment secret, so pseudonyms are stable for
 * the life of the deployment — which is what makes withdrawal able to find and
 * delete everything a person contributed — while still being unjoinable across
 * deployments or back to the original identifier.
 */
const STABLE_SUBJECT_KEY =
  process.env.LEARNING_SUBJECT_SALT ?? process.env.SESSION_SECRET ?? null;

/**
 * Whether pseudonyms survive a restart.
 *
 * This matters far more than it looks. A salt regenerated at every boot makes
 * pseudonyms *unstable*: after a restart the same person hashes to a different
 * value, so their consent record is unreachable and — worse — the rows already
 * collected under their old pseudonym can no longer be found by a withdrawal.
 * Data that cannot be deleted on request is data that should never have been
 * collected, so collection is refused outright when this is false.
 */
export const PSEUDONYMS_ARE_DURABLE = STABLE_SUBJECT_KEY !== null;

// Derived rather than used directly, so the pseudonym salt is not the same
// value as the session secret even though it is anchored to it.
const SUBJECT_SALT = STABLE_SUBJECT_KEY
  ? createHmac("sha256", STABLE_SUBJECT_KEY).update("learning:subject-pseudonym:v1").digest("hex")
  : randomBytes(32).toString("hex");

export function pseudonymize(subject: string): string {
  return createHash("sha256")
    .update(SUBJECT_SALT)
    .update(":")
    .update(subject)
    .digest("hex")
    .slice(0, 24);
}
