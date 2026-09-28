import { SETTINGS_SCHEMA } from "./schema";
import type { SettingDefinition } from "./types";

/**
 * Registry (R4-05 #238): the query/validation layer over the schema.
 * The registry is validated at module load — an invalid registry fails
 * fast in dev/test instead of shipping broken defaults.
 */

const REGISTRY = new Map<string, SettingDefinition>();

for (const def of SETTINGS_SCHEMA) {
  REGISTRY.set(def.id, def);
}

/** Structural validation of the whole registry; [] means healthy. */
export function registryErrors(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const def of SETTINGS_SCHEMA) {
    if (seen.has(def.id)) errors.push(`duplicate id: ${def.id}`);
    seen.add(def.id);
    if (!def.label || !def.description) errors.push(`${def.id}: missing label/description`);
    if (!def.scopes || def.scopes.length === 0) errors.push(`${def.id}: no override scopes`);
    if (!def.validate(def.defaultValue))
      errors.push(`${def.id}: default value fails its own validator`);
    if (def.type === "enum" && !(def.enumValues ?? []).includes(def.defaultValue as never))
      errors.push(`${def.id}: default not in enumValues`);
  }
  return errors;
}

export function listSettings(): SettingDefinition[] {
  return [...REGISTRY.values()];
}

export function getSetting(id: string): SettingDefinition | undefined {
  return REGISTRY.get(id);
}

export interface CategoryGroup {
  category: string;
  settings: SettingDefinition[];
}

/** Categories in first-seen registration order. */
export function listCategories(): CategoryGroup[] {
  const order: string[] = [];
  const byCat = new Map<string, SettingDefinition[]>();
  for (const def of REGISTRY.values()) {
    if (!byCat.has(def.category)) {
      byCat.set(def.category, []);
      order.push(def.category);
    }
    byCat.get(def.category)!.push(def);
  }
  return order.map((category) => ({ category, settings: byCat.get(category)! }));
}

/** Search across id, label, description and keywords (case-insensitive). */
export function searchSettings(query: string): SettingDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return listSettings();
  return listSettings().filter((def) => {
    if (def.id.toLowerCase().includes(q)) return true;
    if (def.label.toLowerCase().includes(q)) return true;
    if (def.description.toLowerCase().includes(q)) return true;
    return def.keywords.some((k) => k.toLowerCase().includes(q));
  });
}

// Fail fast on a broken registry in dev/test. Production keeps running —
// resolveSetting falls back to per-setting validators.
const errors = registryErrors();
if (errors.length > 0 && import.meta.env?.DEV) {
  throw new Error(`[config] invalid registry:\n${errors.join("\n")}`);
}
