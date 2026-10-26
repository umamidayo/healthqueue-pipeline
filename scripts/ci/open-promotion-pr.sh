#!/usr/bin/env bash
# Creates (or refreshes) the staging -> production promotion PR.
# Called by .github/workflows/promote.yml after the image has been verified.
set -euo pipefail

: "${GH_TOKEN:?}" "${APP_SLUG:?}" "${SOURCE:?}" "${REF:?}" "${GITHUB_REPOSITORY:?}"
CURRENT="${CURRENT:-}"

short="${SOURCE::12}"
branch="promote/production-${short}"

node scripts/promote.mjs --env production --from staging

bot_id="$(gh api "/users/${APP_SLUG}%5Bbot%5D" --jq .id)"
git config user.name "${APP_SLUG}[bot]"
git config user.email "${bot_id}+${APP_SLUG}[bot]@users.noreply.github.com"
git switch -c "$branch"
git add deploy/overlays/production
git commit -m "chore(deploy): promote ${short} to production" -m "Source-Revision: ${SOURCE}"
git push --force-with-lease origin "$branch"

compare="none (first production release)"
if [ -n "$CURRENT" ]; then
  compare="https://github.com/${GITHUB_REPOSITORY}/compare/${CURRENT}...${SOURCE}"
fi

fence='```'
cat > body.md <<EOF
Promotes the build running in **staging** to **production**.

| | |
|---|---|
| Image | \`${REF}\` |
| Source revision | ${SOURCE} |
| Changes since production | ${compare} |

<details><summary>Supply-chain verification</summary>

${fence}
$(cat verify.log)
${fence}
</details>

Before approving, check the staging SLO dashboard for error-budget burn since this build landed.
Merging deploys: Argo CD syncs production within minutes. To roll back, revert this PR (docs/runbooks/rollback.md).
EOF

if gh pr view "$branch" --json number > /dev/null 2>&1; then
  gh pr edit "$branch" --body-file body.md
else
  gh pr create --base main --head "$branch" --title "Promote ${short} to production" --body-file body.md --label promotion
fi
