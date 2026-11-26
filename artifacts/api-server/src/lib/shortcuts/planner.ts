import { v4 as uuidv4 } from "uuid";
import {
  type ShortcutsActionCatalogEntry,
  type ShortcutPlist,
  type ShortcutAction,
  getActionByIdentifier,
  getAllActions,
  clientVersionToIosString,
  ensureActionUuids,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_MIN_CLIENT_VERSION,
} from "./catalog";

export interface Slot {
  key: string;
  displayName: string;
  description: string;
  type: "contact" | "text" | "number" | "boolean" | "choice" | "location" | "app" | "time" | "date" | "unknown";
  enumeration?: string[];
  required: boolean;
  source: "input" | "target" | "permission" | "device";
}

export interface PlanStep {
  stepIndex: number;
  actionIdentifier: string;
  displayName: string;
  intent: string;
  parameterBindings: Array<{
    key: string;
    value: unknown | null;
    source: "literal" | "slot" | "previous-step" | "user-choice" | "unset";
    sourceKey?: string;
  }>;
  produces?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  requiredSlots: Slot[];
  requiredPermissions: string[];
  minimumIosVersion: string;
  confidence: "high" | "medium" | "low";
  uncertainty: string[];
  alternatives: Array<{ label: string; plan: PlanStep[] }>;
}

export interface ClarificationRequest {
  needed: boolean;
  questions: Array<{
    slotKey: string;
    displayName: string;
    description: string;
    type: Slot["type"];
    enumeration?: string[];
  }>;
  partialPlan?: Plan;
}

// ── Intent detection ──────────────────────────────────────────────────────────
//
// Every pattern MUST match on whole-word boundaries. Bare substring alternation
// silently matched letters inside unrelated words: "if" appears inside
// "not-if-ication", "w-if-i", "ver-if-y" and "Spot-if-y", so any of those
// fabricated a "conditional" intent and, downstream, an If block the user never
// asked for. The same class of bug made "h-app-en" an app launch and
// "re-call"/"lo-call-y" a phone call.
//
// wordPattern() anchors each stem with \b on both sides, allowing only a short
// list of inflectional suffixes before the closing boundary so that plurals and
// participles ("messages", "opening", "reminders") still match.

const INFLECTIONS = "(?:s|es|ing|ed|d|er|ers)?";

function wordPattern(...stems: string[]): RegExp {
  return new RegExp(`\\b(?:${stems.join("|")})${INFLECTIONS}\\b`, "i");
}

const knownIntents = [
  { pattern: wordPattern("weather", "temperature", "forecast", "rain", "rainy"), tag: "weather" },
  { pattern: wordPattern("text", "message", "sms", "imessage"), tag: "message" },
  { pattern: wordPattern("email", "mail"), tag: "email" },
  // "phone" on its own is a device noun far more often than a verb ("my phone
  // battery", "on my phone"), and treating it as a call request appended Call
  // actions to shortcuts that only mentioned the device. Require the verb
  // "call" or the explicit noun phrase "phone call".
  { pattern: /\bcall(?:s|ing|ed|er|ers)?\b|\bphone\s+calls?\b/i, tag: "call" },
  { pattern: wordPattern("location", "gps", "where", "map", "direction"), tag: "location" },
  { pattern: wordPattern("photo", "picture", "camera", "image", "screenshot"), tag: "photo" },
  { pattern: wordPattern("music", "song", "playlist", "audio", "podcast"), tag: "music" },
  { pattern: wordPattern("calendar", "event", "schedule", "remind", "reminder", "todo"), tag: "calendar" },
  { pattern: wordPattern("clipboard", "copy", "copies", "copied", "paste"), tag: "clipboard" },
  { pattern: wordPattern("notification", "alert", "banner"), tag: "notification" },
  { pattern: wordPattern("open", "launch", "app", "application"), tag: "open-app" },
  { pattern: wordPattern("share", "post", "tweet", "social"), tag: "share" },
  { pattern: wordPattern("if", "when", "whenever", "unless", "condition", "conditional"), tag: "conditional" },
  // "every" and "each" are usually scheduling words ("every morning at 7 am"),
  // which describe a trigger rather than a loop. Only treat them as a repeat
  // when they quantify a collection of items.
  {
    pattern:
      /\brepeat(?:s|ing|ed)?\b|\bloop(?:s|ing|ed)?\b|\bfor\s+each\b|\b(?:each|every)\s+(?:item|one|photo|picture|file|contact|event|message|row|line)s?\b|\b\d+\s+times?\b/i,
    tag: "repeat",
  },
];

