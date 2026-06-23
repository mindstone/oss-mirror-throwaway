# Workspace Core Destination

This directory is the Stage 1.B landing zone for workspace file-system logic.
Future work will move file-tree and workspace read/write behavior here behind a
cross-surface boundary.

The desktop implementation may still provide OS integration.
The core contract should own traversal safety, path normalization, and shared
workspace semantics.

Cloud and mobile should call the boundary rather than duplicate filesystem
policy.
Keep destructive operations fail-closed when directory walks are incomplete.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
