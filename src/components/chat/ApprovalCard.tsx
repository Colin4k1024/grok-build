import { useState, useEffect, useCallback, useRef } from "react";
import { respondPermission, type PermissionOption } from "../../lib/tauri";
import { usePermissionsStore } from "../../stores/permissionsStore";

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
  const addRule = usePermissionsStore((s) => s.addRule);
  const lookup = usePermissionsStore((s) => s.lookup);
  const respondedRef = useRef(false);

  const allowOption = options.find((o) => o.kind === "AllowOnce");
  const allowAlwaysOption = options.find((o) => o.kind === "AllowAlways");
  const denyOption = options.find((o) => o.kind === "Deny");

  // Pre-approve: if a matching allow rule already exists, answer immediately
  // without rendering the card.
  useEffect(() => {
    if (respondedRef.current) return;
    const existing = lookup(toolName, command, sessionId);
    if (existing?.decision === "allow") {
      respondedRef.current = true;
      const autoOption =
        existing.scope === "global"
          ? (allowAlwaysOption ?? allowOption ?? options[0])
          : (allowOption ?? options[0]);
      if (autoOption) {
        respondPermission(sessionId, requestId, autoOption.id, existing.scope === "global")
          .catch((e) => console.error("auto-approve failed:", e))
          .finally(onResolved);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolName, command, sessionId, requestId]);

  // Timeout: auto-deny after 30s. We deliberately do NOT write a deny rule on
  // timeout — going AFK should not blacklist a command.
  useEffect(() => {
    if (remaining <= 0) {
      if (respondedRef.current) return;
      respondedRef.current = true;
      const opt = denyOption ?? options[options.length - 1];
      if (opt) {
        respondPermission(sessionId, requestId, opt.id, false)
          .catch((e) => console.error("auto-deny failed:", e))
          .finally(onResolved);
      } else {
        onResolved();
      }
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  const handleRespond = useCallback(async (action: "allow" | "deny" | "remember") => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    setResponding(true);
    let optionId = "";
    let remember = false;

    if (action === "allow" && allowOption) {
      optionId = allowOption.id;
    } else if (action === "remember" && allowAlwaysOption) {
      optionId = allowAlwaysOption.id;
      remember = true;
    } else if (action === "allow") {
      optionId = options[0]?.id || "";
    } else {
      // Deny: refuse to silently fall back to an Allow option. If no Deny
      // option exists, skip the backend call and just close the card.
      if (!denyOption) {
        console.warn("No Deny option available; refusing to send a fallback allow id");
        onResolved();
        return;
      }
      optionId = denyOption.id;
    }

    try {
      await respondPermission(sessionId, requestId, optionId, remember);
    } catch (e) {
      console.error("Failed to respond to permission:", e);
      // Don't persist a rule for a decision the backend never acknowledged.
      onResolved();
      return;
    }

    // Persist only after the backend confirmed the response.
    if (remember) {
      addRule({
        toolName,
        commandPattern: command,
        decision: "allow",
        createdAt: Date.now(),
      });
    } else if (action === "deny") {
      addRule({
        toolName,
        commandPattern: command,
        decision: "deny",
        createdAt: Date.now(),
        sessionId,
      });
    }
    onResolved();
  }, [sessionId, requestId, options, allowOption, allowAlwaysOption, denyOption, onResolved, addRule, toolName, command]);

  return (
    <div className="mx-4 my-2 rounded-lg border border-gb-yellow/30 bg-gb-yellow/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className="text-gb-yellow">
          <path d="M7 0L0 14h14L7 0zm0 5l3.5 7h-7L7 5z" />
        </svg>
        <span className="text-xs font-semibold text-gb-yellow">需要授权</span>
        <span className="ml-auto text-[10px] text-gb-muted">{remaining} 秒后自动拒绝</span>
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
          ✓ 允许
        </button>
        {allowAlwaysOption && (
          <button
            className="flex-1 rounded-lg bg-gb-accent/20 px-3 py-1.5 text-xs font-medium text-gb-accent hover:bg-gb-accent/30 disabled:opacity-40"
            onClick={() => handleRespond("remember")}
            disabled={responding}
          >
            ✓ 始终允许
          </button>
        )}
        <button
          className="flex-1 rounded-lg bg-gb-red/20 px-3 py-1.5 text-xs font-medium text-gb-red hover:bg-gb-red/30 disabled:opacity-40"
          onClick={() => handleRespond("deny")}
          disabled={responding}
        >
          ✕ 拒绝
        </button>
      </div>
    </div>
  );
}
