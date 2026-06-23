---
description: "OSS build: defaults and self-config paths for everything the enterprise build used to provision via /api/config. Source for the public README (Track D2)."
last_updated: "2026-06-08"
---

# OSS Self-Config Defaults

In the enterprise build, after sign-in Rebel fetched `GET /api/config` and provisioned a pile of settings server-side. The **open-source build has no Mindstone backend** — it runs on the OSS auth stub (`src/core/services/ossNullAuthProvider.ts`), which serves a **static config** that provisions nothing. Everything is the user's to configure.

This doc is the single reference for **what the default is** and **where you set it yourself** for each thing `/api/config` used to provide. It's the source material for the public README's configuration section (Track D2).

> **Background:** Track B4 of the [OSS release plan](../plans/260520_oss_release_implementation_plan.md). Field-by-field audit with code anchors: [`B4_API_CONFIG_AUDIT.md`](../plans/260607_oss-b4-api-config-self-config/B4_API_CONFIG_AUDIT.md). The OSS auth carve-out (B3.2) moved the `/api/config` consumer into `private/mindstone/`; the OSS stub at `src/main/oss/private-mindstone-stub/` replaces it.

## TL;DR

The OSS build launches and is fully functional with **zero** configuration — it just starts empty rather than pre-provisioned. Bring your own LLM key, and you're working. Everything below has a self-serve surface in **Settings** (or onboarding); nothing requires a server.

## Defaults and where to set each thing

| What the server used to provision | OSS default (no backend) | Where you set it yourself |
|---|---|---|
| **LLM API keys** (Anthropic, OpenAI, Gemini, OpenRouter, Together, Cerebras, custom) | None — bring your own | **Settings → Agents → AI provider** (and "Other providers" / "Custom providers"). OpenRouter via OAuth. |
| **Managed/routed model key** | None — the managed-routing key is enterprise-only and simply absent | Use any BYOK provider above. There is no "Mindstone" managed provider in OSS. |
| **Voice transcription** | **Local speech-to-text** (Moonshine / Parakeet) — works with no key | **Settings → Voice.** Add an OpenAI (Whisper) or ElevenLabs key there if you prefer a cloud voice provider. |
| **Model profiles / which models you can pick** | **All models selectable**; no company-managed profiles or allow-list | **Settings → Agents → Available models** (create/edit local profiles, assign roles via the profile wizard). |
| **Recommended connectors** | **None out-of-box** — the "recommended" list is empty | **Settings → Tools.** Browse the full connector catalog and add any connector yourself. The catalog is complete; nothing is gated. |
| **Admin-disabled tools** | **Nothing disabled** — every tool in your connectors is available | No per-tool blocklist in OSS (it was an admin/governance feature). Use the global MCP toggle in **Settings → Tools**, or remove a connector, if you want to switch tools off. |
| **Company / organisation name** | Whatever you set in onboarding; otherwise unset | **Onboarding**, or per space afterwards: **Settings → Spaces** → click a space's organisation chip (or the gear) → edit the **Organisation** field. Org name is **per-space** (`organisation_name` in the space's README), not a global account setting; leave the field blank to clear it. |
| **Shared-drive provider + folders** | **Local spaces only**; no shared drive connected | **Onboarding** connects a shared drive (e.g. Google Drive) and selects folders. Local spaces need no configuration. |
| **Managed cloud / subscription / license tier / org analytics identity** | Not applicable — no managed cloud, no billing, license tier is fixed to `teams` (all personal-tier features on), no telemetry unless you opt in | Self-hosted cloud is **BYOK Fly** (see cloud docs). Telemetry is opt-in with your own credentials (**Settings → Privacy**). |

## Notes

- **Nothing breaks when a field is empty.** Verified against the OSS stub: an empty recommended-connectors list renders a normal catalog; an absent managed allow-list means "all models allowed" (not "none"); the admin tool-blocklist field isn't consumed by the UI at all. See the audit for the per-field trace.
- **Verifying the OSS build:** `npm run validate:oss-smoke` (after `build:legacy` with the private tree detached) asserts the stub bundle ships, the OSS auth contract holds (`licenseTier: 'teams'`, `isOssBuild: true`, zero network calls), and no private auth/relay code leaks. See [`OSS_BUILD_SMOKE_RUNBOOK.md`](./OSS_BUILD_SMOKE_RUNBOOK.md).
- **Org name is per-space, by design.** A single global "company name" field is deprecated (`AppSettings.companyName`); the canonical model is per-space `organisation_name` (see [`SPACES.md`](./SPACES.md)). The Settings → Spaces editor and the space wizard both write that field; the agent tool-surface deliberately cannot.
