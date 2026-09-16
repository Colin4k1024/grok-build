import { useEffect, useRef, useCallback, useState } from "react";
import { EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { Schema, Node as PMNode } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { inputRules, wrappingInputRule, textblockTypeInputRule, smartQuotes, emDash, ellipsis } from "prosemirror-inputrules";

/**
 * ProseMirror-based composer for the chat input.
 *
 * Supports:
 * - Markdown-ish input rules (# heading, > quote, ``` code block, -/* list)
 * - Bold/italic/code marks via Cmd+B / Cmd+I / Cmd+E
 * - Inline @mention decoration (file, project, skill)
 * - Placeholder text when empty
 * - Slash command detection via onSlashQuery callback
 */

// Build a schema with list support and an inline mention node.
const baseNodes = addListNodes(basicSchema.spec.nodes, "paragraph block*", "block");
const mentionNode = baseNodes.addToEnd("mention", {
  inline: true,
  group: "inline",
  atom: true,
  attrs: { kind: { default: "file" }, label: { default: "" }, id: { default: "" } },
  toDOM: (node) => [
    "span",
    {
      class: `gb-mention gb-mention-${node.attrs.kind}`,
      "data-mention-id": node.attrs.id,
      "data-mention-kind": node.attrs.kind,
    },
    `@${node.attrs.label}`,
  ],
  parseDOM: [
    {
      tag: "span.gb-mention",
      getAttrs: (dom) => ({
        kind: (dom as HTMLElement).dataset.mentionKind || "file",
        id: (dom as HTMLElement).dataset.mentionId || "",
        label: (dom as HTMLElement).textContent?.replace(/^@/, "") || "",
      }),
    },
  ],
});

export const composerSchema = new Schema({
  nodes: mentionNode,
  marks: basicSchema.spec.marks,
});

const pluginKey = new PluginKey("gb-composer");

interface ComposerEditorProps {
  placeholder?: string;
  disabled?: boolean;
  /** Called when the user hits plain Enter (without Shift) — the parent sends. */
  onSubmit: (text: string) => void;
  /** Called when the user hits Escape — parent cancels streaming. */
  onCancel: () => void;
  /** Slash command trigger: called with the current "/..." query or null. */
  onSlashQuery: (query: string | null) => void;
  /** Mention trigger: called with the current "@..." query or null. */
  onMentionQuery: (query: string | null) => void;
  /** Imperative handle so parent can insert a mention chip. */
  onReady?: (api: ComposerApi) => void;
  /** Reset key — change to clear the editor. */
  resetKey?: number | string;
  /** Initial content (used when reopening a draft). */
  initialText?: string;
}

export interface ComposerApi {
  insertMention: (kind: "file" | "project" | "skill", id: string, label: string) => void;
  insertText: (text: string) => void;
  clear: () => void;
  focus: () => void;
  getText: () => string;
}

function docToPlainText(doc: PMNode): string {
  // Convert the doc to plain text; mention nodes serialize as @label so the
  // backend can see what the user referenced.
  const parts: string[] = [];
  doc.descendants((node) => {
    if (node.isText) parts.push(node.text || "");
    else if (node.type.name === "mention") parts.push(`@${node.attrs.label}`);
    else if (node.isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
      parts.push("\n");
    }
    return true;
  });
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// Plugin: emit slash/mention queries as the user types.
function makeTriggerPlugin(
  onSlash: (q: string | null) => void,
  onMention: (q: string | null) => void
) {
  return new Plugin({
    key: pluginKey,
    view: () => ({
      update: (view) => {
        const { state } = view;
        const { $from, empty } = state.selection;
        if (!empty) {
          onSlash(null);
          onMention(null);
          return;
        }
        const textBefore = $from.parent.textBetween(
          Math.max(0, $from.parentOffset - 64),
          $from.parentOffset,
          undefined,
          "\uFFFC"
        );
        const slashMatch = /(?:^|\s)(\/[^\s/]*)$/.exec(textBefore);
        const mentionMatch = /(?:^|\s)@([A-Za-z0-9_\-./]{0,64})$/.exec(textBefore);
        onSlash(slashMatch ? slashMatch[1] : null);
        onMention(mentionMatch ? mentionMatch[1] : null);
      },
    }),
  });
}

// Plugin: placeholder via decoration when the doc is empty.
function makePlaceholderPlugin(placeholder: string) {
  return new Plugin({
    props: {
      decorations: (state) => {
        const { doc } = state;
        if (
          doc.childCount === 1 &&
          doc.firstChild!.isTextblock &&
          doc.firstChild!.content.size === 0
        ) {
          const widget = document.createElement("span");
          widget.className = "gb-placeholder";
          widget.textContent = placeholder;
          return DecorationSet.create(doc, [Decoration.widget(1, widget, { side: 0 })]);
        }
        return DecorationSet.empty;
      },
    },
  });
}

// Plugin: handle Enter (submit) and Escape (cancel) at the editor level so
// ProseMirror's keymap doesn't swallow them.
function makeKeyHandlerPlugin(onSubmit: () => void, onCancel: () => void) {
  return new Plugin({
    props: {
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return true;
        }
        return false;
      },
    },
  });
}

