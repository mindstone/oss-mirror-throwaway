/**
 * Shared tool-auth type vocabulary for onboarding.
 *
 * Extracted into its own dependency-free module so both `toolAuthMachine.ts`
 * (which owns the transition logic) and `useOnboardingFlow.ts` (which owns the
 * effects/actions) can import these types WITHOUT forming an import cycle:
 * `useOnboardingFlow → toolAuthMachine → toolAuthTypes` is acyclic, whereas
 * having the machine import the types from the hook (which imports the machine
 * back) was a circular dependency. Consumers continue to import these types
 * from `./useOnboardingFlow`, which re-exports them — see invariant #2 in
 * `docs/plans/260608_onboarding-flow-state-machine/PLAN.md`.
 */

/**
 * Tool authentication status for each tool in the toolAuth step.
 */
export type ToolAuthStatus =
  | 'pending'
  | 'generating'
  | 'ready_to_connect'
  | 'awaiting_auth'
  | 'verifying'
  | 'connected'
  | 'error';

/**
 * Tool types available for authentication in onboarding.
 * One email tool is required (Gmail or Outlook Mail), Calendar and Chat are optional.
 */
export type ToolType =
  | 'gmail'
  | 'google-calendar'
  | 'slack'
  | 'outlook-mail'
  | 'outlook-calendar'
  | 'teams';

/**
 * Tool authentication state for a single tool.
 */
export interface ToolAuthState {
  tool: ToolType;
  displayName: string;
  description: string;
  serverName: string; // e.g., "gmail", "google calendar", "slack"
  status: ToolAuthStatus;
  authUrl: string | null;
  error: string | null;
  awaitingSince?: number | null;
  required: boolean;
}
