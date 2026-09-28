import { Tooltip } from "../ui";
import { DESTINATIONS, type AppDestination } from "./destinations";

/**
 * ActivityBar (R4-03 #236): the 48px primary rail — the SOLE owner of
 * top-level destinations. Every destination appears exactly once, with
 * aria-current on the active one; search and the sidebar toggle are
 * commands, not destinations. The contextual sidebar must never repeat
 * these entries.
 *
 * Destination registry (labels/icons) lives in ./destinations — TitleBar
 * reads the same source so names never drift.
 */

const SEARCH_ICON = "M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5.2-5.2";
const SIDEBAR_ICON = "M2 4h12v1H2V4zm0 3.5h12v1H2v-1zm0 3.5h12v1H2v-1z";

interface RailButtonProps {
  label: string;
  shortcut?: string;
  icon: string;
  active?: boolean;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

// Plain button (not ui/IconButton) because IconButton forces a `title`
// attribute which would double up with the Tooltip wrapper.
function RailButton({ label, shortcut, icon, active, current, disabled, onClick }: RailButtonProps) {
  const fullLabel = shortcut ? `${label} (${shortcut})` : label;
  return (
    <Tooltip content={fullLabel}>
      <button
        type="button"
        aria-label={fullLabel}
        aria-current={current ? "page" : undefined}
        aria-pressed={current ? undefined : active}
        disabled={disabled}
        onClick={onClick}
        className={[
          "gb-motion-press relative flex h-10 w-10 items-center justify-center rounded-gb-md transition-colors duration-gb-fast ease-gb disabled:cursor-not-allowed disabled:opacity-30",
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
  /** False on destinations that have no contextual sidebar — the toggle is
   *  then disabled instead of invisibly mutating state (R4-03 review). */
  sidebarAvailable: boolean;
}

export function ActivityBar({
  destination,
  onNavigate,
  onOpenSearch,
  onToggleSidebar,
  sidebarVisible,
  sidebarAvailable,
}: ActivityBarProps) {
  const [primary, settingsEntry] = [
    DESTINATIONS.filter((d) => d.id !== "settings"),
    DESTINATIONS.find((d) => d.id === "settings")!,
  ];
  return (
    <nav
      aria-label="主导航"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r gb-border-hairline bg-gb-sidebar pb-2"
    >
      {/* Traffic-light clearance — draggable window region (traffic lights
         end at y≈29 with the default inset position, so keep 32px) */}
      <div className="app-drag h-8 w-full shrink-0" />
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
        active={sidebarAvailable && sidebarVisible}
        disabled={!sidebarAvailable}
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
