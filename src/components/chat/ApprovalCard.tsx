import { useState, useEffect, useCallback } from "react";
import { respondPermission, type PermissionOption } from "../../lib/tauri";

interface ApprovalCardProps {
  sessionId: string;
  requestId: string;
  toolName: string;
  command: string;
  options: PermissionOption[];
  onResolved: () => void;
}

export function ApprovalCard({
  sessionId, requestId, toolName, command, options, onResolved,
}: ApprovalCardProps) {
  const [responding, setResponding] = useState(false);
  const [remaining, setRemaining] = useState(30);

  const allowOption = options.find((o) => o.kind === "AllowOnce");
  const allowAlwaysOption = options.find((o) => o.kind === "AllowAlways");

  // Timeout: auto-deny after 30s
  useEffect(() => {
    if (remaining <= 0) {
      handleRespond("deny");
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const handleRespond = useCallback(async (action: "allow" | "deny" | "remember") => {
    setResponding(true);
    let optionId = "";
    let remember = false;

    if (action === "allow" && allowOption) {
      optionId = allowOption.id;
    } else if (action === "remember" && allowAlwaysOption) {
      optionId = allowAlwaysOption.id;
      remember = true;
    } else if (action === "allow") {
      // Fallback to first option
      optionId = options[0]?.id || "";
    } else {
      // Deny: send the deny option or cancel
      optionId = options.find((o) => o.kind === "Deny")?.id || options[0]?.id || "";
    }

    try {
      await respondPermission(sessionId, requestId, optionId, remember);
    } catch (e) {
      console.error("Failed to respond to permission:", e);
    }
    onResolved();
  }, [sessionId, requestId, options, allowOption, allowAlwaysOption, onResolved]);

  return (
    <div className="mx-4 my-2 rounded-lg border border-gb-yellow/30 bg-gb-yellow/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className="text-gb-yellow">
          <path d="M7 0L0 14h14L7 0zm0 5l3.5 7h-7L7 5z" />
        </svg>
        <span className="text-xs font-semibold text-gb-yellow">Permission Required</span>
        <span className="ml-auto text-[10px] text-gb-muted">Auto-deny in {remaining}s</span>
      </div>
      <div className="mb-2">
        <span className="text-xs font-medium text-gb-text">{toolName}</span>
        {command && (
          <pre className="mt-1 max-h-24 overflow-y-auto rounded bg-gb-bg p-2 text-[11px] text-gb-muted">
            {command}
          </pre>
        )}
      </div>
      <div className="flex gap-2">
        <button
          className="flex-1 rounded-lg bg-gb-green/20 px-3 py-1.5 text-xs font-medium text-gb-green hover:bg-gb-green/30 disabled:opacity-40"
          onClick={() => handleRespond("allow")}
          disabled={responding}
        >
          ✓ Allow
        </button>
        {allowAlwaysOption && (
          <button
            className="flex-1 rounded-lg bg-gb-accent/20 px-3 py-1.5 text-xs font-medium text-gb-accent hover:bg-gb-accent/30 disabled:opacity-40"
            onClick={() => handleRespond("remember")}
            disabled={responding}
          >
            ✓ Always
          </button>
        )}
        <button
          className="flex-1 rounded-lg bg-gb-red/20 px-3 py-1.5 text-xs font-medium text-gb-red hover:bg-gb-red/30 disabled:opacity-40"
          onClick={() => handleRespond("deny")}
          disabled={responding}
        >
          ✕ Deny
        </button>
      </div>
    </div>
  );
}
