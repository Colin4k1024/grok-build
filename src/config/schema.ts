import type { SettingDefinition } from "./types";

/**
 * The setting schema (R4-05 #238): one definition per user-facing setting.
 * This is the ONLY place defaults live — UI must never re-declare them.
 * Sensitive credentials (API keys, tokens) do NOT belong here; they stay in
 * the main-process secure store.
 */

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (values as readonly string[]).includes(v);

const FONT_SIZES = ["small", "medium", "large", "xlarge"] as const;
const THEMES = ["dark", "light", "auto"] as const;
const AGENT_MODES = ["code", "architect", "debug"] as const;
const VOICE_LANGS = ["auto", "zh-CN", "en-US"] as const;
const SANDBOX_MODES = ["sandbox", "full"] as const;

export const SETTINGS_SCHEMA: SettingDefinition[] = [
  {
    id: "appearance.theme",
    storeKey: "theme",
    category: "appearance",
    label: "主题",
    description: "深色、浅色或跟随系统",
    type: "enum",
    defaultValue: "dark",
    scopes: ["global", "project"],
    keywords: ["theme", "dark", "light", "dark mode", "外观"],
    saveMode: "immediate",
    enumValues: THEMES,
    enumLabels: { dark: "深色", light: "浅色", auto: "跟随系统" },
    validate: oneOf(THEMES),
  },
  {
    id: "appearance.fontSize",
    storeKey: "fontSize",
    category: "appearance",
    label: "界面字号",
    description: "全局界面文字大小档位",
    type: "enum",
    defaultValue: "medium",
    scopes: ["global"],
    keywords: ["font", "size", "字号", "字体"],
    saveMode: "immediate",
    enumValues: FONT_SIZES,
    enumLabels: { small: "小 (12px)", medium: "中 (13px)", large: "大 (15px)", xlarge: "特大 (17px)" },
    validate: oneOf(FONT_SIZES),
  },
  {
    id: "appearance.zoom",
    storeKey: "zoom",
    category: "appearance",
    label: "界面缩放",
    description: "窗口整体缩放比例（1.0 = 100%）",
    type: "number",
    defaultValue: 1.0,
    scopes: ["global", "project"],
    keywords: ["zoom", "缩放", "scale"],
    saveMode: "immediate",
    numberRange: { min: 0.5, max: 2.5, step: 0.05 },
    quickValues: [0.8, 0.9, 1.0, 1.1, 1.25, 1.5],
    validate: (v): v is number => isNumber(v) && v >= 0.5 && v <= 2.5,
  },
  {
    id: "permissions.sandboxMode",
    storeKey: "sandboxMode",
    category: "permissions",
    label: "沙箱模式",
    description: "限制代理的文件与命令访问范围",
    type: "enum",
    defaultValue: "sandbox",
    scopes: ["global", "project"],
    keywords: ["sandbox", "permission", "沙箱", "权限"],
    saveMode: "staged",
    enumValues: SANDBOX_MODES,
    enumLabels: { sandbox: "沙箱", full: "完全访问" },
    highRisk: "切换沙箱模式会改变代理的文件与命令访问范围。完全访问允许代理直接读写宿主系统。",
    validate: oneOf(SANDBOX_MODES),
  },
  {
    id: "agent.mode",
    storeKey: "agentMode",
    category: "agent",
    label: "代理模式",
    description: "code / architect / debug 工作模式",
    type: "enum",
    defaultValue: "code",
    scopes: ["global", "project", "session"],
    keywords: ["agent", "mode", "模式", "work mode"],
    saveMode: "immediate",
    enumValues: AGENT_MODES,
    enumLabels: { code: "代码", architect: "架构", debug: "调试" },
    validate: oneOf(AGENT_MODES),
  },
  {
    id: "agent.autonomous",
    storeKey: "agentAutonomous",
    category: "agent",
    label: "自治执行",
    description: "允许代理在低风险操作上自动继续（高风险仍需批准）",
    type: "boolean",
    defaultValue: false,
    scopes: ["global", "project"],
    keywords: ["autonomous", "auto", "自治", "自动"],
    advanced: true,
    saveMode: "staged",
    highRisk: "启用自治执行后，代理会在低风险操作上自动继续，不再逐项请求批准。",
    validate: isBoolean,
  },
  {
    id: "voice.language",
    storeKey: "voiceLanguage",
    category: "voice",
    label: "语音语言",
    description: "语音识别输入语言",
    type: "enum",
    defaultValue: "auto",
    scopes: ["global"],
    keywords: ["voice", "language", "语音", "语言", "stt"],
    saveMode: "immediate",
    enumValues: VOICE_LANGS,
    enumLabels: { auto: "自动", "zh-CN": "中文", "en-US": "English" },
    validate: oneOf(VOICE_LANGS),
  },
  {
    id: "voice.wakeEnabled",
    storeKey: "voiceWakeEnabled",
    category: "voice",
    label: "唤醒词",
    description: "启用语音唤醒",
    type: "boolean",
    defaultValue: false,
    scopes: ["global"],
    keywords: ["voice", "wake", "唤醒"],
    advanced: true,
    saveMode: "staged",
    validate: isBoolean,
  },
  {
    id: "voice.ttsEnabled",
    storeKey: "voiceTtsEnabled",
    category: "voice",
    label: "语音播报",
    description: "朗读代理回复",
    type: "boolean",
    defaultValue: false,
    scopes: ["global"],
    keywords: ["voice", "tts", "播报", "朗读"],
    advanced: true,
    saveMode: "staged",
    validate: isBoolean,
  },
  {
    id: "notifications.enabled",
    storeKey: "notificationsEnabled",
    category: "notifications",
    label: "桌面通知",
    description: "任务完成或需要处理时发送系统通知",
    type: "boolean",
    defaultValue: true,
    scopes: ["global"],
    keywords: ["notification", "通知", "提醒"],
    saveMode: "immediate",
    validate: isBoolean,
  },
  {
    id: "general.trustedFolders",
    storeKey: "trustedFolders",
    category: "general",
    label: "受信任目录",
    description: "这些目录中的项目跳过逐项权限确认",
    type: "string[]",
    defaultValue: [] as string[],
    scopes: ["global", "project"],
    keywords: ["trusted", "folders", "信任", "目录"],
    advanced: true,
    // Absolute paths reveal the user's filesystem layout — excluded from
    // exports by default (R4-06 privacy review).
    sensitive: true,
    saveMode: "staged",
    validate: isStringArray,
  },
];
