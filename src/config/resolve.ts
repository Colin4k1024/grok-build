import type { ResolvedSetting, SettingDefinition, SettingLayers, SettingScope } from "./types";

/**
 * Deterministic scope resolution (R4-05 #238): session > project > global
 * > default. A layer that fails validation — or is not an allowed scope for
 * the setting — is skipped and reported in `invalidSources`. Inputs are
 * never mutated.
 */

const RESOLUTION_ORDER: SettingScope[] = ["session", "project", "global"];

export function resolveSetting<T>(
  def: SettingDefinition<T>,
  layers: SettingLayers,
): ResolvedSetting<T> {
  const invalidSources: SettingScope[] = [];

  for (const scope of RESOLUTION_ORDER) {
    const value = layers[scope];
    if (value === undefined || value === null) continue; // absent, not invalid
    if (!def.scopes.includes(scope)) {
      invalidSources.push(scope);
      continue;
    }
    if (!def.validate(value)) {
      invalidSources.push(scope);
      continue;
    }
    return { value, source: scope, invalidSources, overridden: true };
  }

  return { value: def.defaultValue, source: "default", invalidSources, overridden: false };
}
