# Turn Pipeline Core Destination

This directory is the Stage 2.E.1 and Stage 2.F landing zone for turn-pipeline
logic that can run outside Electron.
Future work will move pure admission, orchestration, recovery, and turn-state
helpers here as they are separated from desktop-only adapters.

Desktop process code should keep only the genuinely Electron-specific wiring.
Cloud and mobile surfaces should consume the same core pipeline primitives.

Keep boundary contracts explicit and typed.
Avoid importing from `electron`, `@main/*`, or renderer modules.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
