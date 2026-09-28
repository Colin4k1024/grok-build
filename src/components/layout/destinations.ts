/**
 * Single source of truth for top-level destinations (R4-03 #236).
 * ActivityBar (rail), TitleBar (context label) and tests all read from
 * here so labels never drift.
 */

export type AppDestination =
  | "conversations"
  | "dashboard"
  | "automations"
  | "agents"
  | "settings";

export interface DestinationDef {
  id: AppDestination;
  label: string;
  /** Only real, actually-bound shortcuts may be advertised. */
  shortcut?: string;
  icon: string; // svg path
}

export const DESTINATIONS: DestinationDef[] = [
  {
    id: "conversations",
    label: "会话",
    icon: "M14 3H5a2 2 0 00-2 2v14a2 2 0 002 2h9M14 3l5 5m-5-5v5h5M9 12h6M9 16h4",
  },
  {
    id: "dashboard",
    label: "仪表盘",
    icon: "M3 20h18M6 20v-6m6 6V8m6 12v-9",
  },
  {
    id: "automations",
    label: "自动化",
    icon: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2",
  },
  {
    id: "agents",
    label: "代理",
    icon: "M12 12a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM5 20a7 7 0 0114 0",
  },
  {
    id: "settings",
    label: "设置",
    shortcut: "⌘,",
    icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82.33l.06.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
  },
];

export const DESTINATION_LABELS: Record<AppDestination, string> = Object.fromEntries(
  DESTINATIONS.map((d) => [d.id, d.label]),
) as Record<AppDestination, string>;
