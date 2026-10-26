#!/usr/bin/env bash
# Verifies an image the same way the Kyverno admission policy does, so a
# promotion that would be rejected by the cluster fails in CI instead.
#
#   scripts/ci/verify-image.sh ghcr.io/<owner>/healthqueue-api@sha256:... <owner>/<repo>
#
# Checks:
#   1. image signature from .github/workflows/ci.yml on refs/heads/main
#   2. CycloneDX SBOM attestation from the same identity
#   3. SLSA provenance from the slsa-github-generator, for this repo's main
#      branch and this repo's ci.yml entry point
set -euo pipefail

REF="${1:?image@digest required}"
REPO="${2:?owner/repo required}"
[[ "$REF" == *@sha256:* ]] || { echo "refusing to verify a tag; pass image@sha256:..." >&2; exit 2; }

ISSUER=https://token.actions.githubusercontent.com
CI_IDENTITY="https://github.com/${REPO}/.github/workflows/ci.yml@refs/heads/main"
SLSA_IDENTITY_RE='^https://github\.com/slsa-framework/slsa-github-generator/\.github/workflows/generator_container_slsa3\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
FLAGS=(--new-bundle-format=false --certificate-oidc-issuer "$ISSUER")

echo "1/3 signature"
cosign verify "${FLAGS[@]}" --certificate-identity "$CI_IDENTITY" "$REF" > /dev/null

echo "2/3 SBOM attestation"
cosign verify-attestation "${FLAGS[@]}" --certificate-identity "$CI_IDENTITY" --type cyclonedx "$REF" > /dev/null

echo "3/3 SLSA provenance"
prov="$(cosign verify-attestation "${FLAGS[@]}" --certificate-identity-regexp "$SLSA_IDENTITY_RE" --type slsaprovenance "$REF")"
# One JSON line per attestation; take the first. `sed -n 1p`, not `head -1`,
# so the writer is never cut off (SIGPIPE + pipefail = spurious exit 141).
predicate="$(printf '%s\n' "$prov" | sed -n 1p | jq -r '.payload' | base64 -d | jq '.predicate')"
uri="$(echo "$predicate" | jq -r '.invocation.configSource.uri')"
entry="$(echo "$predicate" | jq -r '.invocation.configSource.entryPoint')"
want_uri="git+https://github.com/${REPO}@refs/heads/main"
if [[ "$uri" != "$want_uri" || "$entry" != ".github/workflows/ci.yml" ]]; then
  echo "provenance mismatch: built from '$uri' via '$entry', expected '$want_uri' via .github/workflows/ci.yml" >&2
  exit 1
fi
echo "verified: $REF"
echo "  built from $(echo "$predicate" | jq -r '.invocation.configSource.digest.sha1') by $(echo "$predicate" | jq -r '.builder.id')"
