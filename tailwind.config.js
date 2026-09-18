export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "gb-bg": "rgb(var(--gb-bg) / <alpha-value>)",
        "gb-bg-secondary": "rgb(var(--gb-bg-secondary) / <alpha-value>)",
        "gb-surface": "rgb(var(--gb-surface) / <alpha-value>)",
        "gb-surface-hover": "rgb(var(--gb-surface-hover) / <alpha-value>)",
        "gb-surface-solid": "rgb(var(--gb-surface-solid) / <alpha-value>)",
        "gb-border": "rgb(var(--gb-border) / <alpha-value>)",
        "gb-text": "rgb(var(--gb-text) / <alpha-value>)",
        "gb-text-secondary": "rgb(var(--gb-text-secondary) / <alpha-value>)",
        "gb-muted": "rgb(var(--gb-muted) / <alpha-value>)",
        "gb-accent": "rgb(var(--gb-accent) / <alpha-value>)",
        "gb-brand": "rgb(var(--gb-brand) / <alpha-value>)",
        "gb-green": "rgb(var(--gb-green) / <alpha-value>)",
        "gb-yellow": "rgb(var(--gb-yellow) / <alpha-value>)",
        "gb-red": "rgb(var(--gb-red) / <alpha-value>)",
        "gb-activitybar": "rgb(var(--gb-activitybar) / <alpha-value>)",
        "gb-activitybar-fg": "rgb(var(--gb-activitybar-fg) / <alpha-value>)",
        "gb-statusbar": "rgb(var(--gb-statusbar) / <alpha-value>)",
        "gb-tab-inactive": "rgb(var(--gb-tab-inactive) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
