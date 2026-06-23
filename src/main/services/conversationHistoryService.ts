/**
 * Re-export shim — canonical implementation moved to src/core/services/conversationHistoryService.ts
 * @see docs/plans/260330_strengthen_de_electronification.md
 *
 * Also re-exports `buildContinuationContext` (the canonical context-assembly
 * wrapper that owns the prior-turns header + history injection) so
 * desktop-side callers can keep a single import path matching the shim
 * pattern used elsewhere in `src/main/`. Stage 2 of
 * `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
 */
export * from '@core/services/conversationHistoryService';
export * from '@core/services/buildContinuationContext';
