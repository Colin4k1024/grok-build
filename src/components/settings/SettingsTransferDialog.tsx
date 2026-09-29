import { useState } from "react";
import {
  applyImport,
  exportSettings,
  previewImport,
  restoreSettings,
  snapshotSettings,
  type ImportPreview,
} from "../../config/transfer";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui";
import { Button, Dialog } from "../ui";

/**
 * SettingsTransferDialog (R4-07 #240): export to a file, or open a file,
 * preview its changes, and only apply after explicit confirmation.
 * Sensitive settings never export (R4-06); imports are atomic (rollback on
 * any failure). Opens in "import" or "export" mode depending on the button.
 */

interface Props {
  open: boolean;
  mode: "import" | "export";
  onClose: () => void;
}

export function SettingsTransferDialog({ open, mode, onClose }: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [replaceMode, setReplaceMode] = useState(false);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    setBusy(true);
    try {
      const doc = exportSettings();
      const r = (await invoke("settings_transfer_save", {
        content: JSON.stringify(doc, null, 2),
        defaultPath: "grok-build-settings.json",
      })) as { path: string | null };
      if (r.path) {
        toast.success(`已导出到 ${r.path}`);
        onClose();
      }
    } catch (e) {
      toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doImportOpen = async () => {
    setBusy(true);
    try {
      const r = (await invoke("settings_transfer_open")) as { content: string | null };
      if (!r.content) return;
      const p = previewImport(r.content, { mode: replaceMode ? "replace" : "merge" });
      setPreview(p);
      if (!p.ok) toast.error("导入文件无效");
    } catch (e) {
      toast.error(`读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doApply = () => {
    if (!preview?.ok) return;
    const before = snapshotSettings();
    const r = applyImport(preview, { mode: replaceMode ? "replace" : "merge" });
    if (r.ok) {
      toast.success(`已应用 ${r.applied.length} 项设置`, {
        action: { label: "撤销", onClick: () => restoreSettings(before) },
      });
      setPreview(null);
      onClose();
    } else {
      toast.error(`导入失败（已回滚）：${r.failed[0] ?? "未知错误"}`);
    }
  };

  const close = () => {
    setPreview(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={mode === "export" ? "导出设置" : "导入设置"}>
      <div className="space-y-3">
        <p className="text-gb-xs text-gb-text-muted">
          导出为 JSON 文件（敏感项自动剔除）；导入前会先预览变更，确认后才写入。
        </p>
        <div className="flex gap-2">
          {mode === "export" ? (
            <Button size="sm" onClick={doExport} loading={busy}>
              导出到文件…
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={doImportOpen} loading={busy}>
              从文件选择…
            </Button>
          )}
        </div>

        {mode === "import" && (
          <label className="flex items-center gap-2 text-gb-xs text-gb-text-secondary">
            <input
              type="checkbox"
              checked={replaceMode}
              // Re-run the preview after a mode change: applyImport recomputes
              // resets in replace mode, so a preview built under merge mode
              // would otherwise under-report what gets applied. Clearing the
              // preview forces a fresh confirm with the new mode.
              onChange={(e) => {
                setReplaceMode(e.target.checked);
                setPreview(null);
              }}
            />
            替换模式（文档中缺失的已覆盖项将重置为默认）
          </label>
        )}

        {preview && (
          <div className="rounded-gb-md border gb-border-hairline bg-gb-canvas p-3" data-testid="import-preview">
            {preview.ok ? (
              <div className="space-y-1 text-gb-xs">
                <p className="font-medium text-gb-text-primary">变更预览</p>
                {preview.added.length > 0 && <p className="text-gb-success-text">新增：{preview.added.join("、")}</p>}
                {preview.changed.length > 0 && <p className="text-gb-warning-text">修改：{preview.changed.join("、")}</p>}
                {preview.reset.length > 0 && <p className="text-gb-danger-text">重置：{preview.reset.join("、")}</p>}
                {preview.ignored.length > 0 && <p className="text-gb-text-muted">忽略：{preview.ignored.join("、")}</p>}
                {preview.added.length + preview.changed.length + preview.reset.length === 0 && (
                  <p className="text-gb-text-muted">没有有效变更</p>
                )}
                <div className="pt-2 flex gap-2">
                  <Button size="sm" onClick={doApply}>确认应用</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>取消</Button>
                </div>
              </div>
            ) : (
              <div className="text-gb-xs text-gb-danger-text">
                <p className="font-medium">无法导入</p>
                {preview.errors.map((e) => (
                  <p key={e}>{e}</p>
                ))}
                <div className="pt-2">
                  <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>关闭</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
