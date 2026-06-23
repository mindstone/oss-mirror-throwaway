# Settings Store Core Destination

This directory is the Stage 2.A landing zone for the canonical settings store.
The current `src/core/services/settingsStore.ts` file is an unrelated small shim.
Future work will move settings defaults, normalization, migrations, and store
access into this directory.

`src/main/settingsStore.ts` should become a thin desktop compatibility export
after the move.
Cloud and CLI consumers should depend on this core service instead of `@main/*`.

Keep this directory free of Electron imports.
Use `@core/storeFactory` and lazy store access patterns.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
