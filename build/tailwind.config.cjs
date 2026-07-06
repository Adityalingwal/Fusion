/**
 * Tailwind v3 build config for the Fusion dashboard.
 *
 * The dashboard ships a PRE-COMPILED stylesheet (vendor/tailwind.css) so it stays fully
 * self-contained — no cdn.tailwindcss.com at runtime, no 'unsafe-eval' in the CSP, works offline.
 * This file is used only by the maintainer's build step (./build-css.sh); end users never run it.
 *
 * `content` must list every source that can contain a class name, or that class gets tree-shaken
 * out of the output and its style silently disappears. All dashboard classes are written as literal
 * strings in index.html and js/ (no runtime string concatenation), so a static scan catches them.
 *
 * The theme mirrors the old browser-side js/tailwind-config.js verbatim.
 */
module.exports = {
  content: [
    "../plugin/skills/fusion/dashboard/index.html",
    "../plugin/skills/fusion/dashboard/js/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        "dm-bg": "#F9F6EE",           // main surface — canvas, sidebar, headers, cards
        "dm-panel-beige": "#EFEDE7",  // hover / selected tint
        "dm-accent": "#1A1917",       // black used as a fill (active tab, selected dot, badges)
        "dm-text": "#1A1917",         // primary text + borders
        "dm-text-soft": "#4A4842",    // secondary / muted-dark text
        "dm-muted": "#8C8B82",        // muted labels, running state, timestamps
      },
      fontFamily: {
        sans: ["Manrope", "sans-serif"],
        mono: ["Geist Mono", "monospace"],
      },
    },
  },
};
