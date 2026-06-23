# boundary-hints test fixtures

Stable snapshots used by `scripts/__tests__/boundary-hints.test.ts`.

**Do NOT edit these to reflect current postmortem wording** — these fixtures
are regression anchors. If a future change to the real postmortem / planning
doc breaks a test, update the relevant fixture here explicitly, not the live
document.

## Files

### Small synthetic registries (loaded by Vitest via `loadRegistry(path, repoRoot)`)
- `registry-exclude.yaml` — 1-entry registry exercising `exclude_paths` per-file filter
- `registry-no-exclude.yaml` — backward-compat shape (no `exclude_paths` field)
- `registry-invalid.yaml` — malformed entry used by fail-closed / `BoundaryHintsError` tests

### Production-registry fixtures (used by end-to-end CLI regression tests)
- `workspace-env-positive.md` — stable excerpt mirroring the 260420 bug class; proves
  `mcp-workspace-env-propagation` still fires after the Stage 3 tightening.
- `workspace-env-negative.md` — stable excerpt mirroring the 260412 MCP-apps fix-plan shape;
  proves `mcp-workspace-env-propagation` does NOT over-fire, and that
  `mcp-apps-package-identity-routing` DOES still fire (identifier match).

### Note on synthetic file-lists

Per-file filter tests (positive include, negative only-excluded, mixed include+exclude)
are exercised directly in `scripts/__tests__/boundary-hints.test.ts` via `matchPaths()`
calls against hand-built file arrays — no on-disk fixture file is needed because the
matcher operates on path strings, not filesystem state.
