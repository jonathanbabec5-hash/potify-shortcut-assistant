/**
 * Deterministic, bounded action-schema retrieval for prompt assembly.
 *
 * ## Why this exists
 *
 * Every prompt built by `buildSystemPrompt` used to embed the entire action
 * catalog — all ~115 entries, ~10k characters, ~2.5k tokens — on every call.
 * Explaining a three-action shortcut shipped the same payload as generating one
 * from scratch. Stage 3 of the pipeline already scoped itself to the schemas
 * Stage 2 retrieved; nothing else did.
 *
 * ## The safety property that must not be lost
 *
 * Scoping the prompt cannot be allowed to weaken the grounding guarantee. It
 * does not, because:
 *
 *   - The full catalog is still fingerprinted at boot via `catalogHash`.
 *   - Selection here is a **pure function of the catalog plus the caller's
 *     inputs**, with no mutable state except a content-addressed render cache.
 *     A scoped section therefore cannot drift unless the catalog drifts, and a
 *     catalog drift already fails `verifyArtifactIntegrity`.
 *   - Validation is unchanged. Stage 4 still grounds every emitted identifier
 *     against the whole catalog, so a narrower prompt can only ever cause a
 *     loud validation failure, never a silent acceptance.
 *
 * ## What this module must never do
 *
 * It never sees an adapter, a request body, or a user identifier. It reads the
 * catalog and the caller's identifier/keyword hints. That is what makes the
 * render cache safe to share across requests: there is nothing per-user in it.
 */

import {
  type ShortcutsActionCatalogEntry,
  getActionByIdentifier,
  getAllActions,
} from "./catalog";

/** Non-floor entries admitted by default. Comfortably above any real workflow. */
const DEFAULT_LIMIT = 48;

/** Cache entries retained. Keys are content-addressed, so collisions are ties. */
const MAX_CACHE_ENTRIES = 64;

export class SchemaRetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaRetrievalError";
  }
}

export interface ScopedSchemas {
  /** Deterministically ordered: control-flow floor first, then by relevance. */
  readonly entries: readonly ShortcutsActionCatalogEntry[];
  readonly identifiers: readonly string[];
  /** Compact prompt block. Empty only if the catalog itself is empty. */
  readonly rendered: string;
  /** Identifiers the caller named that the catalog does not contain. */
  readonly uncatalogued: readonly string[];
  /** Entries always present regardless of the request. */
  readonly floorCount: number;
  /** Entries admitted because the caller named or matched them. */
  readonly relevantCount: number;
}

export interface RetrievalRequest {
  /** Identifiers known to be needed — from a plist, a plan, or Stage 2. */
  identifiers?: Iterable<string>;
  /** Free text ranked against the catalog when identifiers are sparse. */
  keywords?: string;
  /** Cap on non-floor entries. The floor is always added on top. */
  limit?: number;
  /**
   * Whether the caller cannot function without at least one domain (non
   * control-flow) action.
   *
   * Generation needs one: a prompt offering only If/Repeat/End gives the model
   * nothing to build with, and it would invent identifiers that Stage 4 then
   * rejects — a confusing failure far from its cause. Setting this true turns
   * that into an immediate, named error.
   *
   * Explain and repair set it false on purpose. They operate on a plist the
   * caller supplied, which may legitimately consist entirely of third-party
   * actions absent from the catalog. Those arrive as `uncatalogued` and are
   * declared to the model as such, which is strictly more information than the
   * old full-catalog prompt gave it.
   */
  requireDomainActions?: boolean;
}

// ── Control-flow floor ────────────────────────────────────────────────────────

let cachedFloor: readonly ShortcutsActionCatalogEntry[] | null = null;

/**
 * Actions that must appear in every prompt.
 *
 * Control flow is structural: the model has to know how If/Otherwise/End and
 * Repeat group and share a GroupingIdentifier even when the request never
 * mentions a condition, because it may still decide one is required. Omitting
 * these to save tokens is how you get an unbalanced group that fails Stage 6.
 *
 * Derived from the catalog rather than hardcoded, so a control-flow action added
 * to the catalog later is included automatically instead of being quietly
 * dropped from every prompt.
 */
export function controlFlowFloor(): readonly ShortcutsActionCatalogEntry[] {
  if (cachedFloor) return cachedFloor;
  const floor = getAllActions()
    .filter((a) => a.controlFlow !== undefined)
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
  cachedFloor = Object.freeze(floor);
  return cachedFloor;
}

// ── Keyword ranking ───────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Relevance score for one action against a token set.
 *
 * Weights favour the fields that actually identify an action's purpose. Ties are
 * broken by identifier at the call site so the output order is total — a stable
 * order matters because the render cache is keyed on it.
 */
