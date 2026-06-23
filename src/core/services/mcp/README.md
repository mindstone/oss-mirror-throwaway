# MCP Core Destination

This directory is the Stage 2.B and Stage 2.C landing zone for MCP logic that
does not require Electron.
Future work will move MCP configuration resolution, catalog interpretation,
and runtime-management policy here.

Desktop subprocess spawning should stay behind a boundary adapter.
Cloud and mobile should share the same pure config resolver instead of importing
desktop service files.

Keep process, filesystem, and notification access behind core interfaces.
Do not place desktop-only lifecycle code in this directory.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
