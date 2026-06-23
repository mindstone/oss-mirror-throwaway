---
description: "End-to-end lifecycle of the Mindstone-managed subscription provider: how the managed OpenRouter key + tier defaults arrive via /api/config, auto-activate, lock the model picker, and fail-closed at the proxy — plus the opt-out invariant that lets users leave Mindstone."
last_updated: "2026-05-30"
---

# Managed Provider Lifecycle

When a user has a Mindstone subscription, Rebel runs as a **managed provider**: the OpenRouter
credit, the API key, and the per-tier model defaults all live server-side and are delivered to the
app over `/api/config`. The user never sees or supplies the key, can only use the tier's allowed
models, and billing is metered upstream. This doc captures the intent and the invariants that keep
that contract correct end-to-end. Code is the source of truth for *how*; this is the *why* and the
*where*.

## The pipeline (where each step lives)

1. **Fetch config.** `fetchAuthConfig()` in `private/mindstone/src/services/authService.ts` GETs `/api/config`.
2. **Parse + store the key.** `extractManagedProviderInfo()` (same file) reads the
   `subscription.managedProvider` block. If an `apiKey` is present it is persisted via
   `saveManagedOpenRouterKey()` in `src/main/services/openRouterTokenStorage.ts` (the
   `encryptedManagedKey` store slot; presence checked by `hasManagedOpenRouterKey()`). The key is
   stored **regardless** of routing/activation state so it is ready the moment routing turns on.
3. **Auto-activate (gated).** Still inside `extractManagedProviderInfo`, when `routingAvailable` is
   true **and** the user has not opted out (see invariant below), it sets `activeProvider: 'mindstone'`
   and seeds the working / thinking / bts model slots from `defaultModels`.
4. **Renderer mirror.** `src/renderer/hooks/useManagedDefaults.ts` exposes `hasManagedKey`,
   `defaultModels`, and `managedAllowedModels` (via `getManagedAllowedModelIds`) so the model picker
   can lock down to the tier's allowed set.
5. **Tier-change notice.** `src/renderer/hooks/useManagedTierModelChangeNotifier.ts` watches
   `defaultModels` across `/config` refreshes (using `diffDefaultModels`) and toasts when a model
   leaves the tier.
6. **Egress enforcement.** `src/main/services/localModelProxyServer.ts` resolves the managed key and
   rejects any model outside the allow-list (see "Fail-closed at the proxy").

Shared types and helpers live in `src/shared/types/managedProvider.ts`: `ManagedProviderInfo`,
`ManagedDefaultModels`, `getManagedAllowedModelIds`, `diffDefaultModels`.

## THE KEY INVARIANT: `managedProviderDeactivated` (opt-out marker)

`/api/config` is fetched repeatedly. Without a persisted record of the user's *intent*, the reconcile
in `extractManagedProviderInfo` would re-activate Mindstone on **every** fetch — silently reverting a
user who deliberately switched to Anthropic / personal OpenRouter / Codex. That was the
"can't leave Mindstone / switch reverts to Mindstone" bug class.

The fix is a persisted opt-out marker, `managedProviderDeactivated` (see
`src/shared/types/settings.ts`):

- **Written** by `buildBaseUpdates()` in `src/shared/utils/providerSwitch.ts` (called from
  `planProviderSwitch()`): the marker is set to `to !== 'mindstone'`, i.e. switching away from
  Mindstone sets it and switching back to Mindstone clears it. The OpenRouter-defaults path in
  `src/shared/utils/openRouterDefaults.ts` also sets it.
- **Read** by the reconcile in `extractManagedProviderInfo`: if `managedProviderDeactivated === true`
  *and* `activeProvider !== 'mindstone'`, it skips **both** auto-activation **and** tier-default
  application (so it never overwrites the user's chosen models). First-time activation (marker unset)
  still works, and switching back to Mindstone clears the marker so the managed defaults reapply.

**Design note — synchronous-write requirement.** The reconcile *mutates persisted settings* on most
`/config` fetches (activating, or re-seeding tier defaults when already active). That write must land
synchronously relative to the next fetch/read, otherwise a stale read could re-trigger the very
revert this invariant prevents. The opt-out branch is intentionally the *leading* branch so an
opted-out user short-circuits before any settings mutation. See the 260521 postmortem for the full
failure mode and the parity-gap root cause (an "apply defaults on entry to mindstone" arm shipped
without the inverse "respect exit" rule).

## Fail-closed at the proxy

The managed credential is **fail-closed** and never falls back to a personal key. In
`src/main/services/localModelProxyServer.ts`:

- `resolveManagedOpenRouterApiKey()` returns the managed key or `null` — and the OpenRouter
  passthrough returns `401` rather than reaching for a personal OpenRouter key.
- In managed mode the proxy enforces an allowed-model list at egress using
  `getManagedAllowedModelIds(...)`; a request for a model outside the list is rejected with `403`
  and code `MANAGED_MODEL_NOT_ALLOWED` **before** any upstream call.

**Subtlety worth knowing:** `getManagedAllowedModelIds` derives the allow-list from the three
populated `defaultModels` slots (working / thinking / bts), *not* from the broader
`managedProvider.allowedModels` catalog. The picker lockdown and the proxy enforcement therefore
share exactly the same source of truth, which is the point — the renderer cannot offer a model the
proxy would reject.

## Why it's shaped this way

- **Key stored before activation** so enabling routing server-side is instantaneous and doesn't race
  a second config fetch.
- **Server owns the model catalog** so tier changes (e.g. a model retired from a tier) propagate on
  the next `/config` fetch without an app release; the notifier toast keeps the user informed.
- **Picker and proxy share one allow-list derivation** so there is no client/server skew the user
  could exploit or trip over.

For the broader audit of subscription consumers (the surfaces that must respect managed mode and the
gaps found across them), see `docs/plans/260513a_subscription_consumer_audit_gaps.md`.

## See also

- [AUTHENTICATION](./AUTHENTICATION.md) — `/api/config` fetch, token lifecycle, and where `fetchAuthConfig` sits in the auth flow.
- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — provider-aware model normalization and the constants the tier defaults resolve against; signpost here rather than hardcoding default model ids.
- `src/shared/utils/providerSwitch.ts` — `planProviderSwitch` / `buildBaseUpdates`; the single place that writes the `managedProviderDeactivated` opt-out marker on any provider switch.
- `private/mindstone/src/services/authService.ts` — `extractManagedProviderInfo`; the reconcile that reads the opt-out marker and is the load-bearing half of the invariant.
- `src/main/services/localModelProxyServer.ts` — `resolveManagedOpenRouterApiKey` and the egress allow-list check; the fail-closed enforcement boundary.
- `docs-private/postmortems/260521_provider_switch_mindstone_to_openrouter_postmortem.md` — the bug class the opt-out invariant fixes, and why the synchronous-write framing matters.
- `docs/plans/260513a_subscription_consumer_audit_gaps.md` — consumer-facing audit of every surface that must honour managed mode.
