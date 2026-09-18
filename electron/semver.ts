/** Semver subset for the updater (ISS-076): MAJOR.MINOR.PATCH[-pre]. */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function isPreReleaseChars(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    const ok =
      (ch >= "0" && ch <= "9") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "." ||
      ch === "-";
    if (!ok) return false;
  }
  return true;
}

export function parseSemver(v: string): Semver | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let core = s;
  let pre = "";
  const dash = s.indexOf("-");
  if (dash >= 0) {
    core = s.slice(0, dash);
    pre = s.slice(dash + 1);
  }
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  if (!isDigits(parts[0]) || !isDigits(parts[1]) || !isDigits(parts[2])) return null;
  if (pre !== "" && !isPreReleaseChars(pre)) return null;
  return {
    major: parseInt(parts[0], 10),
    minor: parseInt(parts[1], 10),
    patch: parseInt(parts[2], 10),
    pre,
  };
}

/**
 * True when a > b. Unparseable versions never compare greater (an offer
 * with a garbage version string is treated as a downgrade and refused).
 */
export function semverGreater(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;
  // no pre-release outranks a pre-release at the same triple
  if (pa.pre === pb.pre) return false;
  if (pa.pre === "") return true;
  if (pb.pre === "") return false;
  return pa.pre > pb.pre;
}
