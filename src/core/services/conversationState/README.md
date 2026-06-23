# Conversation State Core Destination

This directory is the Stage 0.A landing zone for the canonical conversation
state reducer.
Future work will derive visible conversation state from shared event streams
here, then route desktop, cloud-client, and mobile wrappers through the same
implementation.

The reducer should be pure, fixture-driven, and independent of React.
Surface wrappers may adapt inputs and memoize outputs, but should not mutate the
canonical result.

Keep parity tests close to the reducer migration.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
