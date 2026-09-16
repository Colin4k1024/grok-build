import { create } from "zustand";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolSuccess?: boolean;
  timestamp: number;
  streaming?: boolean;
}

interface SessionState {
  messages: Record<string, ChatMessage[]>;
  activeSessionId: string | null;
  isStreaming: boolean;

  setActiveSession: (id: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  appendAssistantText: (sessionId: string, delta: string) => void;
  addToolCall: (sessionId: string, toolName: string) => void;
  addToolResult: (sessionId: string, toolName: string, output: string, success: boolean) => void;
  clearMessages: (sessionId: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  messages: {},
  activeSessionId: null,
  isStreaming: false,

  setActiveSession: (id) => set({ activeSessionId: id }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),

  addUserMessage: (sessionId, content) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] || []),
          {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "user" as const,
            content,
            timestamp: Date.now(),
          },
        ],
      },
    })),

  appendAssistantText: (sessionId, delta) =>
    set((state) => {
      const msgs = state.messages[sessionId] || [];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return {
          messages: {
            ...state.messages,
            [sessionId]: [
              ...msgs.slice(0, -1),
              { ...last, content: last.content + delta },
            ],
          },
        };
      }
      return {
        messages: {
          ...state.messages,
          [sessionId]: [
            ...msgs,
            {
              id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: "assistant" as const,
              content: delta,
              timestamp: Date.now(),
              streaming: true,
            },
          ],
        },
      };
    }),

  addToolCall: (sessionId, toolName) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] || []),
          {
            id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "tool" as const,
            content: "",
            toolName,
            timestamp: Date.now(),
          },
        ],
      },
    })),

  addToolResult: (sessionId, toolName, output, success) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] || []),
          {
            id: `tool-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "tool" as const,
            content: output,
            toolName,
            toolSuccess: success,
            timestamp: Date.now(),
          },
        ],
      },
    })),

  clearMessages: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.messages;
      return { messages: rest };
    }),
}));