export function detectIntents(description: string): string[] {
  const tags = new Set<string>();
  for (const { pattern, tag } of knownIntents) {
    if (pattern.test(description)) tags.add(tag);
  }
  return Array.from(tags);
}

/**
 * Reads a user-supplied slot value.
 *
 * Returns undefined for missing, null, or blank values so callers can always
 * distinguish "the user told us this" from "we do not know". Nothing in the
 * planner may substitute a literal for an unknown value — an unresolved slot is
 * reported to the user instead.
 */
function readSlot(slots: Record<string, unknown>, key: string): string | undefined {
  const raw = slots[key];
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? raw.trim() : String(raw);
  return value.length > 0 ? value : undefined;
}

/**
 * Builds a parameter binding that is honest about provenance: "slot" when the
 * user supplied the value, "unset" (with a null value) when they did not.
 * planToShortcut omits unset bindings rather than writing a placeholder.
 */
function slotBinding(
  key: string,
  sourceKey: string,
  value: unknown | undefined,
): PlanStep["parameterBindings"][number] {
  return value === undefined
    ? { key, value: null, source: "unset", sourceKey }
    : { key, value, source: "slot", sourceKey };
}

/**
 * Relationship references that are NOT usable as a contact.
 *
 * iOS needs an actual contact, so binding the bare word produced a message
 * addressed to someone literally named "wife". These must be asked about.
 */
const VAGUE_PERSON =
  /\b(?:wife|husband|partner|spouse|girlfriend|boyfriend|mom|mum|mother|dad|father|parents?|kids?|son|daughter|brother|sister|boss|manager|team|friend|roommate|neighbou?r|doctor|landlord|everyone|someone)\b/i;

const RECIPIENT_KEYWORDS = String.raw`(?:to|text|texting|message|messaging|call|calling|email|emailing)`;

/**
 * Pulls a usable contact reference out of the description.
 *
 * Returns undefined when the description only refers to a relationship
 * ("my wife") rather than naming someone, so the caller asks instead of
 * inventing a recipient. Both the planner and the clarification builder call
 * this, which is what keeps the question list and the unresolved-slot list in
 * agreement — they previously disagreed, so the user was never asked for a
 * recipient the plan still needed.
 */
export function extractRecipient(description: string): string | undefined {
  const quoted = description.match(
    new RegExp(String.raw`\b${RECIPIENT_KEYWORDS}\s+["“']([^"”']{2,})["”']`, "i"),
  );
  if (quoted) return quoted[1].trim();

  // An email address is unambiguous.
  const email = description.match(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/);
  if (email) return email[0];

  // Walk every recipient keyword and take the first followed by a capitalised
  // name. Each keyword is checked independently: in "send a message to Jane"
  // the word "message" is followed by "to" (not a name), and the answer comes
  // from the later "to Jane". The name must be capitalised, which is why
  // "to my wife" yields nothing.
  const keywords = new RegExp(String.raw`\b${RECIPIENT_KEYWORDS}\b`, "gi");
  for (const match of description.matchAll(keywords)) {
    const rest = description.slice((match.index ?? 0) + match[0].length);
    // Unicode-aware: an ASCII `[A-Z][\w-]*` truncated "José" to "Jos", which
    // would silently address a contact who does not exist. Capitalisation is
    // still required — guessing that a lowercase word is a name is how invented
    // recipients get in, and asking is always the safe outcome.
    const named = rest.match(
      /^\s+(\p{Lu}[\p{L}\p{M}\p{Nd}'’-]*(?:\s+\p{Lu}[\p{L}\p{M}\p{Nd}'’-]*)?)/u,
    );
    if (!named) continue;

    const candidate = named[1].trim();
    if (VAGUE_PERSON.test(candidate)) continue;
    return candidate;
  }

  return undefined;
}

/** Pulls the text the user asked to be shown/sent, e.g. `saying hello`. */
function extractQuotedText(description: string): string | undefined {
  const quoted = description.match(/["“']([^"”']{2,})["”']/);
  if (quoted) return quoted[1].trim();
  const saying = description.match(/\b(?:saying|that says|says|with the text|message:)\s+(.+)$/i);
  if (saying) return saying[1].trim().replace(/[.]$/, "");
  return undefined;
}

