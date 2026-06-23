# Inbox Core Destination

This directory is the Stage 3.C landing zone for inbox rules and store logic
that can run across desktop, cloud, and mobile.
Future work should move shared inbox projections, state transitions, and policy
helpers here.

Surface-specific notification delivery should remain behind adapters.
Core code should not depend on Electron windows or main-process IPC.

Keep persistence and synchronization contracts explicit.
Prefer pure reducers and small helpers where possible.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
