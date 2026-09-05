# Bake Pi documentation

These pages describe the product Bake Pi intends to ship, the system that exists
today, and the evidence still required before a release. They are written for
contributors and maintainers.

## Understand the product

- [Product scope](product/scope.md) defines the product goal, v1 boundaries,
  capability targets, and release profiles.
- [Roadmap](planning/roadmap.md) turns that scope into milestones with goals,
  deliverables, exit criteria, and decision gates.

## Understand the system

- [Architecture overview](architecture/overview.md) explains the process model,
  trust boundaries, state ownership, and major trade-offs.
- [Project structure](architecture/project-structure.md) is the factual map of
  workspaces, source directories, build targets, and enforced dependency rules.

## Plan and track work

- [Roadmap](planning/roadmap.md) records milestone status and the evidence needed
  to advance.
- [Open coverage gaps](planning/coverage-gaps.md) records behavior that is absent,
  untested, contradicted, or not yet proven.

## Inspect evidence and provenance

- [Implementation log](history/implementation-log.md) preserves findings from the
  first working integration.
- [Adversarial plan review](history/adversarial-plan-review.md) preserves the review
  that forced the current architecture.
- [Pi upstream provenance](reference/pi-upstream.md) is generated from `bun.lock`
  by `bun run provenance`.
- [RPC mode command support](reference/pi-rpc-support.md) maps every contract
  command against Pi's RPC protocol, and records why the direct SDK is the only
  integration path.

The repository [README](../README.md) remains the shortest route to installation,
verification, and this index.
