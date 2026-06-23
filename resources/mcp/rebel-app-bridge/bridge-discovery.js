/**
 * RebelAppBridge — stdio MCP server discovery helpers.
 *
 * Reads the state file written by the bundled App Bridge host
 * (`src/core/appBridge/server/bridge.ts`) and verifies that the owning
 * process is still alive before returning `{ port, routerToken }` to the
 * caller. Every check is "silent failure is a bug"-compliant: a missing or
 * stale state file returns a structured result with `reason` populated so
 * the MCP tool handler can render a precise user-visible error.
 *
 * Intentionally plain `require(...)` CommonJS so the rebel-app-bridge MCP
 * server keeps matching the rebel-diagnostics shape (the rebel-office
 * server moved out to @mindstone-engineering/mcp-server-office in 0.4.36+).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 4)
 */
const fs = require('node:fs');

/**
 * Try to read + parse the state file. Returns either the full state object
 * or `null` if the file is missing / malformed / shape-mismatched. The
 * caller then decides whether to report "bridge not running" or a more
 * specific error.
 *
 * @param {string|null|undefined} stateFilePath
 * @returns {null | { port: number, pid: number, protocolVersion: string, startedAt: string, routerToken: string }}
 */
function loadBridgeState(stateFilePath) {
  if (typeof stateFilePath !== 'string' || stateFilePath.length === 0) {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(stateFilePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.port !== 'number' ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.protocolVersion !== 'string' ||
    typeof parsed.startedAt !== 'string' ||
    typeof parsed.routerToken !== 'string' ||
    parsed.routerToken.length === 0
  ) {
    return null;
  }
  return parsed;
}

/**
 * POSIX-style liveness probe. `process.kill(pid, 0)` doesn't actually send
 * a signal — it only checks whether the current process could signal the
 * target. ESRCH means "no such process"; EPERM means "alive, but we don't
 * have permission" (still alive for our purposes).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * One-shot discovery: read state file, validate shape, confirm owning PID
 * is alive. Returns a discriminated result so the caller can produce
 * a precise user-facing error without duplicating the string constants.
 *
 * @param {string|null|undefined} stateFilePath
 * @returns {{ ok: true, state: object }
 *         | { ok: false, reason: 'no-state-path' | 'missing-state' | 'stale-state' }}
 */
function discoverBridge(stateFilePath) {
  if (typeof stateFilePath !== 'string' || stateFilePath.length === 0) {
    return { ok: false, reason: 'no-state-path' };
  }

  const state = loadBridgeState(stateFilePath);
  if (!state) {
    return { ok: false, reason: 'missing-state' };
  }
  if (!isPidAlive(state.pid)) {
    return { ok: false, reason: 'stale-state' };
  }
  return { ok: true, state };
}

module.exports = {
  loadBridgeState,
  isPidAlive,
  discoverBridge,
};
