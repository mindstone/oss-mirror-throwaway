/**
 * Tool Safety Service — re-export of the canonical implementation in @core.
 *
 * The platform-agnostic implementation lives at
 * `@core/services/safety/toolSafetyService`. Cloud and desktop both consume it
 * directly. This file is kept so the many existing imports under
 * `@main/services/toolSafetyService` keep working without a repo-wide sweep.
 *
 * New code should import from `@core/services/safety/toolSafetyService`.
 *
 * @see docs/project/SAFETY_SYSTEM_OVERVIEW.md — safety architecture map
 * @see docs/project/TOOL_SAFETY.md — tool-risk policy and UX contract
 * @see docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md — PreToolUse hook context
 */

export * from '@core/services/safety/toolSafetyService';
