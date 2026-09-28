import { listSettings, getSetting } from "./registry";

/**
 * The shared persisted-state sanitizer (R4-05/R4-06): used by BOTH the
 * zustand persist merge (every rehydrate) and the v1→v2 migration step, so
 * there is exactly one implementation of "invalid values fall back to
 * defaults; invalid override entries are dropped".
 *
 * Only known data keys survive (allowlist: registry storeKeys +
 * projectOverrides + userPresets); unknown keys are dropped.
 */
export function sanitizePersistedState(state: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set<string>([
    ...listSettings().map((d) => d.storeKey).filter((k): k is string => !!k),
    "projectOverrides",
    "userPresets",
  ]);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(state)) {
    if (allowed.has(key)) out[key] = state[key];
  }
  for (const def of listSettings()) {
    if (!def.storeKey) continue;
    const key = def.storeKey;
    if (key in out && !def.validate(out[key])) out[key] = def.defaultValue;
  }

  // projectOverrides: object of objects with validated entries
  const raw = out.projectOverrides;
  const cleaned: Record<string, Record<string, unknown>> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [projectId, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      const kept: Record<string, unknown> = {};
      for (const [settingId, value] of Object.entries(entries as Record<string, unknown>)) {
        const def = getSetting(settingId);
        if (def && def.scopes.includes("project") && def.validate(value)) kept[settingId] = value;
      }
      if (Object.keys(kept).length > 0) cleaned[projectId] = kept;
    }
  }
  out.projectOverrides = cleaned;

  // userPresets: validated per entry (label string, known+valid values)
  const rawPresets = out.userPresets;
  const cleanPresets: Record<string, { label: string; values: Record<string, unknown> }> = {};
  if (rawPresets && typeof rawPresets === "object" && !Array.isArray(rawPresets)) {
    for (const [id, preset] of Object.entries(rawPresets as Record<string, unknown>)) {
      if (!preset || typeof preset !== "object") continue;
      const p = preset as { label?: unknown; values?: unknown };
      if (typeof p.label !== "string" || !p.values || typeof p.values !== "object" || Array.isArray(p.values)) continue;
      const keptValues: Record<string, unknown> = {};
      let allValid = true;
      for (const [settingId, value] of Object.entries(p.values as Record<string, unknown>)) {
        const def = getSetting(settingId);
        if (!def || def.sensitive || !def.validate(value)) {
          allValid = false;
          break;
        }
        keptValues[settingId] = value;
      }
      if (allValid) cleanPresets[id] = { label: p.label, values: keptValues };
    }
  }
  out.userPresets = cleanPresets;

  return out;
}
