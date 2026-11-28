# Project architecture and house migration

Target spec: [project-spec.md](project-spec.md). Baselines: Turnkey `22b995340f013795af05f5d218d3f2766ac54263`, Dayst `92972e4e8a65ddc3901320a4d7b0cb4d25832fb9`.

## Phase gates

1. Baseline and inventory: preserve full Git ancestry and refs, authored sources and releases; establish current validation and model fingerprints. Independent review must distinguish source equality, scene equality, browser behavior, and live database coverage.
2. Versioned project foundation: immutable project revisions, branches, CAS/idempotency, three-way merge plans and resolutions, reverts, durable events, import contracts. Test with independent synthetic projects; no project data in Turnkey.
3. Interfaces and integration: shared HTTP/MCP services and discoverable schemas; project adapter and website branch/history/merge controls. Ensure legacy writes cannot create a second authority. Preserve pinned builder behavior and optional project hooks.
4. Import and parity: import full available Git history and legacy database export with provenance; reconcile incomplete historical associations explicitly. Compare source, scene, and behavioral output against baseline. Do not represent a repository-only import as a completed production migration.
5. Cutover: verified database/assets backup, full dry run, final export under write freeze, publication and rollback. Deployment must not precede evidence of parity.

Each phase uses implementation and independent review, followed by fixes and an alignment decision. Work occurs on branches. Phase completion and unresolved gates are recorded here as evidence becomes available.

## Status

- Phases 1–3 implemented with independent review, synthetic tests, and packed-release verification.
- Phase 4 implemented and rehearsed on a local database copy. The original house sources, 95 resolved scene cases, and 12 browser render/control comparisons match. History import preserves recorded ancestry and missing associations explicitly. Production-only layout history is not available to this rehearsal.
- Phase 5 remains gated on a consistent production database and stored-asset export, hosted configuration, final dry run and rollback verification. No production writes or deployment performed.
- Dayst records detailed evidence and remaining product acceptance gaps in `docs/migration-verification.md`. This migration foundation is not a claim that the entire long-term board/presence/semantic-model-tool specification is shipped.
