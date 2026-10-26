#!/usr/bin/env bash
# Commits a verified digest to the staging overlay. Called by ci.yml.
#
# Ordering guard: two pushes to main can finish out of order. Only promote if
# the commit being promoted is a descendant of what staging already runs, so
# staging never moves backwards.
set -euo pipefail
# shellcheck source=scripts/ci/gitops-lib.sh
source "$(dirname "$0")/gitops-lib.sh"

: "${DIGEST:?}" "${IMAGE:?}" "${GITHUB_SHA:?}"

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

gitops_identity
git add deploy/overlays/staging
# The Source-Revision trailer is parsed by the DORA collector (docs/dora.md).
git commit -m "chore(deploy): promote ${GITHUB_SHA::12} to staging [skip ci]" -m "Source-Revision: ${GITHUB_SHA}" -m "Image: ${IMAGE}@${DIGEST}"
gitops_push_main
echo "staging -> ${IMAGE}@${DIGEST}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
