/**
 * Normalizes skill folder paths by appending `/SKILL.md` when the path
 * points to a skill directory (contains `/skills/` segment, no file extension).
 *
 * Extracted from FlowPanelsProvider's `openDocumentPreview` to share
 * across the unified document editor and any callers that open documents.
 */
export function normalizeDocumentPath(path: string): string {
  const hasFileExtension = /\.[a-zA-Z0-9]{2,6}$/.test(path);
  const isSkillFolderPath = /[/\\]skills[/\\]/.test(path) && !hasFileExtension;
  if (isSkillFolderPath && !path.endsWith('SKILL.md')) {
    return `${path.replace(/[/\\]$/, '')}/SKILL.md`;
  }
  return path;
}
