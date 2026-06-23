---
description: "How to edit, build, ship, and release a change to the super-mcp submodule without orphaning it — the lightweight commit-on-main procedure, where code should live, the safety gates, and the automatic npm publish on stable."
last_updated: "2026-06-18"
---

# Editing & Shipping super-mcp Changes

> **One-paragraph version.** `super-mcp` is **Mindstone's own OSS repo** (`mindstone/Super-MCP`), included as a submodule at `super-mcp/` and normally checked out on `main`. Changing it is **not** a heavyweight foreign PR: edit on `main`, commit inside the submodule, and `git-safe-sync` ships the submodule commit to `origin/main` before it advances the superproject pin. The one rule that matters — **never leave the change on a feature branch the superproject pins** — is enforced by construction (`validate:submodule-pin-ancestry`), so the worst case is a loud push failure, not silent data loss. **Releasing a new npm version is automatic:** bump `super-mcp/package.json`, regenerate the pin, ship — the next *stable* release publishes `super-mcp-router` to npm by itself (see [Step 3](#step-3--versioning--npm-publish-automatic-you-dont-run-npm-publish)). You never run `npm publish` by hand.

This doc exists because agents have over-read "upstream it" as a blocker and abandoned small, correct fixes. It is not hard or confusing — it just has one footgun (the pin-orphan class) that is now guarded, and one decision (where should the code live).

---

## Step 0 — Decide where the change belongs

Before editing, answer one question:

| Is the change… | Where it goes |
|---|---|
| **Generic** — a bug or capability any super-mcp consumer would want (routing, materialization, truncation, auth delegation, a meta-tool fix) | **super-mcp `main`** — edit the submodule directly (the lightweight procedure below). It's our repo; we maintain it. Keep it generally usable; if a change would *reduce* external usability, flag it to the team. |
| **Rebel-specific** — behavior only Rebel needs, that wouldn't make sense in the public package | **A Rebel-owned layer**, NOT super-mcp: a host built-in tool (`src/core/rebelCore/builtinTools.ts`) or the `RebelPlugins` bundled MCP server (`resources/mcp/rebel-plugins/server.cjs`). Code put on a super-mcp feature branch is silently dropped on the next pin re-align — this is exactly how `bulk_export` regressed (dead 57 days). See the postmortem linked below. |

The reason the second row matters: the superproject re-aligns the super-mcp pointer to `origin/main` regularly. Anything not on `main` is not durable.

---

## Step 1 — Edit & commit on `main` (the lightweight procedure)

The submodule normally sits on `main` (`git config -f .gitmodules submodule.super-mcp.branch` → `main`). Confirm, edit, commit:

```bash
cd super-mcp
git symbolic-ref --short HEAD          # expect: main  (if detached, `git checkout main` first)
# ... make your edit ...
npm run build                          # or, from superproject root: npm run validate:super-mcp-build
git add -p && git commit -m "fix(...): ..."   # normal conventional commit
cd ..
```

**Type-checking:** super-mcp pins its **own** TypeScript (`^5.5.4`, `ignoreDeprecations: "5.0"`). Running the parent superproject's `tsc` against it gives a spurious `TS5107`. Always type-check with the submodule's own toolchain — `npm run validate:super-mcp-build` (from root) or `cd super-mcp && npx tsc --noEmit`.

## Step 2 — Ship it

From the superproject root, run the normal sync:

```bash
npx tsx scripts/git-safe-sync.ts        # or the /git-safe-sync-and-push command
```

`git-safe-sync` **pushes the submodule commit to `origin/main` before it advances the superproject pin** (see its [Step 2 "What the script does"](../../.factory/commands/git-safe-sync-and-push.md)). So a legitimate in-flight commit is already reachable by the time the pin-ancestry gate runs → it Just Works. No separate PR, no waiting.

> If you run a standalone `npm run validate:fast` **before** pushing the submodule commit, the pin-ancestry gate will (correctly) complain the pin isn't on `origin/main` yet. Push the submodule commit to `origin/main` first, or just let `git-safe-sync` do it in order.

## Step 3 — Versioning & npm publish (automatic; you don't run `npm publish`)

> **One-paragraph version.** Bump `super-mcp/package.json` `version` when you change runtime behaviour, regenerate the pin, and ship. **The npm publish happens by itself on the next *stable* release** — there is no separate `npm publish` step to remember. This is by construction (it's why REBEL-61X — `No matching version found for super-mcp-router@2.5.0` — can't recur).

