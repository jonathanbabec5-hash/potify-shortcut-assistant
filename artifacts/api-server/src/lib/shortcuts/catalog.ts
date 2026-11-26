import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";

export type ParameterType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "dictionary"
  | "variable"
  | "content-item"
  | "enumeration";

export type ContentItemClass =
  | "WFContactContentItem"
  | "WFDateContentItem"
  | "WFEmailAddressContentItem"
  | "WFImageContentItem"
  | "WFLocationContentItem"
  | "WFDCMapsLinkContentItem"
  | "WFAVAssetContentItem"
  | "WFURLContentItem"
  | "WFPhoneNumberContentItem"
  | "WFRichTextContentItem"
  | "WFStringContentItem"
  | "WFNumberContentItem"
  | "WFBooleanContentItem";

export interface ActionParameterSpec {
  key: string;
  displayName: string;
  type: ParameterType;
  items?: { type: ParameterType };
  description: string;
  enumeration?: string[];
  default?: unknown;
  acceptsVariables?: boolean;
  producesVariable?: boolean;
  variableName?: string;
  contentItemClass?: ContentItemClass | ContentItemClass[];
}

export interface ActionParametersSpec {
  required: ActionParameterSpec[];
  optional: ActionParameterSpec[];
}

export interface ActionVariableSpec {
  key: string;
  displayName: string;
  type: ParameterType | "magic";
  description: string;
  contentItemClass?: ContentItemClass | ContentItemClass[];
}

export interface ActionAppSpec {
  bundleIdentifier?: string;
  displayName?: string;
  required?: boolean;
  minimumAppVersion?: string;
  note?: string;
}

export interface ActionControlFlowSpec {
  isGroup?: boolean;
  groupType?: "if" | "choose-from-menu" | "repeat" | "otherwise" | "menu-item" | "end";
  beginsGroup?: boolean;
  endsGroup?: boolean;
  requiresMatchingIdentifier?: boolean;
}

export interface DeviceCompatibilitySpec {
  minimumIosVersion?: string;
  maximumIosVersion?: string;
  requiresLocation?: boolean;
  requiresInternet?: boolean;
  requiresCellular?: boolean;
  requiresBluetooth?: boolean;
  requiresNfc?: boolean;
  notes?: string[];
}

export interface ShortcutsActionCatalogEntry {
  identifier: string;
  displayName: string;
  description: string;
  minimumClientVersion: number;
  parameters: ActionParametersSpec;
  permissions: string[];
  knownIssues: string[];
  tags?: string[];
  inputs?: ActionVariableSpec[];
  outputs?: ActionVariableSpec[];
  app?: ActionAppSpec;
  controlFlow?: ActionControlFlowSpec;
  deviceCompatibility?: DeviceCompatibilitySpec;
  deprecated?: boolean;
  deprecationReason?: string;
  alternativeIdentifiers?: string[];
}

export interface ShortcutsActionsCatalog {
  version: string;
  targetIosVersion: string;
  actions: ShortcutsActionCatalogEntry[];
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function loadCatalog(): ShortcutsActionsCatalog {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "shortcuts-catalog-v1.json")]; // production build (copied to dist/)

  const workspaceRoot = findWorkspaceRoot(here);
  if (workspaceRoot) {
    candidates.push(
      join(workspaceRoot, "lib", "api-spec", "shortcuts-catalog-v1.json"), // tests running from src/
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8")) as ShortcutsActionsCatalog;
    }
  }
  throw new Error(
    `Could not find shortcuts-catalog-v1.json. Tried: ${candidates.join(", ")}.`,
  );
}

const rawCatalog: ShortcutsActionsCatalog = loadCatalog();

function enrichAction(action: ShortcutsActionCatalogEntry): ShortcutsActionCatalogEntry {
  const enriched = { ...action };

  if (!enriched.tags) {
    enriched.tags = inferTags(enriched.identifier, enriched.displayName);
  }
  if (!enriched.inputs) {
    enriched.inputs = inferInputs(enriched);
  }
  if (!enriched.outputs) {
    enriched.outputs = inferOutputs(enriched);
  }
  if (!enriched.deviceCompatibility) {
    enriched.deviceCompatibility = inferDeviceCompatibility(enriched);
  }

  return enriched;
}

function inferTags(identifier: string, displayName: string): string[] {
  const tags: string[] = [];
  const text = `${identifier} ${displayName}`.toLowerCase();
  if (text.includes("message") || text.includes("send")) tags.push("communication");
  if (text.includes("location") || text.includes("weather") || text.includes("map")) tags.push("location");
  if (text.includes("photo") || text.includes("image") || text.includes("camera")) tags.push("media");
  if (text.includes("music") || text.includes("audio") || text.includes("sound")) tags.push("media");
  if (text.includes("if") || text.includes("choose") || text.includes("repeat")) tags.push("control-flow");
  if (text.includes("open") || text.includes("launch")) tags.push("app");
  if (text.includes("notification") || text.includes("alert")) tags.push("notification");
  if (text.includes("share") || text.includes("clipboard")) tags.push("sharing");
  if (text.includes("variable")) tags.push("variables");
  if (text.includes("url") || text.includes("web")) tags.push("web");
  return tags;
}

