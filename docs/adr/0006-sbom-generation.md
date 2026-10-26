# 0006. SBOMs with Syft in SPDX and CycloneDX, attached as signed attestations

- Status: Accepted
- Date: 2026-10-25

## Context

The pipeline must generate an SBOM for every image. An SBOM is only useful if:

- it describes the **exact artifact** that is deployed (the digest, not the
  source tree),
- consumers can trust it was produced by our pipeline,
- it is used to make decisions (vulnerability gating), not just archived.

Two standard formats exist. SPDX is common in licensing and compliance, and
the US federal minimum-elements guidance accepts both. CycloneDX is common in
security tooling. Different consumers ask for different formats.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Syft on the built image** (`anchore/sbom-action`) | Sees OS packages in the base image plus language packages; both formats; pairs with Grype | Another downloaded tool in CI |
| BuildKit's built-in SBOM attestation (`sbom: true`) | Zero extra steps; attached automatically | Stored as an unsigned in-toto statement in the image index; not verified by our admission policy; SPDX only |
| `npm sbom` on the source | Native | Misses the base image entirely (most of the CVEs live there) |
| Trivy | One tool for SBOM and scanning; also scans IaC | Overlaps with Syft + Grype; using both would mean two vulnerability databases that disagree, and gates nobody trusts |

## Decision

- Generate **both SPDX JSON and CycloneDX JSON** with Syft, from the
  **built image** (by digest on main, from the local daemon on PRs).
- **Gate on the SBOM:** Grype scans the SPDX SBOM and fails the build on
  fixable High or Critical vulnerabilities (`only-fixed: true`). Results go to
  GitHub code scanning.
- **Attach the CycloneDX SBOM as a signed in-toto attestation**
  (`cosign attest --type cyclonedx`) with the CI workflow's keyless identity.
  Kyverno requires that attestation at admission, so an image without an SBOM
  cannot run in staging or production.
- Keep both files as a workflow artifact for 90 days (matching the DORA
  window) for audit requests.
- Disable BuildKit's own SBOM and provenance outputs so there is one signed
  source of truth, not two partially-trusted ones.

## Trade-offs and consequences

- Two SBOM generations add about 20 to 40 seconds per build.
- `only-fixed: true` deliberately lets through vulnerabilities that have no
  fix. They remain visible in code scanning. Blocking on them would block
  every build on base-image CVEs we cannot act on. Mitigation: distroless
  base images, digest-pinned and kept current by Dependabot.
- The zero-dependency app (ADR 0011) makes the SBOM almost entirely base-image
  packages. This is intentional, and the pipeline works unchanged once the app
  gains dependencies.
- SBOM attestations prove origin, not completeness. Statically linked or
  vendored code may not appear.

## Revisit when

- A consumer requires VEX statements. Grype accepts `vex:` input, and the
  pipeline would need to publish OpenVEX documents next to the SBOM.
- Kyverno's newer `ImageValidatingPolicy` with Sigstore bundles becomes the
  standard path (see ADR 0007).
