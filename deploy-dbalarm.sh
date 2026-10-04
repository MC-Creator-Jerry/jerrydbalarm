#!/usr/bin/env bash
# Deploy dbalarm-site:
#   1) push code to GitHub (incremental via git)
#   2) deploy to Cloudflare Pages jerrydbalarm (incremental by default)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
WR="$APPDATA/npm/wrangler.cmd"
PROJ=jerrydbalarm
TOK="$(cat "$ROOT/.github-token" | tr -d '[:space:]')"

LOGIN=MC-Creator-Jerry

# create repo if missing
if ! curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOK" "https://api.github.com/repos/$LOGIN/$PROJ" | grep -q 200; then
  curl -s -X POST -H "Authorization: token $TOK" -H "Content-Type: application/json" \
    -d "{\"name\":\"$PROJ\",\"description\":\"噪音警报器 - mic noise alarm (dB threshold)\",\"homepage\":\"https://$PROJ.pages.dev\",\"public\":true}" \
    https://api.github.com/user/repos >/dev/null
fi

cd "$DIR"
git add -A
if ! git diff --cached --quiet; then
  git -c user.email=bot@workbuddy.local -c user.name=workbuddy commit -q -m "update dbalarm $(date +%F_%T)" || true
fi
if ! git remote | grep -q '^origin$'; then
  git remote add origin "https://x-access-token:${TOK}@github.com/${LOGIN}/${PROJ}.git"
fi
git branch -M main
git push -u origin main || true

"$WR" pages project create "$PROJ" --production-branch main 2>/dev/null || true
"$WR" pages deploy "$DIR" --project-name "$PROJ" --branch main 2>&1 | tail -25
echo "DONE -> https://$PROJ.pages.dev"
