import { useSessionStore } from "../../stores/sessionStore";

export function TodoPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const todos = useSessionStore((s) => s.todos);
  const toggleTodo = useSessionStore((s) => s.toggleTodo);

  const sessionTodos = activeSessionId ? todos[activeSessionId] || [] : [];

  if (sessionTodos.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-gb-muted">
        No TODO items. Use /plan to create a plan.
      </div>
    );
  }

  const completed = sessionTodos.filter((t) => t.status === "Completed").length;
  const inProgress = sessionTodos.filter((t) => t.status === "InProgress").length;
  const progress = Math.round((completed / sessionTodos.length) * 100);

  const statusIcon = (status: string) => {
    switch (status) {
      case "Completed": return "✓";
      case "InProgress": return "●";
      default: return "○";
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "Completed": return "text-gb-green";
      case "InProgress": return "text-gb-accent";
      default: return "text-gb-muted";
    }
  };

  return (
    <div className="space-y-2 p-2">
      {/* Progress bar */}
      <div className="rounded-md bg-gb-surface p-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-gb-muted">
          <span>{completed}/{sessionTodos.length} completed</span>
          {inProgress > 0 && <span className="text-gb-accent">{inProgress} in progress</span>}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-gb-bg">
          <div
            className="h-full rounded-full bg-gb-green transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* TODO list */}
      <div className="space-y-1">
        {sessionTodos.map((todo) => (
          <label
            key={todo.id}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-gb-surface"
            onClick={() => activeSessionId && toggleTodo(activeSessionId, todo.id)}
          >
            <span className={`mt-0.5 text-sm ${statusColor(todo.status)}`}>
              {statusIcon(todo.status)}
            </span>
            <span className={`flex-1 text-xs ${todo.status === "Completed" ? "text-gb-muted line-through" : "text-gb-text"}`}>
              {todo.content}
            </span>
            {todo.priority && todo.priority !== "Normal" && (
              <span className="rounded bg-gb-bg px-1 text-[9px] text-gb-muted">
                {todo.priority}
              </span>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}
