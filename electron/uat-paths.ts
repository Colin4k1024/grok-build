/**
 * UAT-only path overrides (R5-04 / #260).
 *
 * `desktop-uat.mjs run` launches the packed app with GB_UAT_USER_DATA_DIR
 * pointing at the run's isolated dir. This helper is the single place that
 * validates the override; main.ts installs it before the first app.getPath
 * call. Production is untouched when the variable is absent.
 */

import path from "node:path";

export const UAT_USER_DATA_ENV = "GB_UAT_USER_DATA_DIR";

/** Resolve the UAT userData override.
 *
 *  Returns null when the variable is unset (production behavior). Throws on
 *  a set-but-relative value — a relative override would silently scatter
 *  UAT state into whatever cwd the app happened to start in, so it is a
 *  hard error instead of a fallback. */
export function resolveUatUserDataDir(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env[UAT_USER_DATA_ENV];
  if (raw === undefined || raw === "") return null;
  if (!path.isAbsolute(raw)) {
    throw new Error(`${UAT_USER_DATA_ENV} must be an absolute path (got ${JSON.stringify(raw)})`);
  }
  return raw;
}