**1. The version has ONE source of truth: `super-mcp/package.json` `version`.**
The runtime pin is **generated** from it — do **not** hand-edit `src/core/services/superMcpVersion.generated.ts`. After bumping `super-mcp/package.json`, run `npm run generate:super-mcp-version` (or just let `validate:super-mcp-version-codegen`, part of `validate:fast`/pre-push, fail loudly on drift and tell you to regenerate). The Rebel CLI build (`scripts/rebel-cli/build.mjs`) asserts the same — all three historical version sites now trace to this one file.

**2. npm publish is automatic on STABLE only.**
On a stable release (promotion to `main`, e.g. via `scripts/release-to-production.ts`), CI:
- runs a **token-free preflight** (`validate:super-mcp-publish-preflight`) inside `validate-and-test` — this **gates** the release: if `super-mcp-router@<version>` is unpublishable, the stable release fails *before* any build;
- then a **parallel, non-blocking** `publish-super-mcp-npm` job publishes `super-mcp-router@<version>` to npm **if it isn't already there** (idempotent — re-running a shipped version is a no-op `SKIP`).

So the whole workflow is: edit on `main` → bump `super-mcp/package.json` → `npm run generate:super-mcp-version` → `git-safe-sync` to `dev` → when it's promoted to stable, **it publishes itself.** No manual `npm publish`, no separate ceremony.

**Router-side repair changes need a version bump.** super-mcp **2.6.0** shipped schema-driven `use_tool` argument auto-repair (canonical key-normalize + schema-aware type coercion in `super-mcp/src/utils/normalizeInput.ts`, wired from `useTool.ts`). Any change to that repair logic, its guardrails, or the validator interaction is **runtime behaviour** — bump `super-mcp/package.json` even if the OSS API surface looks unchanged. Rebel's app-side schema gate (`src/main/services/schemaGateHook.ts`, `REBEL_ENFORCE_SCHEMA_GATE`) is Rebel-owned and does not require a super-mcp version bump on its own.

**3. Beta does NOT publish.** Beta (`dev`) releases run the **bundled** `super-mcp/dist` baked into the app/cloud artifact — they never need npm. The publish job and preflight are skipped on beta.

**4. Why you can ignore npm at runtime.** Packaged desktop and cloud always run the **bundled** `super-mcp/dist/cli.js`. A packaged build whose bundle is missing now **throws into Safe Mode** rather than silently falling back to `npx super-mcp-router@<pin>` (the REBEL-61X crash). The `npx` fallback is **dev-only**. So the npm publish exists for (a) external OSS consumers and (b) keeping that dev-only fallback valid — never for whether a shipped Rebel works.

**Auth (one-time, owner-only):** the publish job authenticates via **npm Trusted Publishing (OIDC)** — no token secret. The npm package owner configures it on npmjs.com (package → Settings → Trusted Publisher: org `mindstone`, repo `rebel-app`, workflow `release.yml`, environment blank). Setup details, verification limits (an out-of-workflow probe **cannot** confirm a scoped publisher — opaque 404 either way), and exactness gotchas: [`docs-private/investigations/260610_supermcp_npm_trusted_publishing_setup.md`](../../docs-private/investigations/260610_supermcp_npm_trusted_publishing_setup.md). If auth is misconfigured, the stable publish job fails *visibly* (a red, non-blocking job) and the app still ships from its bundle — fail-safe, not fail-stuck.

