---
description: "Cross-surface parity checklist for auth, provider routing, token storage, and desktop-connected services across desktop, cloud, and mobile"
last_updated: "2026-06-08"
---

# Cross-Surface Parity Checklist

When building or modifying features that touch auth, provider routing, token storage, or any desktop-connected service, verify cross-surface behavior before shipping.

## The Checklist

1. **Desktop-only dependency audit**: Does this feature depend on desktop-only APIs? (`safeStorage`, `shell.openExternal`, `BrowserWindow`, `systemPreferences`, keychain access) If the dependency is genuinely desktop-only (e.g. opening a browser for OAuth), keep THAT piece on desktop but move everything else — storage, refresh, HTTP helpers — to `src/core/` so cloud and mobile get the same code path.
2. **Cross-surface data flow**: If desktop produces data the other surfaces need (tokens, keys, caches), how does it flow to them? Prefer the existing dual-write / settings-sync infrastructure in `CLOUD_CHANNEL_POLICIES` and `cloudRouter`. Default answer is **always sync the data**, not "turn the feature off on cloud". Degradation is a last resort, not a first resort.
3. **Boundary interface**: Is there a `src/core/` boundary interface? Or are consumers importing directly from `src/main/`? New cross-surface services should use the set/get provider pattern (see `@core/platform`, `@core/storeFactory`, `@core/codexAuth`). The SAME provider implementation should work on every surface; only the surface-specific bits (e.g. interactive login) live outside core.
4. **Graceful degradation (only when data genuinely can't be synced)**: What happens on cloud/mobile when the feature is truly unavailable? Must degrade gracefully with observable logging and a user-facing status event — never crash, never enter a retry loop, never silently pretend success. Before accepting this path, ask: "Could I just sync the underlying data instead?"
5. **Auth helper awareness**: If the feature changes auth state or provider routing, verify `hasValidAuth()` and `getAuthEnvVars()` in `src/core/utils/authEnvUtils.ts` handle the new state correctly on all surfaces.
6. **Catalog template-token parity**: If connector catalog env templates include `{{...}}` tokens, verify they resolve identically on desktop, cloud, and mobile (via `cloud-client`) before any user-facing config or storage is written. See `docs/plans/260503_bridge_state_path_and_oss_migration_credential_preservation.md`.
7. **Per-surface input shapes and lifecycles**: When centralizing a service for cross-surface use, enumerate each surface's input-shape contract and add an integration test per surface exercising the *worst-case* shape that surface can supply at the call site — not only the logically complete shape. Before designing server-side cleanup or close handlers, enumerate each surface's client connection-lifecycle assumptions.
8. **Environment assumptions in behavior-preserving migrations**: Check environment assumptions across desktop, cloud, and ordinary user workspaces explicitly — import/type parity alone doesn't prove the code behaves the same where it now runs.
9. **Headless-CLI vs GUI axis**: For features that depend on GUI-only bootstrap (auto-updater, voice hotkey, deep-link handling, native dialogs), include the headless-CLI vs GUI axis in the parity review.

## OSS Build And B6 Parity Notes (2026-06-08)

The `260607_oss-b6-launch-polish` run touched three cross-surface-sensitive areas. Preserve these invariants when changing OSS mode, telemetry, or cloud provisioning:

- [ ] **OSS build signal:** desktop/core read `PlatformConfig.isOss`, set in `src/main/bootstrap.ts` from the pure `@private/mindstone/mode` module. Cloud sets `isOss` to `false`. Renderer code must use the `__REBEL_IS_OSS__` build define from `rendererIsOss()`, not a second source of truth.
- [ ] **Telemetry gate:** OSS DSN/write-key injection must stay gated before client construction on all four telemetry surfaces: main Sentry, main RudderStack, renderer Sentry, and renderer RudderStack. The `telemetry-config:sync` preload bridge feeds the renderer; `settings.telemetry` is top-level `LOCAL_ONLY`, so user Sentry/RudderStack credentials must not sync to cloud.
- [ ] **Managed-cloud gate:** managed-cloud IPC gating is desktop-only. `cloud:*` channels are not in `CLOUD_CHANNEL_POLICIES`, and BYOK Fly/DO/Hetzner share the same handler family as managed provisioning, so gate only managed selectors/branches. Do not disable shared BYOK handlers to make OSS managed-cloud removal look cleaner.

## Telemetry / analytics parity (2026-06-12)

Telemetry does **not** follow the usual "sync the desktop data to cloud/mobile" pattern — each surface emits its own. The parity rule here is about **partitioning**, not propagation.

- **Mobile telemetry is client-side, by design.** Mobile's business logic runs on the user's cloud instance, so a server-side tracker would not capture mobile UI behaviour. Mobile therefore emits analytics from the RN app directly (RudderStack RN SDK in `mobile/src/analytics/`) and captures errors client-side (`@sentry/react-native`). See [MOBILE_OVERVIEW § Analytics & error monitoring](MOBILE_OVERVIEW.md#analytics--error-monitoring).
- **One-emitter-per-event partition (no double-count).** A mobile-driven session also executes on cloud, which emits the core/agent/tool/cost events. Mobile emits **only client/UI-origin events that core does NOT emit** (verified disjoint). When adding a mobile analytics event, check whether desktop emits it from the **renderer** (mirror it) or from **core** (do NOT — the cloud instance already emits it for the mobile session). Rationale + per-event verification: [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md § Mobile](ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md#mobile-react-native--expo).
- **The mechanized parity gate has NO telemetry enumeration.** `scripts/check-cross-surface-parity-gap.ts` checks setting-flag-vs-backing-capability and `LOCAL_ONLY` drift; it does not know about Sentry/RudderStack surfaces. The telemetry-surface count (now five — main, renderer, cloud, mobile-Sentry, mobile-RudderStack) is a **human-checklist** concern, tracked here and in the OSS B6 telemetry-gate note above, not by the gate. Don't expect CI to catch a telemetry-surface omission.

## Correct Architecture Pattern

```
                ┌── desktop (Electron)
                │   • OAuth login (browser + loopback)    ← surface-specific
                │   • DEFAULT_CODEX_AUTH_PROVIDER         ← shared core
                │   • Token storage (safeStorage on)      ← @core/storeFactory
                │
 @core/services ┼── cloud (Node.js server)
                │   • DEFAULT_CODEX_AUTH_PROVIDER         ← shared core
                │   • Token storage (base64, no keyring)  ← @core/storeFactory
                │   • POST /api/codex/tokens             ← sync endpoint
                │
                └── mobile (React Native)
                    • Uses user's cloud instance          ← transparently works
                      once cloud has tokens
```

Desktop pushes tokens to cloud via a dedicated dual-write IPC channel (`codex:sync-tokens`) after login/refresh/logout. Cloud stores them using the same core storage layer. Mobile gets ChatGPT Pro for free via its cloud connection.

## Common Failure Pattern (what NOT to do)

```
Desktop: User connects [provider] → settings.activeProvider = '[provider]'
         → auth tokens stored in desktop-only secure storage

Cloud:   Settings sync carries activeProvider = '[provider]'
         → auth tokens DON'T sync (different store, no sync logic)
         → code checks activeProvider and assumes auth is available
         → request fails → retry loop → user sees error

Wrong fix: Register a NULL provider on cloud so the code "gracefully fails".
           This disables the feature on every surface except desktop — which
           defeats the point of running a personal cloud server.

Right fix: Move the auth logic to core, wire the REAL provider on cloud too,
           and sync the underlying tokens via a dedicated channel.
```

## Mechanized Gate (2026-05)

The traps below are CI-enforced by `scripts/check-cross-surface-parity-gap.ts`,
which runs in `validate:fast` and blocks merge on violation. The full trap
catalogue lives at [CROSS_SURFACE_PARITY_TRAP_CATALOGUE](CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md).

| Trap class | Mechanized? | Notes |
|---|---|---|
| Setting flag synced without backing capability | **Yes (blocking)** | Rules A+B; escape hatch: `// CROSS_SURFACE_PARITY_EXEMPT: <reason>` — rationale must be ≥30 chars and contain no weak markers (TODO/FIXME/XXX/WIP/temp/later); see [Stage 9 enforcement](../plans/260516_cross_surface_parity_gap_gate.md). Weak rationales surface in `--list-exemptions` audit but do NOT suppress violations |
| LOCAL_ONLY_SETTINGS_KEYS / AppSettings drift | **Yes (compile-time)** | Type-locked via `satisfies readonly (keyof AppSettings)[]` (Stage 1.5); TypeScript itself rejects typos |
| Parallel transport guard replication | No — human-judgment | Listed for reviewer reference; see 260426 postmortem |
| Inline surface branch instead of boundary | Partially — see 260514 cross-surface-imports ratchet | |
| Auth helper drift (`hasValidAuth` / `getAuthEnvVars`) | No — human-judgment | The gate cannot infer auth semantics |

**Emergency bypass:** `SKIP_CROSS_SURFACE_PARITY_GAP=1` skips the gate with a
loud stderr warning. Use only for emergency rollback.

**What the gate cannot do (and why human checklist still matters):** the gate
verifies structural parity, not semantic completeness. It cannot detect, for
example, that a new setting's behavior on cloud silently degrades to a no-op
without observable logging. The checklist items above the table remain the
non-mechanizable layer.

## Prior Incidents

- **2026-05-02**: External conversation engine — registered adapters per surface. Stage 4 lands the service skeleton on cloud with zero adapters; Stage 6 will register the Slack webhook adapter (cloud-only). The browser-tab and office-document adapters are desktop-only by design (R21).
- **2026-04-22 (part 1)**: Codex OAuth death loop on cloud/mobile. `settings.activeProvider === 'codex'` synced but OAuth tokens didn't. First attempt shipped a null-provider-on-cloud "degradation" that accidentally disabled ChatGPT Pro on cloud entirely. See `docs/plans/260422_codex_cloud_parity_and_fallback.md`.
- **2026-04-22 (part 2 — current)**: Proper fix. Moved token storage + refresh to `src/core/services/`, wired `DEFAULT_CODEX_AUTH_PROVIDER` on both desktop and cloud, added `codex:sync-tokens` dual-write channel (REST endpoint `/api/codex/tokens`), and token push hooks in `cloudRouter.ts` on reconnect / `syncNow` / login / refresh. ChatGPT Pro now works across all three surfaces.

## In-place API key update affordance (2026-05-04)

Configuration is desktop-only. Cloud + mobile inherit the configured connector state read-only via the dual-write sync. There is no mobile UX gap for v1; a future mobile connector settings plan will own the mobile edit surface.

| Question | Desktop (Electron) | Cloud (Node HTTP) | Mobile (React Native) |
|---|---|---|---|
| Does this surface render an "Update key" / "Update details" affordance on connected API-key connector cards? | YES | N/A | N/A |
| Does this surface render an auth-failure `Notice` on connected API-key connector cards? | YES | N/A | N/A |
| Does this surface use the merge-semantics `mode: 'update'` IPC? | YES | NO — desktop-only, NOT in `CLOUD_CHANNEL_POLICIES` | N/A |
| Does this surface preserve `lastConnectedAt` on update + only advance on health-check ok? | YES | N/A | N/A |
| Does this surface fire the post-save `settings:mcp-validate-server` health check? | YES | N/A | N/A |
| Does this surface respect the `INTERNAL_ENV_KEYS` boundary in the merge? | YES | YES (transitively) | YES (transitively) |
| Does this surface preserve catalog `bundledConfig` invariants per the boundary registry? | YES | YES | YES |

## See Also

- [ARCHITECTURE_OVERVIEW](ARCHITECTURE_OVERVIEW.md) — system architecture and cross-surface design
- [CODING_PRINCIPLES](CODING_PRINCIPLES.md) — core-first architecture principle
- `src/core/codexAuth.ts` — CodexAuthProvider boundary interface (exemplar)
- `src/core/services/codexAuthCore.ts` — cross-surface Codex auth implementation
- `src/core/services/codexTokenStorage.ts` — cross-surface token storage
- `src/core/services/defaultCodexAuthProvider.ts` — the single provider used on desktop + cloud
- `src/core/platform.ts` — PlatformConfig boundary interface
