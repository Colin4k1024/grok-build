import { SegmentedControl, Tooltip } from "../ui";

/**
 * ScopeSwitcher (R4-07 #240): always-visible Global / current-project
 * switch. Project scope is disabled (with a reason) when there is no
 * active project context.
 */
export function ScopeSwitcher({
  scope,
  onScopeChange,
  projectName,
}: {
  scope: "global" | "project";
  onScopeChange: (scope: "global" | "project") => void;
  /** Project display name; undefined = no active project. */
  projectName?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Tooltip content="项目值覆盖全局值；项目级重置只移除项目覆盖，不动全局">
        <span>
          <SegmentedControl
            label="作用域"
            value={scope}
            onChange={(v) => onScopeChange(v as "global" | "project")}
            options={[
              { value: "global", label: "全局" },
              { value: "project", label: projectName ? "当前项目" : "当前项目（无）", disabled: !projectName },
            ]}
          />
        </span>
      </Tooltip>
      {projectName && (
        <span className="max-w-[180px] truncate text-gb-xs text-gb-text-muted" title={projectName}>
          {projectName}
        </span>
      )}
    </div>
  );
}