export function buildClarificationRequest(
  description: string,
  targetIosVersion?: string,
): ClarificationRequest {
  const intents = detectIntents(description);
  const questions: ClarificationRequest["questions"] = [];

  // Ask exactly when the planner cannot resolve the recipient. The old test
  // exempted "my wife" and any "to <word>", so the question was skipped while
  // the plan still needed it — the user was never given a chance to answer.
  if (intents.includes("message") && extractRecipient(description) === undefined) {
    questions.push({
      slotKey: "recipient",
      displayName: "Recipient",
      description: "Who should receive the message?",
      type: "contact",
    });
  }
  if (intents.includes("message") && !/(saying|that says|with the text|message:)/i.test(description)) {
    questions.push({
      slotKey: "messageBody",
      displayName: "Message body",
      description: "What should the message say?",
      type: "text",
    });
  }
  if (intents.includes("email") && extractRecipient(description) === undefined) {
    questions.push({
      slotKey: "emailRecipient",
      displayName: "Email recipient",
      description: "Who should receive the email?",
      type: "contact",
    });
  }
  if (intents.includes("conditional") && !/(battery|location|time|connected|wifi|bluetooth|headphones)/i.test(description)) {
    questions.push({
      slotKey: "condition",
      displayName: "Condition",
      description:
        "What condition should be checked? Pick a common one or describe your own.",
      type: "choice",
      // These are suggestions, not defaults. Nothing downstream may select one
      // on the user's behalf: an unanswered condition stays unresolved. The
      // previous list led with "battery below 20%", which both biased the
      // answer and matched the literal the planner used to invent.
      enumeration: [
        "WiFi connected",
        "Bluetooth connected",
        "headphones connected",
        "battery below 20%",
        "current time is before 9am",
        "current time is after 10pm",
      ],
    });
  }
  if (intents.includes("notification") && extractQuotedText(description) === undefined) {
    questions.push({
      slotKey: "notificationText",
      displayName: "Notification text",
      description: "What should the notification say?",
      type: "text",
    });
  }
  if (intents.includes("repeat") && !/\d+ (time|times)/i.test(description)) {
    questions.push({
      slotKey: "repeatCount",
      displayName: "Repeat count",
      description: "How many times should the loop run?",
      type: "number",
    });
  }
  if (intents.includes("open-app") && !/(open|launch) \w+/i.test(description)) {
    questions.push({
      slotKey: "targetApp",
      displayName: "Target app",
      description: "Which app should be opened?",
      type: "app",
    });
  }

  if (questions.length === 0) {
    return { needed: false, questions: [] };
  }

  return { needed: true, questions };
}

