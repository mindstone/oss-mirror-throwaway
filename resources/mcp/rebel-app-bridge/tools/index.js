/**
 * RebelAppBridge — tool registry (Stage 4 — R27 / D27 consistency check).
 *
 * Three derived views:
 *
 *   1. `TOOLS_BY_APP_ID`:
 *      { 'browser-extension': [BROWSER_TOOLS…] }
 *
 *      Used by the MCP server to enumerate which tools to register with
 *      the MCP client. Pre-grouped by `appId` so Stage 5 can add
 *      e.g. `'office-word'` without touching the server's registration
 *      loop.
 *
 *   2. `ROUTE_BY_TOOL_NAME`:
 *      { 'rebel_browser_read_page': { appId: 'browser-extension',
 *                                     capability: 'read_page' }, … }
 *
 *      Used by the relay handler to translate a tool name → the
 *      `POST /apps/:appId/:capabilityId` route to hit, without scanning
 *      the whole catalogue per request.
 *
 *   3. `CAPABILITY_BY_TOOL_NAME`:
 *      { 'rebel_browser_read_page': 'read_page', … }
 *
 *      Convenience inverse of TOOLS_BY_APP_ID — consumed by
 *      `scripts/check-app-bridge-tool-registry.ts` to validate that the
 *      two registries (TOOLS_BY_APP_ID + CAPABILITY_BY_TOOL_NAME) cover
 *      exactly the same tool names.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */
const { BROWSER_TOOLS } = require('./browser');
const { HOST_TOOLS } = require('./host');

/** Catalogue of tools keyed by the App Bridge `appId` they dispatch to. */
const TOOLS_BY_APP_ID = Object.freeze({
  'browser-extension': BROWSER_TOOLS,
  '__host': HOST_TOOLS,
});

/** Pre-computed `toolName -> { appId, capability }` lookup table. */
const ROUTE_BY_TOOL_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOLS_BY_APP_ID).flatMap(([appId, tools]) =>
      tools.map((tool) => [
        tool.name,
        Object.freeze({ appId, capability: tool.capability }),
      ]),
    ),
  ),
);

/** Inverse of TOOLS_BY_APP_ID for the consistency check. */
const CAPABILITY_BY_TOOL_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(ROUTE_BY_TOOL_NAME).map(([name, route]) => [name, route.capability]),
  ),
);

module.exports = {
  TOOLS_BY_APP_ID,
  ROUTE_BY_TOOL_NAME,
  CAPABILITY_BY_TOOL_NAME,
};
