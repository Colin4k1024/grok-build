export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "gb-bg": "var(--gb-bg)",
        "gb-surface": "var(--gb-surface)",
        "gb-border": "var(--gb-border)",
        "gb-text": "var(--gb-text)",
        "gb-muted": "var(--gb-muted)",
        "gb-accent": "var(--gb-accent)",
        "gb-green": "var(--gb-green)",
        "gb-yellow": "var(--gb-yellow)",
        "gb-red": "var(--gb-red)",
        "gb-blue": "var(--gb-blue)",
      },
    },
  },
  plugins: [],
};
