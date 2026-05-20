/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      colors: {
        ink: "#172026",
        line: "#d9e2e7",
        mist: "#f4f7f8",
        accent: "#0f766e",
        coral: "#e66b4f",
      },
      boxShadow: {
        panel: "0 16px 60px rgba(23, 32, 38, 0.08)",
      },
    },
  },
  plugins: [],
};
