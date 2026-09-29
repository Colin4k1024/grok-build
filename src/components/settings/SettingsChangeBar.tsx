import { Button } from "../ui";

/**
 * SettingsChangeBar (R4-07 #240): the sticky apply/discard bar shown while
 * staged (high-impact) settings have unsaved changes or a partial failure
 * needs attention. Success feedback is a toast (owned by the page), so the
 * bar never lingers after a clean apply.
 */

export interface ChangeBarProps {
  count: number;
  saving: boolean;
  /** Per-key failure messages from the last apply attempt. */
  failures: string[];
  onApply: () => void;
  onDiscard: () => void;
}

export function SettingsChangeBar({ count, saving, failures, onApply, onDiscard }: ChangeBarProps) {
  if (count === 0 && failures.length === 0) return null;

  return (
    <div
      data-testid="settings-change-bar"
      role="status"
      className="gb-motion-toast-enter sticky bottom-0 z-10 flex items-center gap-3 border-t gb-border-control bg-gb-surface-2 px-4 py-2.5 shadow-gb-medium"
    >
      {failures.length > 0 ? (
        <span className="text-gb-xs text-gb-danger-text">
          {failures.length} 项保存失败：{failures[0]}
        </span>
      ) : (
        <span className="text-gb-xs text-gb-text-secondary">{count} 项未保存的修改</span>
      )}
      <div className="flex-1" />
      {count > 0 ? (
        <>
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            放弃
          </Button>
          <Button size="sm" loading={saving} onClick={onApply}>
            应用
          </Button>
        </>
      ) : (
        // failures-only state: still dismissible
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          知道了
        </Button>
      )}
    </div>
  );
}
