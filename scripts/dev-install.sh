#!/usr/bin/env bash
# Point a Zotero profile at .scaffold/build/addon (an "extension proxy file"),
# so rebuild + restart picks up changes without reinstalling an .xpi.
# Zotero must be closed: it rewrites prefs.js on exit.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
id="$(node -p "require('$repo/package.json').config.addonID")"
build="$repo/.scaffold/build/addon"

if pgrep -x zotero >/dev/null || pgrep -f 'zotero-bin' >/dev/null; then
  echo "Quit Zotero first (it rewrites prefs.js on exit)." >&2
  exit 1
fi
[[ -f "$build/manifest.json" ]] || { echo "Build first: npm run build" >&2; exit 1; }

profiles="${ZOTERO_PROFILES_DIR:-$HOME/.zotero/zotero}"
profile="${1:-}"
if [[ -z "$profile" ]]; then
  rel="$(awk -F= '/^\[Profile/{p=""} /^Path=/{p=$2} /^Default=1/{print p; exit}' "$profiles/profiles.ini")"
  profile="$profiles/$rel"
fi
[[ -d "$profile" ]] || { echo "No profile at $profile" >&2; exit 1; }

mkdir -p "$profile/extensions"
printf '%s' "$build" > "$profile/extensions/$id"
# Force Zotero to rescan extensions on next start
sed -i '/extensions\.lastAppBuildId/d;/extensions\.lastAppVersion/d' "$profile/prefs.js"
echo "Linked $id → $build in $profile. Start Zotero."
