---
description: "Reusable prompting patterns for AI coding agents — post-implementation hardening, bug diagnosis, plan review"
last_updated: "2026-04-17"
---

# Prompting Strategies

Reusable workflow patterns for orchestrating AI coding agents. Each strategy is ~30-40 lines. Add new ones at the bottom.

---

## 1. Multi-Angle Post-Implementation Hardening

**When:** After a feature works on the happy path, before shipping. Best for I/O-heavy features, complex state, or non-technical user surfaces.

**Flow:** Implement -> Investigate in parallel (5 angles) -> Synthesize -> Fix in phases -> Validate

**The 5 investigation angles** (pick 3-5 based on feature type):

| Angle | Prompt focus | Best droid |
|-------|-------------|------------|
| Security | Integrity, MITM, permissions, supply chain | `debugger-opus4.7-thinking` |
| Edge cases / races | Concurrent calls, state sync, timing, crash recovery | `debugger-opus4.7-thinking` |
| Connectivity UX | Slow/offline/metered network, user-facing errors, retry UX | `researcher-opus4.7` |
| Operational | Crash recovery, cleanup, logging, Sentry, graceful degradation | `debugger-gemini3.1-pro` |
| Performance | IPC frequency, memory, blocking calls, re-renders | `debugger-glm5` |

**Each investigator gets:** Same context (planning doc + file list), different lens. Require: exact file/line, concrete scenario, user impact, proposed fix. No speculation.

**Synthesize:** Bugs found by 2+ investigators get high confidence. Deduplicate, rank by severity, group into phases:
1. Safety (corruption, crashes) -> 2. Reliability (recovery, state sync) -> 3. UX (errors, progress) -> 4. Hardening (defense-in-depth)

**Each phase:** Implement -> review -> commit. Keeps diffs focused and reviewable.

**Angle selection by feature type:**
- Network I/O: Security, Connectivity UX, Operational, Performance
- UI: Edge cases, Performance, UX/accessibility
- Auth/permissions: Security, Edge cases, Operational
- Background tasks: Edge cases, Operational, Performance

**Example:** FOX-2966 local STT model auto-download. 5 investigators found 16 bugs (3 critical). Fixed in 4 phases. See `docs/plans/260331_local_stt_download_hardening.md`.

---

## 2. Consensus-Gated Bug Diagnosis

**When:** Non-trivial bug where the root cause is unclear. See [CHIEF_BUGFIXER](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md).

Launch 3+ parallel debugger subagents investigating the same bug. Require 2/3 consensus on root cause before implementing a fix. Prevents fixing symptoms instead of causes.

---

## 3. Septuple Plan Review with Devil's Advocates

**When:** Any non-trivial feature or refactor. See [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md).

7 reviewers in parallel, 2 as Devil's Advocates prompted to challenge assumptions and push for simplicity. Catches issues that unanimous agreement misses.

---

*Add new strategies below. Keep each to ~30-40 lines: when to use, the workflow, key prompts, and a real example.*
