---
description: "Intent and non-negotiable constraints for Chief Designer visual verification"
last_updated: "2026-04-30"
---

# UI Chief Designer Visual Verification

## Why this exists

The visual-verification loop is Intent-critical. Chief Designer and Design System Reviewer must judge real rendered UI evidence, not text-only descriptions that can miss density drift, hierarchy regressions, or "consistent but wrong" migrations.

This doc captures the architecture choices future agents must preserve.

## Workflow owns capture, skills consume evidence

Visual evidence capture is workflow-owned, not skill-owned.

- **Chain entry (Phase 2):** capture BEFORE evidence before implementation starts.
- **Chain exit (Phase 8):** produce missing AFTER evidence, then validate branch counts and on-disk file existence.
- **Skills consume:** Chief Designer and DSR consume evidence from their packets and focus on judgment.

This separation keeps timing unambiguous and makes silent drift harder: workflow gates enforce capture, skills enforce analysis quality.

## In-app pure-judgment exception

There is one intentional exception: in-app pure judgment with no orchestrator.

- Chief Designer captures chain-entry baseline evidence in light and dark where theme cycling is available.
- No implementation follows, so no AFTER is expected.
- Phase 8 completion gate does not run because no implementation occurred.

## Coding vs in-app transport asymmetry is deliberate

Do not "simplify" these into one return shape.

- **Coding context:** `take_screenshot` returns path-only evidence; the host agent can read the image file by path.
- **In-app context:** `rebel_get_app_screenshot` returns path plus `imageContent`, and `imageContent` must flow into model-facing `tool_result`.

This is load-bearing because Rebel's in-app `Read` tool is UTF-8 file text only and cannot decode PNG bytes safely for model reasoning. In-app visual reasoning therefore depends on `imageContent` propagation.

Code signposts:
- `src/core/rebelCore/builtinTools.ts`
- `src/core/rebelCore/agentLoop.ts`
- `src/core/rebelCore/agentMessageAdapter.ts`

## Source of truth for live changes

For coding-context reviews of live user changes, visual evidence must come from
the user's actual CDP-accessible dev app found through `electron_list_apps` /
`electron_list_targets`. An isolated MCP-managed app is valid
for generic UI smoke tests, but it may run with Demo Mode or different state and
must not be cited as evidence for the user's current work unless they explicitly
ask for that generic harness.

Do not use OS window, region, or desktop screenshots as substitute evidence for
live-change review. They can produce a valid PNG of the wrong surface. If the
actual dev app is not CDP-accessible, visual capture is blocked until it is
relaunched with a debug port, for example:

```bash
REMOTE_DEBUGGING_PORT=9222 npm run dev
```

Then find that running app in MCP:

```text
electron_list_apps {}
electron_list_targets { "processId": "<real-dev-app-process-id>" }
```

The target must be visible in the active MCP tool results. If the current real
app is not visible to `electron_list_apps` / `electron_list_targets`,
live-change visual capture is blocked until the app is relaunched with CDP
enabled and the MCP server can see it. Do not fall back to `spawn_dev_server`,
`electron_start_app`, OS screenshots, or region capture to paper over a missing
target; those paths can prove the wrong surface.

Design System Reviewer must treat screenshot provenance as part of the review
contract. Before approving visual UI, reviewers should name the evidence source:
BEFORE paths, AFTER paths, whether the capture came from an orchestrated Review
Packet, actual CDP dev app, in-app Rebel capture, or supplied screenshot, and
any rejected evidence. A valid image from Demo Mode, Storybook, a browser, or an
OS region is not valid proof of the user's current dev-app UI unless the review
was explicitly scoped to that source.

In-app Chief Designer visual judgment uses `rebel_navigate_app` when the user
names a built-in Rebel surface and `rebel_get_app_screenshot` for the actual
capture. For Settings subpages, the navigation call should include the
subpage explicitly, for example `{ "destination": "settings", "settings_tab":
"meetings" }` for Settings -> Meetings. That path is separate from the
coding-context MCP path.

For long or visibly scrollable Rebel surfaces, `rebel_get_app_screenshot`
should be called with `{ "capture_mode": "scroll" }`. The tool captures a
bounded set of viewport screenshots from the same app surface and returns all
image blocks to the model, rather than relying on one cropped viewport.

## User-visible capture control

When in-app visual verification navigates the running Rebel window, the user
must see a lightweight control affordance: a subtle app-frame highlight and
status label such as "Chief Designer is opening Actions for review". This is an
orientation and trust pattern, not a permission modal.

The overlay is best-effort and must not block navigation or capture. It is hidden
before `BrowserWindow.capturePage()` so saved visual evidence does not include
the control chrome, then briefly confirms that the screenshot was captured. If
visual verification navigated away from the user's current Rebel surface, the
app restores that prior surface after the capture sequence settles.

## `ScreenshotCaptureService` boundary and cross-surface no-op

`ScreenshotCaptureService` lives in `src/core/` as an optional capability boundary:

- Desktop registers the implementation.
- Cloud and mobile intentionally leave it unset.
- Tool calls on unsupported surfaces return typed graceful errors, not fake success.

This prevents cross-surface crashes and prevents false claims that screenshots were captured when the surface cannot capture.

## Theme behavior and custom-accent downgrade

Both themes are required when the surface supports clean theme cycling. If theme cycling is unavailable (for example due to custom accent constraints), the loop downgrades explicitly:

- capture current theme only
- disclose limitation (`theme-cycling-unavailable`)
- continue with scoped critique instead of pretending full theme coverage

## Prompt-injection threat model for screenshot text

Screenshot text is untrusted input. Attackers can place instruction-like text inside rendered UI (calendar titles, email subjects, imported content) to steer recommendations.

V1 mitigation:
- skill rubric explicitly treats screenshot text as untrusted user data
- deterministic eval fixture checks injection resistance (`screenshot-prompt-injection-resistance`)
- recommendation must be grounded in visual structure, not injected instructions

Accepted risk: this is a first-layer mitigation. If capture scope expands to less-trusted surfaces, additional defenses are required.

## What future agents must not do

- Do not move capture responsibility back into SKILL self-policing.
- Do not remove or weaken the Phase 2 chain-entry BEFORE hook.
- Do not reduce Phase 8 to validator-only; producer+validator is required.
- Do not teach DSR to invent a missing BEFORE baseline.
- Do not collapse coding and in-app evidence transport into one format.
- Do not treat visual evidence as valid without checking provenance against the
  review type.

## References

- `docs/plans/260429_chief_designer_visual_verification_loop.md`
- `docs/project/PROJECT_OVERRIDES.md` (UI Mode and Phase 8 gate)
- `docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md` (tool-result image-content path)
- `rebel-system/skills/ux/_shared/visual-verification-loop.md`
