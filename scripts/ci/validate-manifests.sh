#!/usr/bin/env bash
# Renders every Kustomize entry point and validates the result:
#   kubeconform  - Kubernetes + CRD schemas (strict: unknown fields fail)
#   promtool     - PromQL syntax of every PrometheusRule, plus alert unit tests
#   kyverno test - admission policy behaviour
# Same checks run locally via scripts/check.ps1. Requires kubectl (kustomize)
# and the tools from install-tools.sh on PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."

K8S_VERSION=1.34.12
# Pinned commit of https://github.com/datreeio/CRDs-catalog (CRD JSON schemas).
CRDS_CATALOG=3eb90d47aba8d61919d4419dd38301536e32a94b

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

render() { echo "render $1"; kubectl kustomize "$1" > "$out/$2.yaml"; }
for o in local staging production; do render "deploy/overlays/$o" "overlay-$o"; done
render deploy/platform/policies platform-policies
render deploy/platform/observability platform-observability
for c in local production; do render "argocd/clusters/$c" "argocd-$c"; done

echo "--- kubeconform"
kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/${CRDS_CATALOG}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  "$out"/*.yaml

echo "--- promtool"
# A PrometheusRule's .spec is a valid Prometheus rule file once dedented.
mkdir -p "$out/rules"
extract() { awk '/^spec:/{f=1;next} f{sub(/^  /,""); print}' "$1" > "$out/rules/$2.yaml"; }
extract deploy/components/monitoring/slo-rules.yaml slo-rules
extract deploy/platform/observability/argocd-rules.yaml argocd-rules
promtool check rules "$out"/rules/*.yaml
cp observability/tests/*.yaml "$out/rules/"
(cd "$out/rules" && promtool test rules ./*.test.yaml)

echo "--- kyverno"
kyverno test deploy/platform/policies/tests
