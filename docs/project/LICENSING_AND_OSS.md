---
description: "How Rebel and its components are licensed (fair source / BSL for the core, MIT and FSL for the components), what contributors grant, and where the public-mirror mechanics are documented. Orientation + precise per-component reference; signposts to the LICENSE files and the user-facing explanation."
last_updated: "2026-06-23"
---

# Licensing & Open Source

Orientation to how Rebel is licensed. Rebel is **fair source**: the source is published openly, most use is permitted, and each version converts to a true open-source licence on a fixed timer. This doc is the precise per-component reference for developers; the plain-English version for users lives in the help-for-humans doc signposted below.

> The authoritative wording is always the per-component `LICENSE` file. This doc orients and signposts — it does not restate licence terms verbatim, and must not drift from them. If a `LICENSE` file changes, update the table here.

## See also

- `LICENSE` (repo root) — the authoritative Business Source License 1.1 text for the Rebel core
- [CONTRIBUTING.md](../../CONTRIBUTING.md) + `DCO.txt` — the inbound contribution terms (DCO sign-off + the BSL licensing grant)
- [`rebel-system/help-for-humans/licensing-and-fair-source.md`](../../rebel-system/help-for-humans/licensing-and-fair-source.md) — the **user-facing** plain-English explanation (the substance lives there)
- [OSS_MIRROR_RUNBOOK](./OSS_MIRROR_RUNBOOK.md) — how the public mirror is produced and kept in sync
- [OSS_LEAK_GATE](./OSS_LEAK_GATE.md) — what is scrubbed from public surfaces, and the `check:oss-surface` gate
- [OSS_BACKPORT_RUNBOOK](./OSS_BACKPORT_RUNBOOK.md) — how an approved community PR lands on the internal source of truth
- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) — release territory hub (mirror publish is part of it)

## Per-component licences

Rebel is a superproject plus several submodules, each licensed separately. Exact terms are in each component's own `LICENSE` file.

| Component | Path | Licence | Holder | What it permits / restricts | Becomes fully open |
|---|---|---|---|---|---|
| **Rebel core** (app + local runtime) | repo root | **BSL 1.1** | Mindstone Learning Limited | Copy / modify / create derivative works / redistribute, plus **non-production** use, freely. **Production** use free only for internal business **up to 100 Installed Seats**; above that — or any non-internal / commercial-service use — needs a commercial licence. | **MIT**, on each version's Change Date = **2nd anniversary** of that version's first public release (4-year backstop) |
| **Skills & help library** | `rebel-system/` | **MIT** | Mindstone Learning Limited (2026) | Fully open today — including the bundled skills, help-for-humans docs, and agent instructions | Already open |
| **Connector catalogue** | `mcp-servers/` | **FSL-1.1-MIT** | Mindstone Learning Limited (2026) | Use / copy / modify / redistribute for any **Permitted Purpose** — i.e. anything except a **Competing Use** (offering it as a commercial hosted service that directly competes with Mindstone) | **MIT**, on the Change Date **2030-04-08** (4 years from first availability) |
| **Connector router** | `super-mcp/` | **MIT** | Team Member (2025) | Fully open today (third-party-authored, vendored as a submodule) | Already open |
| **Coding-agent instructions** | `coding-agent-instructions/` | *No `LICENSE` — internal* | Mindstone Learning Limited | Internal AI-agent instructions shared across repos; not published as OSS | n/a |

Key nuances worth holding onto:

- **Per-version, rolling conversion (core).** The BSL Change Date is computed *per version*, so at any moment the latest release is still restricted while older releases have already gone MIT. There is no single flip-everything date. See `LICENSE` for the exact clause.
- **Two different fair-source licences — don't conflate them.** The core's **BSL** caps *all* production use (≤100 internal seats), so it already precludes reselling or hosting Rebel as a service — the seat cap is the *broader, stricter* guardrail. `mcp-servers`' **FSL-1.1-MIT** is the opposite shape: it permits broad commercial/production use and forbids only a **Competing Use** (a directly-competing hosted service). So the named "Competing Use" carve-out is FSL-specific; the core's restriction is wider, not narrower. Timers differ too: BSL converts per-version (2 years each); FSL has a single fixed 2030 Change Date.
- **`rebel-system` ships in every build, including the managed app, and is fully MIT** — this is the "developed in the open" part users can read and fork.

## Contributions

Rebel uses the **Developer Certificate of Origin 1.1** (`DCO.txt`), not a CLA — contributors sign off with `git commit -s`. The operative inbound permission is **inbound = outbound, plus a licensing grant**: a contribution is submitted under the licence of the file it touches (BSL for the core, MIT for permissive components), and for BSL-covered contributions the contributor additionally grants Mindstone a perpetual, sublicensable licence so the commercial + fair-source model stays coherent. Contributors retain copyright. Full terms, the no-secrets/no-PII rules, and the squashed-mirror PR/credit flow are in [CONTRIBUTING.md](../../CONTRIBUTING.md) — that is the single source of truth; don't restate it here.

`mcp-servers/` is its own repo with its own `CONTRIBUTING.md`: connector contributions are licensed under **FSL-1.1-MIT** (inbound = outbound for that component), not BSL.

## Keeping private material out of public surfaces

Because parts of this tree reach a public mirror, treat anything public-reachable (source, docs, commit messages) as public. The carve-outs, placeholders policy, and enforcement gate are covered in [OSS_LEAK_GATE](./OSS_LEAK_GATE.md) and [`mirror/AGENTS.md`](../../mirror/AGENTS.md); the root `AGENTS.md` § *Open Source & Fair Source* is the quick-reference rule.
