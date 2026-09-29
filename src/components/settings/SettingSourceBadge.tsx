import type { SettingSource } from "../../config/types";

/**
 * Source badge (R4-07 #240): every settings row shows where its effective
 * value comes from — 默认 / 全局 / 项目 / 会话. Text, never color alone.
 */
const LABELS: Record<SettingSource, string> = {
  default: "默认",
  global: "全局",
  project: "项目",
  session: "会话",
};

export function SettingSourceBadge({ source }: { source: SettingSource }) {
  return (
    <span
      data-testid="setting-source-badge"
      data-source={source}
      className={
        source === "default"
          ? "rounded-gb-sm px-1.5 py-0.5 text-gb-xs text-gb-text-muted"
          : "rounded-gb-sm bg-gb-accent/15 px-1.5 py-0.5 text-gb-xs text-gb-accent-text"
      }
    >
      {LABELS[source]}
    </span>
  );
}
