# Meeting Core Destination

This directory is the Stage 3.B landing zone for cross-surface meeting logic.
The existing `meetings/` plural directory remains untouched; this singular
directory is free and matches the pre-flight naming request.

Future work should move shared meeting detection, preparation, and projection
helpers here when they are separated from desktop-only integrations.

Calendar, notification, and OS-specific adapters should remain outside core.
Keep data transformations pure where practical.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
