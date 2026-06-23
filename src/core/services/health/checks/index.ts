/**
 * Core Health Check Functions
 *
 * Re-exports platform-agnostic check functions invocable from both desktop
 * (Electron) and cloud (Node.js) surfaces.
 */

// Degraded-state surfacing (Stage 0 stubs)
export { checkApiCooldownHealth } from './apiCooldown';
export { checkToolAdvisoryHealth } from './toolAdvisory';