export function buildPlan(
  description: string,
  slots: Record<string, unknown> = {},
  targetIosVersion?: string,
): Plan {
  const intents = detectIntents(description);
  const steps: PlanStep[] = [];
  const requiredSlots: Slot[] = [];
  const requiredPermissions = new Set<string>();
  const unknownIdentifiers: string[] = [];
  let minClientVersion = DEFAULT_MIN_CLIENT_VERSION;

  function addStep(identifier: string, parameterBindings: PlanStep["parameterBindings"] = [], produces?: string) {
    const action = getActionByIdentifier(identifier);
    if (!action) {
      // A hardcoded identifier that is not in the catalog produces no step at
      // all. This used to fail silently, so a described notification / location
      // / clipboard step simply vanished from the plan. Record it instead.
      unknownIdentifiers.push(identifier);
      return;
    }
    steps.push({
      stepIndex: steps.length,
      actionIdentifier: identifier,
      displayName: action.displayName,
      intent: action.description,
      parameterBindings,
      produces,
    });
    minClientVersion = Math.max(minClientVersion, action.minimumClientVersion);
    for (const permission of action.permissions) requiredPermissions.add(permission);
  }

  if (intents.includes("weather")) {
    addStep("is.workflow.actions.getcurrentweather", [], "WeatherResult");
  }
  if (intents.includes("location")) {
    addStep("is.workflow.actions.getlocation", [], "LocationResult");
  }
  if (intents.includes("photo")) {
    addStep("is.workflow.actions.selectphoto", [], "Photos");
  }
  if (intents.includes("calendar")) {
    addStep("is.workflow.actions.getupcomingevents", [], "Events");
  }
  if (intents.includes("clipboard")) {
    addStep("is.workflow.actions.getclipboards", [], "Clipboard");
  }
  if (intents.includes("device")) {
    addStep("is.workflow.actions.getdevicedetails", [], "DeviceDetails");
  }

  if (intents.includes("message")) {
    const recipient = readSlot(slots, "recipient") ?? extractRecipient(description);
    const body = readSlot(slots, "messageBody") ?? extractQuotedText(description);
    addStep(
      "is.workflow.actions.sendmessage",
      [
        slotBinding(
          "WFSendMessageActionRecipients",
          "recipient",
          recipient === undefined ? undefined : [recipient],
        ),
        slotBinding("WFSendMessageActionBody", "messageBody", body),
      ],
      "SentMessage",
    );
    if (recipient === undefined) {
      requiredSlots.push({
        key: "recipient",
        displayName: "Recipient",
        description: "Who should receive the message?",
        type: "contact",
        required: true,
        source: "input",
      });
    }
    if (body === undefined) {
      requiredSlots.push({
        key: "messageBody",
        displayName: "Message body",
        description: "What should the message say?",
        type: "text",
        required: true,
        source: "input",
      });
    }
  }

  if (intents.includes("email")) {
    const recipient = readSlot(slots, "emailRecipient") ?? extractRecipient(description);
    addStep(
      "is.workflow.actions.sendemail",
      [
        slotBinding(
          "WFSendEmailActionToRecipients",
          "emailRecipient",
          recipient === undefined ? undefined : [recipient],
        ),
      ],
      "SentEmail",
    );
    if (recipient === undefined) {
      requiredSlots.push({
        key: "emailRecipient",
        displayName: "Email recipient",
        description: "Who should receive the email?",
        type: "contact",
        required: true,
        source: "input",
      });
    }
  }

  if (intents.includes("notification")) {
    // Use the text the user actually asked to show. Never fall back to the
    // literal "Notification" — a banner reading "Notification" is not what
    // anyone described.
    const text = readSlot(slots, "notificationText") ?? extractQuotedText(description);
    addStep("is.workflow.actions.notification", [
      slotBinding("WFNotificationActionTitle", "notificationText", text),
    ]);
    if (text === undefined) {
      requiredSlots.push({
        key: "notificationText",
        displayName: "Notification text",
        description: "What should the notification say?",
        type: "text",
        required: true,
        source: "input",
      });
    }
  }

  if (intents.includes("open-app")) {
    const app = readSlot(slots, "targetApp");
    addStep(
      "is.workflow.actions.openapp",
      [slotBinding("WFAppIdentifier", "targetApp", app)],
    );
    if (app === undefined) {
      requiredSlots.push({
        key: "targetApp",
        displayName: "Target app",
        description: "Which app should be opened?",
        type: "app",
        required: true,
        source: "target",
      });
    }
  }

  if (intents.includes("conditional")) {
    // There is deliberately no fallback here. Substituting a literal (this used
    // to be "battery below 20%") produced shortcuts that checked something the
    // user never mentioned. An unanswered condition stays unresolved and is
    // reported through requiredSlots and uncertainty instead.
    const condition = readSlot(slots, "condition");
    steps.push({
      stepIndex: steps.length,
      actionIdentifier: "is.workflow.actions.conditional",
      displayName: "If",
      intent:
        condition === undefined
          ? "Only run if a condition you choose — needs your input"
          : `Only run if ${condition}`,
      parameterBindings: [slotBinding("WFCondition", "condition", condition)],
    });
    if (condition === undefined) {
      requiredSlots.push({
        key: "condition",
        displayName: "Condition",
        description: "What condition should be checked?",
        type: "choice",
        required: true,
        source: "input",
      });
    }
  }

  if (intents.includes("repeat")) {
    // Same rule as the condition above: no invented iteration count. This used
    // to default to 3, producing a loop the user never asked for.
    const rawCount = readSlot(slots, "repeatCount");
    const parsed = rawCount === undefined ? Number.NaN : Number(rawCount);
    const count = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    steps.push({
      stepIndex: steps.length,
      actionIdentifier: "is.workflow.actions.repeat.count",
      displayName: "Repeat",
      intent:
        count === undefined
          ? "Repeat a number of times you choose — needs your input"
          : `Repeat ${count} times`,
      parameterBindings: [slotBinding("WFRepeatCount", "repeatCount", count)],
    });
    if (count === undefined) {
      requiredSlots.push({
        key: "repeatCount",
        displayName: "Repeat count",
        description: "How many times should the loop run?",
        type: "number",
        required: true,
        source: "input",
      });
    }
  }

  if (steps.length === 0) {
    return {
      goal: description,
      steps: [],
      requiredSlots: [],
      requiredPermissions: [],
      minimumIosVersion: targetIosVersion || "26.0",
      confidence: "low",
      uncertainty: ["Could not confidently determine intent from description."],
      alternatives: [
        { label: "Try a more specific description", plan: [] },
      ],
    };
  }

  const alternatives: Plan["alternatives"] = [];
  if (intents.includes("message")) {
    const body = readSlot(slots, "messageBody") ?? extractQuotedText(description);
    alternatives.push({
      label: "Show a notification instead of sending",
      plan: steps.filter((s) => s.actionIdentifier !== "is.workflow.actions.sendmessage").concat({
        stepIndex: 0,
        actionIdentifier: "is.workflow.actions.notification",
        displayName: "Show Notification",
        intent: "Show a notification instead",
        parameterBindings: [slotBinding("WFNotificationActionTitle", "messageBody", body)],
      }),
    });
  }

  return {
    goal: description,
    steps,
    requiredSlots,
    requiredPermissions: Array.from(requiredPermissions),
    minimumIosVersion: clientVersionToIosString(minClientVersion),
    confidence: requiredSlots.length === 0 ? "high" : "medium",
    // Name each unresolved detail. The plan deliberately contains no invented
    // values, so the user needs to know exactly what is still missing.
    uncertainty: [
      ...requiredSlots.map(
        (slot) => `${slot.displayName} is not set yet — ${slot.description}`,
      ),
      ...unknownIdentifiers.map(
        (id) =>
          `No catalog action is available for "${id}", so that part of your description was not built.`,
      ),
    ],
    alternatives,
  };
}