function scoreAction(entry: ShortcutsActionCatalogEntry, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;

  const tags = (entry.tags ?? []).map((t) => t.toLowerCase());
  const nameTokens = tokenize(entry.displayName);
  const idTokens = tokenize(entry.identifier);
  const descTokens = new Set(tokenize(entry.description ?? ""));

  let score = 0;
  for (const token of tokens) {
    if (tags.some((tag) => tag === token || tag.includes(token))) score += 3;
    if (nameTokens.includes(token)) score += 2;
    if (idTokens.includes(token)) score += 2;
    if (descTokens.has(token)) score += 1;
  }
  return score;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * One line per action, matching the shape the model has always been shown.
 *
 * Keeping the line format identical to the old full-catalog block means the
 * only change the model sees is *which* actions are listed, not how they are
 * described. That keeps this a scoping change rather than a prompt rewrite.
 */
function renderEntries(entries: readonly ShortcutsActionCatalogEntry[]): string {
  return entries
    .map((action) => {
      const required = action.parameters.required.map((p) => p.key).join(", ");
      const tags = (action.tags ?? []).join("|");
      return `- ${action.identifier} (${action.displayName}) tags=[${tags}] minClientVersion=${action.minimumClientVersion} required=[${required}]`;
    })
    .join("\n");
}

/**
 * Content-addressed render cache.
 *
 * Keyed on the resolved identifier list, which is derived purely from the
 * immutable catalog. There is no request data in the key and none in the value,
 * so a cache hit cannot carry one request's content into another's prompt.
 * Adapters never reach this module at all — see `adapter.ts`.
 */
const renderCache = new Map<string, string>();

function renderCached(entries: readonly ShortcutsActionCatalogEntry[]): string {
  const key = entries.map((e) => e.identifier).join("\u0000");
  const hit = renderCache.get(key);
  if (hit !== undefined) return hit;

  const rendered = renderEntries(entries);
  // Bounded, insertion-ordered eviction. Prompt scopes repeat heavily in
  // practice (most shortcuts use the same two dozen actions), so a small cache
  // captures nearly all of the benefit without growing without limit.
  if (renderCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next();
    if (!oldest.done) renderCache.delete(oldest.value);
  }
  renderCache.set(key, rendered);
  return rendered;
}

/** Test seam. Never called by request paths. */
export function resetSchemaRetrievalCache(): void {
  renderCache.clear();
  cachedFloor = null;
}

// ── Selection ─────────────────────────────────────────────────────────────────

/**
 * Selects the action schemas a prompt should carry.
 *
 * Deterministic: the same request yields byte-identical output, which is what
 * lets the result be cached and lets a benchmark attribute a measured
 * difference to the adapter rather than to prompt jitter.
 */
export function selectActionSchemas(request: RetrievalRequest = {}): ScopedSchemas {
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SchemaRetrievalError(`limit must be a positive integer, got ${limit}.`);
  }

  const floor = controlFlowFloor();
  const floorIds = new Set(floor.map((e) => e.identifier));

  const picked = new Map<string, ShortcutsActionCatalogEntry>();
  const uncatalogued: string[] = [];

  // 1 ── Named identifiers. These are facts, not guesses: the caller has a
  //      plist or a plan that references them, so they are admitted before any
  //      ranked candidate and are never displaced by the limit.
  const seenNamed = new Set<string>();
  for (const raw of request.identifiers ?? []) {
    const identifier = typeof raw === "string" ? raw.trim() : "";
    if (identifier.length === 0 || seenNamed.has(identifier)) continue;
    seenNamed.add(identifier);

    if (floorIds.has(identifier)) continue; // already in the floor
    const entry = getActionByIdentifier(identifier);
    if (entry) picked.set(identifier, entry);
    else uncatalogued.push(identifier);
  }

  // 2 ── Ranked candidates fill the remaining budget. This is what keeps the
  //      scoped prompt from being narrower than the caller's intent: a plan that
  //      named three actions still gets the neighbourhood of the request.
  const tokens = tokenize(request.keywords ?? "");
  if (tokens.length > 0 && picked.size < limit) {
    const ranked = getAllActions()
      .filter((a) => !floorIds.has(a.identifier) && !picked.has(a.identifier))
      .map((a) => ({ entry: a, score: scoreAction(a, tokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.identifier.localeCompare(b.entry.identifier));

    for (const { entry } of ranked) {
      if (picked.size >= limit) break;
      picked.set(entry.identifier, entry);
    }
  }

  const relevant = [...picked.values()].sort((a, b) =>
    a.identifier.localeCompare(b.identifier),
  );
  const entries = [...floor, ...relevant];

  // A catalog that yields nothing is a broken build, not a narrow request.
  if (entries.length === 0) {
    throw new SchemaRetrievalError(
      "Schema retrieval produced no actions at all — the action catalog is empty or failed to load. " +
        "Refusing to build a prompt with no grounding.",
    );
  }

  if (request.requireDomainActions && relevant.length === 0) {
    throw new SchemaRetrievalError(
      "Schema retrieval found no domain actions for this request " +
        `(named: ${seenNamed.size}, uncatalogued: ${uncatalogued.length}, keywords: ${tokens.length}). ` +
        "A prompt carrying only control-flow actions would force the model to invent identifiers. " +
        "Failing here instead of degrading to a weaker prompt.",
    );
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    identifiers: Object.freeze(entries.map((e) => e.identifier)),
    rendered: renderCached(entries),
    uncatalogued: Object.freeze(uncatalogued.sort()),
    floorCount: floor.length,
    relevantCount: relevant.length,
  });
}

/** Identifiers referenced by a plist, in first-seen order. */
export function identifiersInActions(
  actions: ReadonlyArray<{ WFWorkflowActionIdentifier: string }>,
): string[] {
  const seen = new Set<string>();
  for (const action of actions ?? []) {
    const id = action?.WFWorkflowActionIdentifier;
    if (typeof id === "string" && id.length > 0) seen.add(id);
  }
  return [...seen];
}
