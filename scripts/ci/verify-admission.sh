#!/usr/bin/env bash
# Runs the real admission policies (deploy/platform/policies) against an
# image with the Kyverno CLI, i.e. the same verification engine the cluster
# uses at admission. cosign-based checks (verify-image.sh) are not enough on
# their own: cosign v3 and Kyverno's ClusterPolicy verifier resolve trust
# roots differently, so an image can pass cosign and still be rejected by the
# cluster. Requires the kyverno CLI from install-tools.sh on PATH.
#
#   scripts/ci/verify-admission.sh ghcr.io/<owner>/healthqueue-api@sha256:...
set -euo pipefail

REF="${1:?image@digest required}"
[[ "$REF" == *@sha256:* ]] || { echo "refusing to check a tag; pass image@sha256:..." >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/pod.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: admission-precheck
  namespace: healthqueue-staging
spec:
  containers:
    - name: api
      image: ${REF}
EOF

cat > "$work/values.yaml" <<'EOF'
apiVersion: cli.kyverno.io/v1alpha1
kind: Values
metadata:
  name: admission-precheck
namespaceSelector:
  - name: healthqueue-staging
    labels:
      healthqueue.io/environment: staging
EOF

kubectl kustomize deploy/platform/policies > "$work/policies.yaml"
echo "Checking ${REF} against the staging/production admission policies"
kyverno apply "$work/policies.yaml" --resource "$work/pod.yaml" --values-file "$work/values.yaml"
echo "admission pre-check passed: ${REF}"
