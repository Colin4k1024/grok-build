import { listSettings, getSetting } from "./registry";
import { CURRENT_SETTINGS_VERSION } from "./version";

/**
 * Sequential settings migration pipeline (R4-06 #239). Steps run in order
 * from the persisted version to CURRENT_SETTINGS_VERSION. A failing step
 * never destroys the original payload — the caller receives ok:false plus
 * the untouched backup.
 */

export interface MigrationStep {
  from: number;
  to: number;
  note: string;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

/** v1 → v2: sanitize every flat field against the registry and guarantee
 *  the projectOverrides layer exists (the R4-05 shape). */
function migrateV1toV2(state: Record<string, unknown>): Record<string, unknown> {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("v1 state is not an object");
  }
  const out: Record<string, unknown> = { ...state };
  for (const def of listSettings()) {
    if (!def.storeKey) continue;
    const key = def.storeKey;
    if (key in out && !def.validate(out[key])) out[key] = def.defaultValue;
  }
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
  return out;
}

export const MIGRATIONS: MigrationStep[] = [
  { from: 1, to: 2, note: "sanitize against registry + ensure projectOverrides layer", migrate: migrateV1toV2 },
];

export interface MigrationResult {
  ok: boolean;
  state: Record<string, unknown>;
  fromVersion: number;
  applied: string[];
  /** Present when a step failed — the ORIGINAL payload, untouched. */
  backup?: unknown;
  error?: string;
}

export function migratePersisted(persisted: unknown): MigrationResult {
  const doc = (persisted ?? {}) as { state?: unknown; version?: unknown };
  const original = persisted;
  // Unversioned payloads predate the version field entirely → treat as v1.
  const fromVersion = typeof doc.version === "number" ? doc.version : 1;

  if (fromVersion > CURRENT_SETTINGS_VERSION) {
    return {
      ok: false,
      state: {},
      fromVersion,
      applied: [],
      backup: original,
      error: `persisted version ${fromVersion} is NEWER than this build (${CURRENT_SETTINGS_VERSION}) — refusing to mangle it`,
    };
  }

  let state = (doc.state ?? {}) as Record<string, unknown>;
  const applied: string[] = [];
  let version = fromVersion;
  try {
    while (version < CURRENT_SETTINGS_VERSION) {
      const step = MIGRATIONS.find((s) => s.from === version);
      if (!step) throw new Error(`no migration step from version ${version}`);
      state = step.migrate(state);
      applied.push(`v${step.from}→v${step.to}: ${step.note}`);
      version = step.to;
    }
  } catch (e) {
    return {
      ok: false,
      state: {},
      fromVersion,
      applied,
      backup: original,
      error: `migration failed at v${version}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: true, state, fromVersion, applied };
}
