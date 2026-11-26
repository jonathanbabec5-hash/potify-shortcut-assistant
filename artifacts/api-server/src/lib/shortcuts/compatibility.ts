import {
  type ShortcutAction,
  type ShortcutPlist,
  type ShortcutsActionCatalogEntry,
  getActionByIdentifier,
  clientVersionToIosString,
} from "./catalog";

export interface DeviceCompatibilityResult {
  minimumIosVersion: string;
  requiredDeviceFeatures: string[];
  requiredPermissions: string[];
  requiredApps: Array<{ displayName?: string; bundleIdentifier?: string; note?: string }>;
  warnings: Array<{ actionIndex: number; message: string; suggestion?: string }>;
  deprecatedActions: Array<{ actionIndex: number; identifier: string; reason?: string }>;
}

export function analyzeCompatibility(
  shortcut: ShortcutPlist,
  targetIosVersion?: string,
): DeviceCompatibilityResult {
  const actions = shortcut.WFWorkflowActions ?? [];
  let minimumClientVersion = 700;
  const requiredDeviceFeatures = new Set<string>();
  const requiredPermissions = new Set<string>();
  const requiredApps = new Set<string>();
  const warnings: DeviceCompatibilityResult["warnings"] = [];
  const deprecatedActions: DeviceCompatibilityResult["deprecatedActions"] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const entry = getActionByIdentifier(action.WFWorkflowActionIdentifier);
    if (!entry) continue;

    minimumClientVersion = Math.max(minimumClientVersion, entry.minimumClientVersion);

    for (const permission of entry.permissions) {
      requiredPermissions.add(permission);
    }

    if (entry.app) {
      requiredApps.add(JSON.stringify({ displayName: entry.app.displayName, bundleIdentifier: entry.app.bundleIdentifier, note: entry.app.note }));
    }

    if (entry.deprecated) {
      deprecatedActions.push({ actionIndex: i, identifier: entry.identifier, reason: entry.deprecationReason });
    }

    const device = entry.deviceCompatibility;
    if (device?.requiresLocation) requiredDeviceFeatures.add("Location Services");
    if (device?.requiresInternet) requiredDeviceFeatures.add("Internet");
    if (device?.requiresCellular) requiredDeviceFeatures.add("Cellular");
    if (device?.requiresBluetooth) requiredDeviceFeatures.add("Bluetooth");
    if (device?.requiresNfc) requiredDeviceFeatures.add("NFC");

    if (device?.minimumIosVersion && targetIosVersion) {
      const targetParts = targetIosVersion.split(".").map(Number);
      const deviceParts = device.minimumIosVersion.split(".").map(Number);
      const targetMajor = targetParts[0] ?? 0;
      const deviceMajor = deviceParts[0] ?? 0;
      if (deviceMajor > targetMajor) {
        warnings.push({
          actionIndex: i,
          message: `"${entry.displayName}" requires iOS ${device.minimumIosVersion}, but the target is ${targetIosVersion}.`,
          suggestion: "Remove this action or raise the target iOS version.",
        });
      }
    }

    if (device?.notes) {
      for (const note of device.notes) {
        warnings.push({ actionIndex: i, message: note });
      }
    }
  }

  if (targetIosVersion) {
    const minimumIos = clientVersionToIosString(minimumClientVersion);
    const targetMajor = Number(targetIosVersion.split(".")[0]);
    const minimumMajor = Number(minimumIos.split(".")[0]);
    if (minimumMajor > targetMajor) {
      warnings.push({
        actionIndex: -1,
        message: `Shortcut requires iOS ${minimumIos} or later, but the target version is ${targetIosVersion}.`,
        suggestion: "Remove newer actions or increase the target iOS version.",
      });
    }
  }

  return {
    minimumIosVersion: clientVersionToIosString(minimumClientVersion),
    requiredDeviceFeatures: Array.from(requiredDeviceFeatures),
    requiredPermissions: Array.from(requiredPermissions),
    requiredApps: Array.from(requiredApps).map((s) => JSON.parse(s)),
    warnings,
    deprecatedActions,
  };
}

export function formatDeviceFeatures(features: string[]): string {
  if (features.length === 0) return "No special device features required.";
  return `Requires: ${features.join(", ")}.`;
}
