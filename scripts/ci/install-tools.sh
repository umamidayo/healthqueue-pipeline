#!/usr/bin/env bash
# Installs pinned CLI tools for CI into ./.tools/bin, verifying each download
# against a SHA-256 recorded here (not fetched alongside the artifact), so a
# tampered release asset fails the build. Linux x86_64 only.
# Windows equivalent: scripts/local/install-tools.ps1 (same versions).
set -euo pipefail

BIN="${TOOLS_DIR:-$PWD/.tools}/bin"
mkdir -p "$BIN"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # name url sha256
  local name="$1" url="$2" sum="$3" file="$tmp/$(basename "$2")"
  curl -fsSL --retry 3 -o "$file" "$url"
  echo "$sum  $file" | sha256sum -c --quiet - || { echo "checksum mismatch for $name" >&2; exit 1; }
  echo "$file"
}

KUBECONFORM_VERSION=v0.8.0
f=$(fetch kubeconform "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz" \
  9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883)
tar -xzf "$f" -C "$BIN" kubeconform

PROMETHEUS_VERSION=3.15.1
f=$(fetch promtool "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz" \
  6a726885328ad9efebbf36e876ce2fb6225468a71fd1e7ce3ba666d5f4d97a84)
tar -xzf "$f" -C "$tmp" "prometheus-${PROMETHEUS_VERSION}.linux-amd64/promtool"
mv "$tmp/prometheus-${PROMETHEUS_VERSION}.linux-amd64/promtool" "$BIN/"

KYVERNO_VERSION=v1.19.2
f=$(fetch kyverno "https://github.com/kyverno/kyverno/releases/download/${KYVERNO_VERSION}/kyverno-cli_${KYVERNO_VERSION}_linux_x86_64.tar.gz" \
  357eaf1df8bc24ddd5a73979fadeaae6a032e8710f11af264229756e4956bf4a)
tar -xzf "$f" -C "$BIN" kyverno

ACTIONLINT_VERSION=1.7.12
f=$(fetch actionlint "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
  8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8)
tar -xzf "$f" -C "$BIN" actionlint

[ -n "${GITHUB_PATH:-}" ] && echo "$BIN" >> "$GITHUB_PATH"
"$BIN/kubeconform" -v && "$BIN/promtool" --version | head -1 && "$BIN/kyverno" version | head -1 && "$BIN/actionlint" -version | head -1
