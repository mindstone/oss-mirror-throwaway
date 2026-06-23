---
description: "Rules and signposts for packages/shared/ (@rebel/shared) — the lowest-level, fully platform-agnostic utility + UI-primitive hub consumed by every surface (desktop, cloud, mobile, web-companion, browser extension)."
last_updated: "2026-06-07"
---

# packages/shared — Platform-Agnostic Utilities (`@rebel/shared`)

`@rebel/shared` is the **lowest common layer**: pure utilities, shared types, security primitives, the diff engine, and framework-light UI primitives (`chatUI`, `chatController`) reused across *every* surface — desktop (renderer/main/core), cloud, mobile, web-companion, and the browser extension. If a piece of logic needs to behave identically everywhere, it belongs here.

It sits below `@rebel/cloud-client`: cloud-client talks to the cloud and holds client state; `@rebel/shared` holds the surface-independent logic both it and the surfaces call.

## Hard rules

- **Zero platform dependencies.** No `electron`, `electron-store`, `react-native`, `window`, `localStorage`, or `AsyncStorage`. This package must compile and run in Node, a browser, and React Native unchanged. `react` (>=18) and `unified` are **peerDependencies** — UI primitives may use React, but nothing else platform-specific.
- **Untrusted-content fencing is load-bearing security — do not weaken it.** `untrustedFencing.ts` exposes `generateFenceNonce` (128-bit), `truncateUtf8Safe`, `sanitizeMetadata`, and the fail-loud `FenceCollisionError`. Both the desktop publish flow and the mobile "Resolve with Rebel" flow splice possibly-adversarial user/file content into prompts through these. Changing them is a prompt-injection surface — treat as security-critical.
- **`unifiedApprovalMapper.ts` is the single source of truth** for deriving approval lists from staged files + memory + tool approvals + staged tool calls. Desktop and mobile both drive their approval UIs from it — don't fork per-surface mapping logic.
- **Keep the shared engines shared.** The diff engine (`diff.ts`, Myers LCS) and approval content/utils are consumed by multiple surfaces; fix or extend them here rather than reimplementing downstream.
- **Pure over stateful.** Prefer pure functions and explicit inputs. State and platform wiring live in the consuming surfaces (or `@rebel/cloud-client`), not here.

## What lives here

- `untrustedFencing.ts`, [`safety/`](src/safety/), `browserToolSafety.ts` — security primitives
- `unifiedApprovalMapper.ts`, `approvalUtils.ts`, `approvalContent.ts`, [`actionPreview/`](src/actionPreview/) — approval derivation + presentation
- `diff.ts` — shared diff engine
- `chatUI/`, `chatController/` — framework-light shared chat UI primitives
- `conversationalPublishMessage.ts`, `conversationalResolutionPrompt.ts`, `intentClient/` — prompt builders
- [`types/`](src/types/) — cross-surface DTOs and shared type definitions

## Typechecking

Two ratchet projects gate this package (`scripts/check-typescript-errors.ts`, run under **root tsc** via `npm run validate:ts-ratchet` → `validate:fast` → local push gate + CI):

- **`packages-shared`** (`tsconfig.json`) — production code; test globs excluded.
- **`packages-shared-test`** (`tsconfig.test.json`) — re-includes the test globs; both baseline 0.

`tsconfig.test.json` scopes a `@shared/*` path (desktop `src/shared`) to **tests only**, so cross-layer regression tests can typecheck (e.g. verifying a desktop wrapper still respects a `@rebel/shared` primitive's invariant). **Production code must never import `@shared/*` or any desktop/platform module** — the strict `packages-shared` project (no `@shared` path) enforces the zero-platform-dependency rule by failing the gate. TS replaces (does not merge) `paths` across `extends`, so the test config re-declares the inherited paths plus `@shared/*`. See `docs/plans/260623_packages-shared-typecheck-gate/PLAN.md`.

## See also

- Root [`AGENTS.md`](../../AGENTS.md) — repo-wide rules; "Core-first, desktop-first architecture"
- [`cloud-client/AGENTS.md`](../../cloud-client/AGENTS.md) — the client layer that builds on these utilities
- [`src/core/AGENTS.md`](../../src/core/AGENTS.md) — platform-agnostic *business* logic (the desktop/cloud/mobile runtime counterpart)
- [`docs/project/APPROVAL_SYSTEM.md`](../../docs/project/APPROVAL_SYSTEM.md) — the approval/diff system many of these modules implement
- [`docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md`](../../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md) — walk this whenever a change here affects more than one surface
- [`docs/project/SAFETY_SYSTEM_OVERVIEW.md`](../../docs/project/SAFETY_SYSTEM_OVERVIEW.md) — the safety architecture the fencing/safety primitives feed into

> **Note:** the browser extension (`../browser-extension/`) is an app surface (a consumer), not a boundary — it has no nested `AGENTS.md`; follow the root file plus this one.
