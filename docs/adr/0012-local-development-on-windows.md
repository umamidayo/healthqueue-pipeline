# 0012. Local development on Windows with minikube and PowerShell

- Status: Accepted
- Date: 2026-10-25

## Context

The pipeline must run locally for testing on Windows. "Locally" has two
meanings, and both are needed:

1. **Offline checks** (seconds, no cluster): the same validation CI runs.
2. **A full environment** (minutes): Kubernetes, Argo CD, Kyverno, Prometheus
   and the app, close enough to production to test GitOps, policy and SLO
   alerts.

The target machine runs Windows 10/11, possibly Home edition (no Hyper-V
Manager by default), with Docker Desktop optional.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **minikube** (docker or hyperv driver) | Works with or without Docker Desktop; `minikube image build` builds straight into the node (no registry); metrics-server addon for HPA; profiles isolate clusters | Heavier than kind; VM drivers need admin |
| kind | Fast; CI-friendly | Requires Docker; image loading is a separate step; no Hyper-V path |
| Docker Desktop Kubernetes | One click | Single cluster; requires Docker Desktop licence for larger companies; harder to reset cleanly |
| k3d / Rancher Desktop | Lightweight | Additional tool family; less common on Windows teams |

Scripting:

| Option | Pros | Cons |
|---|---|---|
| **PowerShell scripts (5.1-compatible)** | Present on every Windows machine; no extra install | Two script dialects (bash in CI, PowerShell locally) |
| Makefile | Familiar on Linux | `make` is not standard on Windows; quoting differences |
| Taskfile / just | Cross-platform | Extra tool to install |

## Decision

- **minikube** with a dedicated profile (`healthqueue`), docker driver by
  default and `-Driver hyperv` as the alternative. The same OpenTofu module as
  production bootstraps it (`infra/envs/local`).
- **PowerShell scripts** under `scripts/`, written for Windows PowerShell 5.1:
  no `&&`, no ternaries, and native stderr handled explicitly.

| Script | Purpose |
|---|---|
| `check.ps1` | The CI validation suite, offline |
| `local/install-tools.ps1` | kubeconform, promtool, kyverno, actionlint: same versions as CI, SHA-256 verified |
| `local/up.ps1` | Cluster, image, platform, app (idempotent) |
| `local/verify.ps1` | End-to-end checks; non-zero exit on failure |
| `local/load.ps1` | Traffic with optional injected errors and latency, to fire SLO alerts |
| `local/down.ps1` | Delete everything (asks for confirmation) |

- **Two deploy modes:**
  - `-Mode Argo` (default) runs real GitOps from your pushed branch.
  - `-Mode Direct` runs `kubectl apply` from the working tree, for unpushed
    changes. Argo CD is installed without a root app, so self-heal does not
    revert your edits.
- **Local differences from production:**
  - the image is unsigned and exempt from the verify policy (ADR 0007),
  - one replica,
  - chaos hooks enabled,
  - 7-day Prometheus retention.

## Trade-offs and consequences

- **Memory:** the full stack needs about 8 GB for the minikube node. That is
  the cost of running the real Prometheus stack instead of a mock.
- **Two dialects:** bash and PowerShell versions of the same checks can drift.
  Mitigation: the logic lives in Node scripts and Kustomize/Tofu/promtool
  invocations that both call, and the PowerShell layer is thin.
- **Pushed changes only in Argo mode:** Argo mode only sees pushed commits.
  `up.ps1` warns when the working tree is dirty or ahead of its upstream.

## Revisit when

- WSL2 becomes a hard requirement on the team's machines. Then the bash
  scripts could be used directly and the PowerShell layer retired.
