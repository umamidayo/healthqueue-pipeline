# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-25

## Context

A delivery pipeline is made of many small, coupled choices: which CI, how
images are signed, who may change production. Each looks arbitrary without its
reasoning, and a reviewer or new maintainer cannot tell a deliberate trade-off
from an accident. Later changes then undo decisions whose purpose was never
written down.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| ADRs in the repo (Nygard format, plus explicit options and trade-offs) | Versioned with the code they describe; reviewed in PRs; cheap | Need discipline to write; can go stale |
| Wiki / Confluence pages | Rich formatting, easy to find for non-engineers | Drifts from the code; not reviewed with the change |
| Code comments only | Closest to the code | Cannot capture rejected alternatives or cross-cutting decisions |

## Decision

Keep ADRs in `docs/adr/`, one file per decision, numbered and immutable once
accepted. Every ADR lists the options considered, the trade-offs, and the
signals that should trigger a revisit. Code comments link to the ADR that
explains them.

## Trade-offs and consequences

- Reviewers can challenge a decision against its stated context instead of
  re-deriving it.
- Writing an ADR adds work to significant changes. That work is the point.
- The "Revisit when" section makes it explicit when a decision has expired.
