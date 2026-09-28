import { getSetting } from "./registry";

/**
 * Built-in configuration presets (R4-06 #239): safe / balanced /
 * high-autonomy. Presets may only reference non-sensitive, registry-known
 * settings with valid values — presetErrors() enforces that at load/test.
 */

export interface PresetDef {
  id: string;
  label: string;
  description: string;
  values: Record<string, unknown>;
}

export const BUILTIN_PRESETS: PresetDef[] = [
  {
    id: "safe",
    label: "安全",
    description: "沙箱运行，所有写操作都需手动批准",
    values: {
      "permissions.sandboxMode": "sandbox",
      "agent.autonomous": false,
      "agent.mode": "code",
    },
  },
  {
    id: "balanced",
    label: "均衡",
    description: "沙箱运行，低风险步骤自动继续",
    values: {
      "permissions.sandboxMode": "sandbox",
      "agent.autonomous": true,
      "agent.mode": "code",
    },
  },
  {
    id: "high-autonomy",
    label: "高自治",
    description: "沙箱运行，架构模式长任务自动推进",
    values: {
      "permissions.sandboxMode": "sandbox",
      "agent.autonomous": true,
      "agent.mode": "architect",
    },
  },
];

/** Validate every builtin against the registry; [] means healthy. */
export function presetErrors(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const preset of BUILTIN_PRESETS) {
    if (seen.has(preset.id)) errors.push(`duplicate preset id: ${preset.id}`);
    seen.add(preset.id);
    for (const [settingId, value] of Object.entries(preset.values)) {
      const def = getSetting(settingId);
      if (!def) {
        errors.push(`${preset.id}: unknown setting ${settingId}`);
        continue;
      }
      if (def.sensitive) errors.push(`${preset.id}: ${settingId} is sensitive`);
      if (!def.validate(value)) {
        errors.push(`${preset.id}: invalid value for ${settingId}: ${JSON.stringify(value)}`);
      }
    }
  }
  return errors;
}

export function getPreset(id: string): PresetDef | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}
