#!/usr/bin/env bash
# Shared helpers for the GitOps promotion scripts. Source it; don't run it.
#
# Commits are made with the built-in GITHUB_TOKEN (from actions/checkout) as
# GitHub's own "github-actions[bot]" identity, so no GitHub App or extra
# account is needed (docs/adr/0013-promotion-without-a-bot.md).

gitops_identity() {
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
}

# Pushes HEAD to main, rebasing onto newer commits up to 3 times. Promotions
# only touch their own overlay directory, so rebases do not conflict.
gitops_push_main() {
  local attempt
  for attempt in 1 2 3; do
    if git push origin HEAD:main; then
      return 0
    fi
    echo "push rejected (attempt $attempt); rebasing onto latest main"
    git pull --rebase origin main
  done
  echo "could not push after 3 attempts. If main has a ruleset requiring pull requests or status checks, GITHUB_TOKEN cannot bypass it; see docs/operations.md, section 2." >&2
  return 1
}
