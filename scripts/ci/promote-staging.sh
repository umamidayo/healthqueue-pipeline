#!/usr/bin/env bash
# Commits a verified digest to the staging overlay. Called by ci.yml.
#
# Ordering guard: two pushes to main can finish out of order. Only promote if
# the commit being promoted is a descendant of what staging already runs, so
# staging never moves backwards.
set -euo pipefail

: "${DIGEST:?}" "${IMAGE:?}" "${GITHUB_SHA:?}" "${APP_SLUG:?}" "${GH_TOKEN:?}"

current="$(node -p 'require("./deploy/overlays/staging/release.json").sourceRevision || ""')"
if [ -n "$current" ] && [ "$current" != "$GITHUB_SHA" ] && ! git merge-base --is-ancestor "$current" "$GITHUB_SHA"; then
  echo "staging already runs $current, which is not an ancestor of $GITHUB_SHA; skipping (newer build won)."
  exit 0
fi

node scripts/promote.mjs --env staging --digest "$DIGEST" --image "$IMAGE" --source-revision "$GITHUB_SHA"
if git diff --quiet; then
  echo "staging already at $DIGEST"
  exit 0
fi

bot_id="$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/users/${APP_SLUG}%5Bbot%5D" | jq -r .id)"
git config user.name "${APP_SLUG}[bot]"
git config user.email "${bot_id}+${APP_SLUG}[bot]@users.noreply.github.com"
git add deploy/overlays/staging
# The Source-Revision trailer is parsed by the DORA collector (docs/dora.md).
git commit -m "chore(deploy): promote ${GITHUB_SHA::12} to staging [skip ci]" -m "Source-Revision: ${GITHUB_SHA}" -m "Image: ${IMAGE}@${DIGEST}"

for attempt in 1 2 3; do
  if git push origin HEAD:main; then exit 0; fi
  echo "push rejected (attempt $attempt); rebasing onto latest main"
  git pull --rebase origin main
done
echo "could not push the staging promotion after 3 attempts" >&2
exit 1
