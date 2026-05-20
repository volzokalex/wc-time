#!/bin/bash
# Bump the ?v= cache-busting query strings in index.html, then commit & push.
# This forces browsers / CDNs to fetch fresh assets — no stale cache on mobile.

set -e
cd "$(dirname "$0")"

TS=$(date +%s)

# Replace the version on every `?v=N` reference inside index.html.
# Works on both GNU and BSD sed via the -i'' trick.
sed -i.bak -E "s/(style\.css|main\.js|roll\.png)\?v=[^\"']+/\1?v=${TS}/g" index.html
rm -f index.html.bak

if git diff --quiet --staged && git diff --quiet; then
  echo "Nothing to commit."
  exit 0
fi

git add .
MSG="${1:-Deploy $(date '+%Y-%m-%d %H:%M:%S')}"
git commit -m "$MSG"
git push
echo "Deployed with cache-busting version v=${TS}"
