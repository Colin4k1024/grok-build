import { CURRENT_SETTINGS_VERSION } from "./version";
import { sanitizePersistedState } from "./sanitize";

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

/** v1 → v2: the shared registry sanitizer (also the persist merge guard)
 *  plus guaranteeing the projectOverrides layer exists. */
function migrateV1toV2(state: Record<string, unknown>): Record<string, unknown> {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("v1 state is not an object");
  }
  return sanitizePersistedState(state);
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
