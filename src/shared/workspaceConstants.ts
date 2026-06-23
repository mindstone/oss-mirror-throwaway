/**
 * Workspace file-walk constants shared between desktop and cloud-service.
 *
 * Single source of truth — both `cloudWorkspaceSync.ts` (desktop) and
 * `library.ts` (cloud-service) import from here.
 */

/** Directories always excluded from workspace walks (case-sensitive). */
export const ALWAYS_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.cache',
  'tool-outputs',  // .rebel/tool-outputs/ — ephemeral materialized MCP outputs, excluded from sync
  'conflicts-cleanup',  // .rebel/conflicts-cleanup/ — quarantined sync-conflict copies, excluded from sync
  '.DS_Store',
]);

/** File/directory names always excluded from workspace walks. */
export const ALWAYS_SKIP_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/** Temporary cloud-pull files must never enter workspace manifests. */
export const WORKSPACE_SYNC_TEMP_MARKER = '.rebel-cloud-pull.tmp';