export function ComposerEditor({
  placeholder = "Send a message…",
  disabled = false,
  onSubmit,
  onCancel,
  onSlashQuery,
  onMentionQuery,
  onReady,
  resetKey,
  initialText = "",
}: ComposerEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  // Latest callbacks via refs so plugins don't capture stale closures.
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  const onSlashRef = useRef(onSlashQuery);
  const onMentionRef = useRef(onMentionQuery);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onCancelRef.current = onCancel;
    onSlashRef.current = onSlashQuery;
    onMentionRef.current = onMentionQuery;
  }, [onSubmit, onCancel, onSlashQuery, onMentionQuery]);

  const submitCurrent = useCallback(() => {
    const view = viewRef.current;
    if (!view || disabled) return;
    const text = docToPlainText(view.state.doc);
    if (!text.trim()) return;
    onSubmitRef.current(text);
  }, [disabled]);

  const cancelCurrent = useCallback(() => {
    onCancelRef.current();
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      schema: composerSchema,
      plugins: [
        history(),
        keymap({
          "Mod-b": toggleMark(composerSchema.marks.strong),
          "Mod-i": toggleMark(composerSchema.marks.em),
          "Mod-e": toggleMark(composerSchema.marks.code),
          "Mod-z": undo,
          "Mod-y": redo,
          "Shift-Mod-z": redo,
        }),
        inputRules({
          rules: [
            ...smartQuotes,
            emDash,
            ellipsis,
            wrappingInputRule(/^\s*>\s$/, composerSchema.nodes.blockquote),
            wrappingInputRule(/^\s*([-+*])\s$/, composerSchema.nodes.bullet_list),
            textblockTypeInputRule(/^```$/, composerSchema.nodes.code_block),
            textblockTypeInputRule(/^(#{1,6})\s$/, composerSchema.nodes.heading, (m) => ({
              level: m[1].length,
            })),
          ],
        }),
        keymap(baseKeymap),
        makeKeyHandlerPlugin(submitCurrent, cancelCurrent),
        makeTriggerPlugin(
          (q) => onSlashRef.current(q),
          (q) => onMentionRef.current(q)
        ),
        makePlaceholderPlugin(placeholder),
      ],
    });

    const view = new EditorView(hostRef.current, {
      state,
      attributes: {
        class: "gb-composer-editor",
        "aria-label": "Message composer",
        role: "textbox",
        "aria-multiline": "true",
      },
      dispatchTransaction: (tr) => {
        const newState = view.state.apply(tr);
        view.updateState(newState);
        setIsEmpty(newState.doc.content.size === 0);
      },
      editable: () => !disabledRef.current,
    });

    viewRef.current = view;

    // Seed initial text.
    if (initialText) {
      const tr = view.state.tr.insertText(initialText, 1);
      view.dispatch(tr);
    }

    // Expose imperative API.
    const api: ComposerApi = {
      insertMention: (kind, id, label) => {
        const node = composerSchema.nodes.mention.create({ kind, id, label });
        const tr = view.state.tr.replaceSelectionWith(node, false);
        // Move cursor after the inserted atom.
        const sel = TextSelection.findFrom(tr.doc.resolve(tr.selection.$from.pos), 1);
        if (sel) tr.setSelection(sel);
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
      insertText: (text) => {
        view.dispatch(view.state.tr.insertText(text).scrollIntoView());
        view.focus();
      },
      clear: () => {
        const all = view.state.tr.delete(0, view.state.doc.content.size);
        view.dispatch(all);
      },
      focus: () => view.focus(),
      getText: () => docToPlainText(view.state.doc),
    };
    onReady?.(api);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // resetKey forces re-initialization (e.g. after send, parent bumps the key
    // to clear). We deliberately don't re-run on every render. `placeholder`
    // and `disabled` are intentionally excluded — placeholder is set once at
    // mount; `disabled` is enforced via the `editable` callback reading the
    // latest prop, which doesn't require rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return (
    <div
      ref={hostRef}
      data-empty={isEmpty}
      className="gb-composer-host min-h-[22px] flex-1 text-[13px] leading-relaxed text-gb-text outline-none [&_.gb-composer-editor]:outline-none [&_.gb-placeholder]:pointer-events-none [&_.gb-placeholder]:text-gb-muted"
    />
  );
}
