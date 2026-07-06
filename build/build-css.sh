#!/usr/bin/env bash
# Rebuild the vendored Tailwind stylesheet (vendor/tailwind.css).
#
# MAINTAINER-ONLY: run this whenever you add or change a Tailwind class in index.html or js/.
# End users never run it — they receive the committed vendor/tailwind.css with the plugin.
# Pinned to Tailwind v3 to match the class set the old cdn.tailwindcss.com (v3) produced.
set -euo pipefail
cd "$(dirname "$0")"
DASHBOARD_DIR="../plugin/skills/fusion/dashboard"
bunx --bun tailwindcss@3 -c tailwind.config.cjs -i tailwind-input.css -o "$DASHBOARD_DIR/vendor/tailwind.css" --minify
echo "Built $DASHBOARD_DIR/vendor/tailwind.css"