function inferInputs(action: ShortcutsActionCatalogEntry): ActionVariableSpec[] {
  const inputs: ActionVariableSpec[] = [];
  for (const param of action.parameters.required) {
    if (param.type === "variable" || param.acceptsVariables) {
      inputs.push({
        key: param.key,
        displayName: param.displayName,
        type: param.type,
        description: param.description,
        contentItemClass: param.contentItemClass,
      });
    }
  }
  return inputs;
}

function inferOutputs(action: ShortcutsActionCatalogEntry): ActionVariableSpec[] {
  const outputs: ActionVariableSpec[] = [];
  const text = `${action.identifier} ${action.displayName}`.toLowerCase();
  if (text.includes("get current weather")) {
    outputs.push({
      key: "WeatherResult",
      displayName: "Current Weather",
      type: "dictionary",
      description: "Current weather conditions including temperature and condition.",
    });
  } else if (text.includes("get current location")) {
    outputs.push({
      key: "LocationResult",
      displayName: "Current Location",
      type: "dictionary",
      description: "Current location coordinates and address.",
    });
  } else if (text.includes("gettext") || text.includes("text action")) {
    outputs.push({
      key: "TextResult",
      displayName: "Text",
      type: "string",
      description: "The text output.",
    });
  } else if (text.includes("ask") || text.includes("input")) {
    outputs.push({
      key: "InputResult",
      displayName: "Input",
      type: "string",
      description: "The user's input.",
    });
  } else if (text.includes("get device")) {
    outputs.push({
      key: "DeviceDetails",
      displayName: "Device Details",
      type: "dictionary",
      description: "Device details such as name, brightness, volume, or current location.",
    });
  } else if (text.includes("calendar") || text.includes("event")) {
    outputs.push({
      key: "CalendarEvents",
      displayName: "Calendar Events",
      type: "array",
      description: "List of calendar events.",
    });
  } else if (text.includes("reminder") || text.includes("todo")) {
    outputs.push({
      key: "Reminders",
      displayName: "Reminders",
      type: "array",
      description: "List of reminders.",
    });
  } else if (text.includes("contact")) {
    outputs.push({
      key: "Contacts",
      displayName: "Contacts",
      type: "array",
      description: "List of contacts.",
    });
  } else if (text.includes("photo") || text.includes("image") || text.includes("video")) {
    outputs.push({
      key: "Media",
      displayName: "Media",
      type: "array",
      description: "Selected photos or videos.",
    });
  }
  return outputs;
}

function inferDeviceCompatibility(action: ShortcutsActionCatalogEntry): DeviceCompatibilitySpec {
  const spec: DeviceCompatibilitySpec = {};
  const text = `${action.identifier} ${action.displayName}`.toLowerCase();
  if (text.includes("nfc")) spec.requiresNfc = true;
  if (text.includes("cellular") || text.includes("carrier")) spec.requiresCellular = true;
  if (text.includes("bluetooth") || text.includes("airdrop")) spec.requiresBluetooth = true;
  if (text.includes("location") || text.includes("weather") || text.includes("maps")) spec.requiresLocation = true;
  if (text.includes("weather") || text.includes("web") || text.includes("url") || text.includes("maps")) {
    spec.requiresInternet = true;
  }
  if (action.minimumClientVersion >= 2702) {
    spec.minimumIosVersion = "26.0";
  } else if (action.minimumClientVersion >= 1500) {
    spec.minimumIosVersion = "15.0";
  }
  return spec;
}

