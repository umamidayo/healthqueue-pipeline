#!/usr/bin/env bash
# Commits the (already verified) staging digest to the production overlay.
# Called by .github/workflows/promote.yml after the "production" environment
# gate has been approved and verify-image.sh has passed.
set -euo pipefail
# shellcheck source=scripts/ci/gitops-lib.sh
source "$(dirname "$0")/gitops-lib.sh"

: "${SOURCE:?}" "${REF:?}" "${GITHUB_REPOSITORY:?}"
CURRENT="${CURRENT:-}"
short="${SOURCE::12}"

node scripts/promote.mjs --env production --from staging

gitops_identity
git add deploy/overlays/production
# Source-Revision is parsed by the DORA collector. The environment approver is
# recorded on the linked workflow run; Requested-by is who started it.
git commit -m "chore(deploy): promote ${short} to production [skip ci]" \
  -m "Source-Revision: ${SOURCE}" \
  -m "Image: ${REF}" \
  -m "Requested-by: ${GITHUB_ACTOR:-unknown} via ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-0}"
gitops_push_main

compare="none (first production release)"
if [ -n "$CURRENT" ]; then
  compare="https://github.com/${GITHUB_REPOSITORY}/compare/${CURRENT}...${SOURCE}"
fi
fence='```'
{
  echo "## Promoted to production"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Image | \`${REF}\` |"
  echo "| Source revision | ${SOURCE} |"
  echo "| Changes since previous production | ${compare} |"
  echo
  echo "Argo CD syncs production within minutes. Roll back by reverting the promotion commit (docs/runbooks/rollback.md)."
  echo
  echo "<details><summary>Supply-chain verification</summary>"
  echo
  echo "${fence}"
  cat verify.log
  echo "${fence}"
  echo "</details>"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
