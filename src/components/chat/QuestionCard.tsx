// Renders the agent's ask_user_question tool as an interactive card.
// Wire protocol (x.ai/ask_user_question ext method):
//   accept: { outcome: "accepted", answers: { "<question text>": ["<label>", ...] } }
//   cancel: { outcome: "cancelled" }
import { useState } from "react";
import { respondUserQuestion, type UserQuestion } from "../../lib/tauri";

interface QuestionCardProps {
  sessionId: string;
  requestId: string;
  questions: UserQuestion[];
  mode: string;
  onResolved: () => void;
}

export function QuestionCard({ sessionId, requestId, questions, onResolved }: QuestionCardProps) {
  // answers[i] = set of selected labels for question i
  const [selections, setSelections] = useState<Set<string>[]>(() => questions.map(() => new Set()));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const next = [...prev];
      const cur = new Set(next[qi]);
      if (multi) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      next[qi] = cur;
      return next;
    });
  };

  const finish = async (response: Record<string, unknown>) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await respondUserQuestion(sessionId, requestId, response);
    } catch (e) {
      console.error("respondUserQuestion failed:", e);
    } finally {
      onResolved();
    }
  };

  const handleSubmit = () => {
    const answers: Record<string, string[]> = {};
    questions.forEach((q, i) => {
      const sel = [...(selections[i] ?? [])];
      if (sel.length > 0) answers[q.question] = sel;
    });
    finish({ outcome: "accepted", answers });
  };

  const answeredCount = selections.filter((s) => s.size > 0).length;

  return (
    <div className="mx-4 my-2 rounded-lg border border-gb-accent/30 bg-gb-accent/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className="text-gb-accent">
          <path d="M7 0a7 7 0 100 14A7 7 0 007 0zm-.1 10.9a.9.9 0 110-1.8.9.9 0 010 1.8zM8.9 6.2c-.5.5-1.1.8-1.4 1.1-.3.4-.4.6-.4 1.1H5.9c0-.9.3-1.4.8-1.9.4-.4.9-.7 1.2-1.1.2-.3.3-.5.3-.8 0-.7-.5-1.1-1.2-1.1-.8 0-1.3.5-1.4 1.3H3.4C3.5 2.9 4.9 1.9 7 1.9c2 0 3.4 1.1 3.4 2.7 0 .8-.3 1.3-1.5 1.6z" />
        </svg>
        <span className="text-xs font-semibold text-gb-text">Agent 想确认几个问题</span>
        <span className="ml-auto text-[10px] text-gb-muted">{answeredCount}/{questions.length} 已回答</span>
      </div>

      <div className="space-y-3">
        {questions.map((q, qi) => (
          <div key={qi}>
            <p className="mb-1.5 text-[12px] font-medium text-gb-text">
              {q.question}
              {q.multiSelect && <span className="ml-1 text-[10px] text-gb-muted">（可多选）</span>}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const selected = selections[qi]?.has(opt.label);
                return (
                  <button
                    key={opt.label}
                    onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                    title={opt.description}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      selected
                        ? "border-gb-accent bg-gb-accent/15 text-gb-text"
                        : "border-gb-border/30 text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 rounded-lg bg-gb-accent px-3 py-1.5 text-xs font-medium text-gb-bg hover:opacity-85 disabled:opacity-40"
          onClick={handleSubmit}
          disabled={submitting || answeredCount === 0}
        >
          提交回答
        </button>
        <button
          className="flex-1 rounded-lg border border-gb-border/20 px-3 py-1.5 text-xs text-gb-muted hover:bg-gb-surface-hover disabled:opacity-40"
          onClick={() => finish({ outcome: "cancelled" })}
          disabled={submitting}
        >
          跳过
        </button>
      </div>
    </div>
  );
}
