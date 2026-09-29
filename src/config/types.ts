/**
 * Configuration type system (R4-05 #238). Every user-facing setting is a
 * typed definition registered in the registry; resolution across scopes is
 * deterministic and explained to the caller (value + source + invalids).
 */

/** Override scopes, most specific last in the list but winning first at
 *  resolution: session > project > global > default. */
export type SettingScope = "global" | "project" | "session";
export type SettingSource = "default" | SettingScope;

export type SettingValueType = "string" | "number" | "boolean" | "string[]" | "enum";

export interface SettingDefinition<T = unknown> {
  /** Stable dotted id, e.g. "appearance.theme". */
  id: string;
  /** Grouping key, e.g. "appearance" — drives the settings sidebar. */
  category: string;
  label: string;
  description: string;
  type: SettingValueType;
  defaultValue: T;
  /** Scopes allowed to override the default. */
  scopes: SettingScope[];
  /** Extra search terms (synonyms, pinyin, english). */
  keywords: string[];
  /** Hidden unless the settings UI is in Advanced mode. */
  advanced?: boolean;
  /** Persisted but not yet consumed by any runtime path — the UI shows a
   *  规划中 badge and disables the control instead of pretending it works. */
  planned?: boolean;
  /** Never exported, never echoed to logs; only presence is reported. */
  sensitive?: boolean;
  /** Requires an app restart to take effect. */
  requiresRestart?: boolean;
  /** immediate = save on change (low-risk); staged = explicit Apply. */
  saveMode: "immediate" | "staged";
  /** Allowed values for type === "enum". */
  enumValues?: readonly T[];
  /** Display labels for enum values (presentation metadata, owned here). */
  enumLabels?: Record<string, string>;
  /** Range for type === "number". */
  numberRange?: { min: number; max: number; step: number };
  /** Quick-pick values for type === "number" (rendered as preset buttons). */
  quickValues?: number[];
  /** High-risk: the UI confirms with this message before applying a change
   *  (immediate: on field change; staged: at Apply). Keeps security/safety
   *  toggles from flipping without an explicit ack (R4-08 #241). */
  highRisk?: string;
  /** Flat field name in the legacy settingsStore (global layer binding).
   *  Absent means the setting has no global store binding. */
  storeKey?: string;
  /** Runtime type guard — the single validation authority. */
  validate: (value: unknown) => value is T;
}

export interface SettingLayers {
  global?: unknown;
  project?: unknown;
  session?: unknown;
}

export interface ResolvedSetting<T = unknown> {
  value: T;
  source: SettingSource;
  /** Layers that held a value which failed validation or scope rules. */
  invalidSources: SettingScope[];
  /** True when a non-default layer won. */
  overridden: boolean;
}
