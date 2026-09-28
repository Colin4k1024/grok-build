import { Tooltip } from "../ui";

/**
 * ActivityBar (R4-03 #236): the 48px primary rail — the SOLE owner of
 * top-level destinations. Every destination appears exactly once, with
 * aria-current on the active one; search is a command (overlay), not a
 * destination. The contextual sidebar must never repeat these entries.
 */

export type AppDestination =
  | "conversations"
  | "dashboard"
  | "automations"
  | "agents"
  | "settings";

interface DestinationDef {
  id: AppDestination;
  label: string;
  shortcut?: string;
  icon: string; // svg path
}

const DESTINATIONS: DestinationDef[] = [
  {
    id: "conversations",
    label: "会话",
    shortcut: "⌘1",
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

const SEARCH_ICON = "M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5.2-5.2";
const SIDEBAR_ICON = "M2 4h12v1H2V4zm0 3.5h12v1H2v-1zm0 3.5h12v1H2v-1z";

interface RailButtonProps {
  label: string;
  shortcut?: string;
  icon: string;
  active?: boolean;
  current?: boolean;
  onClick: () => void;
}

function RailButton({ label, shortcut, icon, active, current, onClick }: RailButtonProps) {
  const fullLabel = shortcut ? `${label} (${shortcut})` : label;
  return (
    <Tooltip content={fullLabel}>
      <button
        type="button"
        aria-label={fullLabel}
        aria-current={current ? "page" : undefined}
        aria-pressed={current ? undefined : active}
        onClick={onClick}
        className={[
          "gb-motion-press relative flex h-10 w-10 items-center justify-center rounded-gb-md transition-colors duration-gb-fast ease-gb",
          current || active
            ? "bg-gb-accent/15 text-gb-accent-text"
            : "text-gb-text-muted hover:bg-gb-surface-hover hover:text-gb-text-primary",
        ].join(" ")}
      >
        {current ? (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-gb-accent"
          />
        ) : null}
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={icon} />
        </svg>
      </button>
    </Tooltip>
  );
}

export interface ActivityBarProps {
  destination: AppDestination;
  onNavigate: (destination: AppDestination) => void;
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  sidebarVisible: boolean;
}

export function ActivityBar({
  destination,
  onNavigate,
  onOpenSearch,
  onToggleSidebar,
  sidebarVisible,
}: ActivityBarProps) {
  const [primary, settingsEntry] = [
    DESTINATIONS.filter((d) => d.id !== "settings"),
    DESTINATIONS.find((d) => d.id === "settings")!,
  ];
  return (
    <nav
      aria-label="主导航"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r gb-border-hairline bg-gb-sidebar py-2"
    >
      {/* Traffic-light clearance — draggable window region */}
      <div className="app-drag h-6 w-full shrink-0" />
      {primary.map((d) => (
        <RailButton
          key={d.id}
          label={d.label}
          shortcut={d.shortcut}
          icon={d.icon}
          current={destination === d.id}
          onClick={() => onNavigate(d.id)}
        />
      ))}
      <RailButton
        label="搜索"
        shortcut="⌘G"
        icon={SEARCH_ICON}
        onClick={onOpenSearch}
      />
      <RailButton
        label="切换会话侧栏"
        shortcut="⌘B"
        icon={SIDEBAR_ICON}
        active={sidebarVisible}
        onClick={onToggleSidebar}
      />
      <div className="flex-1" />
      <RailButton
        label={settingsEntry.label}
        shortcut={settingsEntry.shortcut}
        icon={settingsEntry.icon}
        current={destination === "settings"}
        onClick={() => onNavigate("settings")}
      />
    </nav>
  );
}