export function planToShortcut(
  plan: Plan,
  slots: Record<string, unknown> = {},
  targetIosVersion?: string,
): ShortcutPlist {
  const actions: ShortcutAction[] = [];
  const groupStack: string[] = [];

  for (const step of plan.steps) {
    const action = getActionByIdentifier(step.actionIdentifier);
    if (!action) continue;

    const parameters: Record<string, unknown> = {};
    for (const binding of step.parameterBindings) {
      if (binding.value !== null && binding.value !== undefined) {
        parameters[binding.key] = binding.value;
      } else if (binding.source === "slot" && binding.sourceKey && slots[binding.sourceKey] !== undefined) {
        parameters[binding.key] = slots[binding.sourceKey];
      }
    }

    const shortcutAction: ShortcutAction = {
      WFWorkflowActionIdentifier: step.actionIdentifier,
      WFWorkflowActionParameters: parameters,
    };

    if (action.controlFlow?.isGroup) {
      if (action.controlFlow.beginsGroup) {
        const groupId = uuidv4().toUpperCase();
        groupStack.push(groupId);
        shortcutAction.GroupingIdentifier = groupId;
      } else if (action.controlFlow.endsGroup && groupStack.length > 0) {
        shortcutAction.GroupingIdentifier = groupStack.pop();
      } else if (action.controlFlow.requiresMatchingIdentifier && groupStack.length > 0) {
        shortcutAction.GroupingIdentifier = groupStack[groupStack.length - 1];
      }
    }

    actions.push(shortcutAction);
  }

  ensureActionUuids(actions);

  return {
    WFWorkflowClientVersion: DEFAULT_CLIENT_VERSION,
    WFWorkflowMinimumClientVersion: targetIosVersion
      ? iosVersionToClientVersion(targetIosVersion)
      : DEFAULT_MIN_CLIENT_VERSION,
    WFWorkflowName: plan.goal.slice(0, 60) || "POTIFY Shortcut",
    WFWorkflowActions: actions,
  };
}

function iosVersionToClientVersion(iosVersion: string): number {
  const [major] = iosVersion.split(".").map(Number);
  if (major >= 26) return 2702;
  if (major >= 15) return 1500;
  if (major >= 14) return 1400;
  if (major >= 13) return 1300;
  return 700;
}

export function findActionsByTag(tag: string): ShortcutsActionCatalogEntry[] {
  return getAllActions().filter((a) => (a.tags ?? []).includes(tag));
}
