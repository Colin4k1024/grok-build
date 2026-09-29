<claude-mem-context>
# Memory Context

# [grok-build] recent context, 2026-09-29 4:11pm GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (19,022t read) | 6,369,355t work | 100% savings

### Sep 29, 2026
63 1:06p 🔵 Restart Policy sync bug: SandboxToggle no-op guard prevents main-process Policy push after app restart
64 " ✅ Schema scopes tightened for four settings: zoom, agent.mode, agent.autonomous, trustedFolders reduced to global-only
65 " 🟣 VoiceSettings legacy key migration: one-time consume of gb-voice-wake, gb-voice-tts, gb-voice-language to prevent restart clobber
66 " 🔄 Appearance module simplified: removed project-aware resolution, reads raw localStorage at boot
67 " 🔴 TrustedFolders setGlobalByKey path now mirrors to legacy gb-trusted-folders key
68 " 🔴 No-op detection in applyPreset and applyImport compares against target layer instead of resolved value
69 " ✅ useNotifications hook cleaned up: removed dead return values, no callers affected
73 1:30p 🔄 SandboxToggle enforcement rewritten with per-project resolution and restart-safe push tracking
74 " 🔄 Settings schema scopes corrected to "honest scopes" — removed overpromised project scopes from global-only settings
75 " 🔴 Voice legacy keys consume-once migration prevents store write reversion on restart
76 " 🔄 Appearance module simplified — removed project-aware resolution, uses direct localStorage read at boot
77 " 🔴 beforeunload handler fixed to use hasUnsavedChanges() instead of confirmLeaveIfDirty()
78 " 🔴 No-op detection in applyPreset and applyImport now compares against the target layer, not the resolved effective value
79 " ✅ useNotifications hook stripped of return value — now effect-only, called for side effects in App.tsx
80 " ✅ AGENTS.md rewritten from empty to 62-line project context document
81 " ✅ All 87 tests pass across 6 test files — no regressions from R4-07 enforcement + honesty follow-ups
82 2:50p 🔵 Dashboard false positive: empty pendingQuestions array treated as truthy in needs-attention logic
83 " 🔵 Main-process automation scheduler ignores enabled/paused flag — UI toggle has no effect
84 " 🟣 New shared UI primitives: AsyncState, CollapsibleSection, CopyButton, PageShell (R4-09 #242)
85 " 🔄 Automation IPC helpers now propagate errors instead of silently swallowing them
86 " 🟣 Dashboard redesigned from vanity metrics to actionable attention-first layout
87 " 🟣 PluginManager unified with shared UI primitives: Skeleton loading, EmptyState, toast feedback
88 " 🟣 RightPanel MCP inspector uses CollapsibleSection with CopyButton for server entries
89 " 🟣 WorkspaceAgentsPage unified with PageShell + detail cards for failed agent recovery
90 3:12p 🟣 Unified page shell layout component introduced for consistent page structure
91 " 🟣 AsyncState component unifies loading/empty/error/data rendering across pages
92 " 🟣 Inspector detail primitives added: CollapsibleSection and CopyButton
93 " 🟣 Automation enable/disable toggle added with full async feedback loop
94 " 🔄 Dashboard redesigned from vanity metrics to actionable attention-first layout
95 " 🔄 Plugin manager and MCP panel upgraded with consistent feedback UI patterns
96 " 🔄 Workspace agents page refactored with PageShell, Card, and master-detail consistency
97 " 🔵 IPC error handling for automations was silently swallowing failures before this change
98 " ⚖️ All new UI tests pass and TypeScript compiles cleanly; 939 insertions/396 deletions across 15 files verified
99 3:32p 🟣 Automation enable/disable toggle with failure-recovery across renderer and main process
100 " 🔄 Dashboard redesigned to surface actionable attention items instead of vanity metrics
101 " 🟣 New shared UI primitives: PageShell, AsyncState, CollapsibleSection, CopyButton
102 " 🔄 RightPanel MCP panel and PluginManager unified with shared state primitives
103 " 🟣 WorkspaceAgentsPage unified with PageShell and failed-agent recovery action
104 " 🔵 TypeScript compilation clean and all 39 tests pass across 3 test files
105 3:46p 🟣 Automation enable/disable toggle implemented with main-process enforcement
106 " 🔴 IPC helpers now throw errors instead of silently swallowing them
107 " 🔴 Run Now no longer syncs stale renderer state back to main process
108 " 🟣 Four new shared UI primitives: AsyncState, PageShell, CollapsibleSection, CopyButton
109 " 🔄 Dashboard redesigned from vanity metrics to attention-first actionable layout
110 " 🔄 AutomationsPage fully rewritten with unified state primitives, toast feedback, and next-run display
111 " 🔄 RightPanel MCP inspector unified with CollapsibleSection and CopyButton
112 " 🔄 WorkspaceAgentsPage unified with PageShell master-detail layout and failed agent recovery
113 " 🔄 PluginManager unified with toast feedback, Skeleton loading, and EmptyState
114 " 🔵 8 pre-existing test failures unrelated to R4-09 changes
115 " ✅ AGENTS.md updated from 6-line skeleton to 62-line project context document with 50 indexed observations

Access 6369k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>