const controlFlowActions: ShortcutsActionCatalogEntry[] = [
  {
    identifier: "is.workflow.actions.conditional",
    displayName: "If",
    description: "Tests a condition and runs different actions depending on the result.",
    minimumClientVersion: 700,
    parameters: { required: [], optional: [] },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "if", beginsGroup: true, requiresMatchingIdentifier: true },
  },
  {
    identifier: "is.workflow.actions.conditional.end",
    displayName: "End If",
    description: "Ends an If block.",
    minimumClientVersion: 700,
    parameters: { required: [], optional: [] },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "end", endsGroup: true, requiresMatchingIdentifier: true },
  },
  {
    identifier: "is.workflow.actions.choosefrommenu",
    displayName: "Choose from Menu",
    description: "Presents a menu and runs different actions based on the selection.",
    minimumClientVersion: 700,
    parameters: { required: [], optional: [] },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "choose-from-menu", beginsGroup: true, requiresMatchingIdentifier: true },
  },
  {
    identifier: "is.workflow.actions.choosefrommenu.option",
    displayName: "Menu Item",
    description: "A single option in a Choose from Menu action.",
    minimumClientVersion: 700,
    parameters: { required: [], optional: [] },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "menu-item", requiresMatchingIdentifier: true },
  },
  {
    identifier: "is.workflow.actions.repeat.count",
    displayName: "Repeat",
    description: "Repeats a set of actions a specified number of times.",
    minimumClientVersion: 700,
    parameters: {
      required: [{ key: "WFRepeatCount", displayName: "Count", type: "number", description: "Number of times to repeat." }],
      optional: [],
    },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "repeat", beginsGroup: true, requiresMatchingIdentifier: true },
  },
  {
    identifier: "is.workflow.actions.repeat.count.end",
    displayName: "End Repeat",
    description: "Ends a Repeat block.",
    minimumClientVersion: 700,
    parameters: { required: [], optional: [] },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "end", endsGroup: true, requiresMatchingIdentifier: true },
  },
  {
    // Mid-block delimiter between the if-branch and the else-branch.
    // Shares GroupingIdentifier with its parent If and End If — this is correct and intentional.
    // It is NOT a beginsGroup or endsGroup; it is a mid-block marker only.
    identifier: "is.workflow.actions.conditional.otherwise",
    displayName: "Otherwise",
    description: "Marks the beginning of the else-branch inside an If block.",
    minimumClientVersion: 700,
    parameters: { required: [], optional: [] },
    permissions: [],
    knownIssues: [],
    tags: ["control-flow"],
    controlFlow: { isGroup: true, groupType: "otherwise", requiresMatchingIdentifier: true },
  },
];

export const catalog: ShortcutsActionsCatalog = {
  ...rawCatalog,
  version: `${rawCatalog.version}+potify.1`,
  actions: [
    ...rawCatalog.actions.map(enrichAction),
    ...controlFlowActions,
  ],
};

const actionByIdentifier = new Map<string, ShortcutsActionCatalogEntry>();
for (const action of catalog.actions) {
  actionByIdentifier.set(action.identifier, action);
  for (const alt of action.alternativeIdentifiers ?? []) {
    actionByIdentifier.set(alt, action);
  }
}

export function getActionByIdentifier(
  identifier: string,
): ShortcutsActionCatalogEntry | undefined {
  return actionByIdentifier.get(identifier);
}

export function getAllActions(): ShortcutsActionCatalogEntry[] {
  return catalog.actions;
}

export function getCatalogSummary(): ShortcutsActionsCatalog {
  return {
    version: catalog.version,
    targetIosVersion: catalog.targetIosVersion,
    actions: catalog.actions,
  };
}

export interface ShortcutAction {
  WFWorkflowActionIdentifier: string;
  WFWorkflowActionParameters: Record<string, unknown>;
  WFWorkflowActionClass?: string;
  WFWorkflowActionClassArguments?: Record<string, unknown>;
  GroupingIdentifier?: string;
  UUID?: string;
}

export interface ShortcutPlist {
  WFWorkflowClientVersion?: string;
  WFWorkflowClientRelease?: string;
  WFWorkflowMinimumClientVersion?: number;
  WFWorkflowMinimumClientVersionString?: string;
  WFWorkflowName?: string;
  WFWorkflowIcon?: Record<string, unknown>;
  WFWorkflowTypes?: string[];
  WFWorkflowInputContentItemClasses?: string[];
  WFWorkflowImportQuestions?: Record<string, unknown>[];
  WFWorkflowActions: ShortcutAction[];
}

export const DEFAULT_CLIENT_VERSION = "2702";
export const DEFAULT_MIN_CLIENT_VERSION = 2702;

export function ensureActionUuids(actions: ShortcutAction[]): void {
  for (const action of actions) {
    if (!action.UUID) {
      action.UUID = uuidv4().toUpperCase();
    }
  }
}

export function compactCatalogForPrompt(): string {
  const lines = catalog.actions.map((action) => {
    const required = action.parameters.required.map((p) => p.key).join(", ");
    const tags = (action.tags ?? []).join("|");
    return `- ${action.identifier} (${action.displayName}) tags=[${tags}] minClientVersion=${action.minimumClientVersion} required=[${required}]`;
  });
  return lines.join("\n");
}

export function clientVersionToIosString(clientVersion: number): string {
  if (clientVersion >= 2702) return "26.0";
  if (clientVersion >= 1500) return "15.0";
  if (clientVersion >= 1400) return "14.0";
  if (clientVersion >= 1300) return "13.0";
  if (clientVersion >= 700) return "12.0";
  return "12.0";
}

export function iosVersionToClientVersion(iosVersion: string): number {
  const [major, minor] = iosVersion.split(".").map(Number);
  if (major >= 26) return 2702;
  if (major >= 15) return 1500;
  if (major >= 14) return 1400;
  if (major >= 13) return 1300;
  return 700;
}
