/**
 * Capability registration for the Rebel browser extension.
 *
 * Stage 6b ships the full set the extension advertises during `register`.
 * Each entry must match exactly one `CapabilityKey` in the bridge's shared
 * protocol (`src/core/appBridge/shared/protocol.ts`); the `validate:fast`
 * consistency check fails CI if they drift.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */

export interface CapabilityDescriptor {
  id: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Returns the capability list the extension advertises during `register`.
 *
 * Descriptions are terse and user-facing — the agent can read them verbatim
 * in error messages without any further shaping.
 */
export function getCapabilities(): readonly CapabilityDescriptor[] {
  return [
    { id: 'read_page', description: 'Read visible text of the current tab' },
    {
      id: 'get_selection',
      description: 'Get the text currently selected on the current tab',
    },
    {
      id: 'get_current_tab_url',
      description: 'Get current tab URL and title',
    },
    {
      id: 'fill_form',
      description:
        'Fill specified form fields; sensitive fields denied by default',
    },
    {
      id: 'click',
      description: 'Click an element by selector + label match',
    },
    {
      id: 'scroll',
      description: 'Scroll the tab to a Y position',
    },
    {
      id: 'status',
      description: 'Return extension connection status',
    },
  ];
}