> **Known: the publish job currently fails on *every* stable release (non-gating red).** The publish
> uses `npm publish --provenance` (`scripts/publish-super-mcp.ts:316`), and npm **only supports
> provenance for public source repos** — rebel-app is private, so the registry rejects the
> sigstore bundle with `E422 … Only public source repositories are supported when publishing with
> provenance`. It does **not** block the release (the job isn't in `publish-to-gcs.needs`), but it
> means a red `publish-super-mcp-npm` job is *expected* today and is **not** necessarily an auth
> problem. Decision + options (drop `--provenance`, or publish super-mcp from its own public repo):
> [`docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md`](../../docs-private/ops/OSS_COMMERCIAL_CONFIG_TODO.md)
> § Other OSS-ops debt.

**Recovery notes:** version already published → idempotent `SKIP` (expected when super-mcp didn't change); missing/expired token → red `publish-super-mcp-npm` job (rotate the secret, re-run); npm propagation delay → the publish step's `--verify` retries `npm view` before failing.

---

## The safety net (why you can't silently orphan a change)

Three complementary gates, all in `validate:fast` / pre-push:

| Gate | npm script | Catches |
|---|---|---|
| **Pin ancestry** | `validate:submodule-pin-ancestry` | A pin **not reachable from `origin/main`** — i.e. work left on a feature branch (*ahead*) or a *diverged* lineage. **Hard-fails the push** wherever it can verify the submodule (always on the developer push path). This is the by-construction kill for the `bulk_export` orphan class. |
| **gitsha parity** | `validate:super-mcp-gitsha-parity` | Recorded gitlink ≠ checked-out HEAD (pin/worktree drift). |
| **Runtime conformance** | `src/core/rebelCore/__tests__/superMcpContract.conformance.test.ts` | A required meta-tool *removed from* `main` — a different failure mode (capability disappears even though the pin is valid). |

Enforcement is **verifiable = strict, unverifiable = skip-with-warning**: where the submodule clone + `origin/main` ref are present (developer push path, CI), a bad pin hard-fails; where they aren't, the gate skips loudly rather than false-passing. See the [Enforcement model](PROJECT_OVERRIDES2.md) paragraph in the Submodule Pin Policy for the exact semantics.

If `git-safe-sync` exits **19** ("Submodule pin not on tracked branch"), that's this gate firing. Handling is in the [exit-19 stanza](../../.factory/commands/git-safe-sync-and-push.md) of the sync command: **AHEAD** → push the commit to `origin/main` and re-run; **DIVERGED** → a real "where should this live" decision (Step 0 above).

---

## Coordinating with other workstreams — collide carefully, don't abandon

If the lines you're touching are owned by active super-mcp work (e.g. a Sentry fingerprint another agent is mid-fix on), that's a **coordination** concern, not a reason to drop the fix. The right move is the normal one for any shared hot file: land your small change on `main` promptly (short-lived commits rarely conflict), or give the owning workstream a heads-up if the edit is substantial. "Editing super-mcp is complicated" is **not** a valid reason to skip a correct fix — the procedure above is the whole story.

---

## See also

**Policy & history**
- [`PROJECT_OVERRIDES2.md` § Submodule Pin Policy](PROJECT_OVERRIDES2.md) — the canonical invariant, where Rebel-specific functionality lives, the full enforcement model.
- [`docs-private/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md`](../../docs-private/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md) — the regression this whole guard rail exists to prevent. (Internal-only; not in the public mirror.)

**Git mechanics**
- [`.factory/commands/git-safe-sync-and-push.md`](../../.factory/commands/git-safe-sync-and-push.md) — the push primitive; submodule auto-push ordering, exit-19/exit-17 handling.
- [`GIT_SUBMODULES.md`](GIT_SUBMODULES.md) — general submodule workflow in this repo.
- [`coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md`](../../coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md) — detached-HEAD / orphan recovery mechanics.

**super-mcp itself**
- [`SUPERMCP_OVERVIEW.md`](SUPERMCP_OVERVIEW.md) — runtime / HTTP-mode architecture, config, troubleshooting.
- [`SUPER_MCP_LIFECYCLE.md`](SUPER_MCP_LIFECYCLE.md) — subprocess lifecycle, owner identity, cleanup.
- [`SUPER_MCP_PASSTHROUGH_CONTRACT.md`](SUPER_MCP_PASSTHROUGH_CONTRACT.md) and [`MCP_APP_SUPER_MCP_SEAM.md`](MCP_APP_SUPER_MCP_SEAM.md) — passthrough/seam contracts.
- [`MCP_IMPROVEMENT_WORKFLOW.md`](MCP_IMPROVEMENT_WORKFLOW.md) — start-here for MCP development decisions.
- [`docs/plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md`](../plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md) — deferred OSS-process improvement ideas for super-mcp/mcp-servers (release docs, CI hardening, branch-protection decision) + the mirror simplification roadmap.

**Key npm scripts:** `build:super-mcp`, `validate:super-mcp-build`, `validate:submodule-pin-ancestry`, `validate:super-mcp-gitsha-parity`.
