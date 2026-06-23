# Automation Core Destination

This directory is the Stage 3.A landing zone for the automation rule engine.
The existing `automations/` plural directory remains untouched; this singular
directory is available for the new boundary named in the plan.

Future work should move rule evaluation, scheduling decisions, and shared
automation policy here.
Surface-specific timers, notifications, and execution adapters should stay
outside the core rule engine.

Keep the engine deterministic and testable with fixtures.
Do not import Electron or renderer modules.
Planning source: `docs/plans/260516_cross_surface_centralization.md`.
