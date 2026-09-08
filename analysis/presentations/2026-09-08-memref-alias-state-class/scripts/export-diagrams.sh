#!/usr/bin/env bash
set -euo pipefail

# Preferred: use a local Excalidraw exporter if available.
# Keep existing SVG files when no exporter is installed; they are editable via the paired .excalidraw sources.
if command -v excalidraw-brute-export-cli >/dev/null 2>&1; then
  for src in diagrams/*.excalidraw; do
    [ -e "$src" ] || continue
    out="${src%.excalidraw}.svg"
    excalidraw-brute-export-cli -i "$src" -o "$out" -f svg -s 1 -b true
  done
elif command -v excalidraw-cli >/dev/null 2>&1; then
  for src in diagrams/*.excalidraw; do
    [ -e "$src" ] || continue
    out="${src%.excalidraw}.svg"
    excalidraw-cli export svg "$src" -o "$out" || excalidraw-cli export svg "$src"
  done
else
  echo "No Excalidraw exporter found; using checked-in SVG fallbacks." >&2
fi
