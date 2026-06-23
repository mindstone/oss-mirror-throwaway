/**
 * Renderer-specific constants
 */

export const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.mdx', '.mdown', '.mkd', '.txt', '.text'];

// MAX_DRAFT_ONLY_SESSIONS is defined canonically in @core/constants (alongside
// MAX_PERSISTED_SESSIONS and the other session caps); import it from there.

export const TURN_ID_FALLBACK = 'latest';

export const DEFAULT_VOICE_STATUS = 'Tap for quick command • Hold for voice conversation';

export const MAX_BREADCRUMBS = 200;

export const LOG_SOURCE = 'renderer';

export type AgentSessionSidebarStatus = 'idle' | 'thinking' | 'ready';

export const AGENT_SESSION_STATUS_LABEL: Record<AgentSessionSidebarStatus, string> = {
  idle: 'Waiting for input',
  thinking: 'Processing',
  ready: 'Ready'
};

/**
 * Check if a file path is an editable workspace file based on extension
 */
export const isEditableWorkspaceFile = (filePath: string): boolean => {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return EDITABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
};
