import type { ResolvedSetting, SettingDefinition, SettingLayers, SettingScope } from "./types";

/**
 * Deterministic scope resolution (R4-05 #238): session > project > global
 * > default. A layer that fails validation — or is not an allowed scope for
 * the setting — is skipped and reported in `invalidSources`. Invalid LOWER
 * layers are still reported after a higher layer wins (so users see every
 * broken override, not just the top one). An explicit null is a corrupted
 * value (invalid), not absence. Inputs are never mutated.
 */

const RESOLUTION_ORDER: SettingScope[] = ["session", "project", "global"];

export function resolveSetting<T>(
  def: SettingDefinition<T>,
  layers: SettingLayers,
): ResolvedSetting<T> {
  const invalidSources: SettingScope[] = [];
  let winner: { value: T; source: SettingScope } | null = null;

  for (const scope of RESOLUTION_ORDER) {
    const value = layers[scope];
    if (value === undefined) continue; // absent
    if (!def.scopes.includes(scope) || value === null || !def.validate(value)) {
      invalidSources.push(scope);
      continue;
    }
    if (!winner) winner = { value, source: scope };
  }

  if (winner) {
    return { value: winner.value, source: winner.source, invalidSources, overridden: true };
  }
  return { value: def.defaultValue, source: "default", invalidSources, overridden: false };
}
