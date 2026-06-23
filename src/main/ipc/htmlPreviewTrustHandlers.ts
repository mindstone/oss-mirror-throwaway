/**
 * HTML Preview Trust IPC Handlers
 *
 * Wires the per-file trust gate for the rebel-html:// document viewer.
 * Resolves a workspace-relative path to a canonical absolute path the same
 * way the rebel-html protocol handler does, reads file content, and
 * delegates to HtmlPreviewTrustService.
 *
 * IMPORTANT: keep the path-resolution logic in sync with the rebel-html
 * protocol handler in src/main/index.ts. If that handler's resolution rules
 * change (space-name resolution, traversal guard), mirror it here so the
 * trust store keys (canonical absolute paths) stay aligned.
 *
 * @see src/core/services/htmlPreviewTrustService.ts
 * @see docs/plans/260525_html_preview_trust_tiers.md
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { IpcMainInvokeEvent } from 'electron';
import { registerHandler } from './utils/registerHandler';
import { htmlPreviewTrustChannels } from '@shared/ipc/channels/htmlPreviewTrust';
import { getHtmlPreviewTrustService } from '@core/services/htmlPreviewTrustService';
import { getSettings } from '../settingsStore';
import { resolveViaSpaceName } from '@core/services/space/spaceService';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'htmlPreviewTrustHandlers' });

interface ResolvedFile {
  absolutePath: string;
  content: Buffer;
}

/**
 * Resolve a workspace-relative path the same way the rebel-html protocol
 * handler does, then read its content. Returns null if anything fails —
 * callers should treat that as "not trusted / cannot trust".
 */
async function resolveAndRead(workspacePath: string): Promise<ResolvedFile | null> {
  const settings = getSettings();
  if (!settings.coreDirectory) {
    log.warn('No workspace configured');
    return null;
  }
  const workspaceDir = settings.coreDirectory;

  let filePath = path.join(workspaceDir, workspacePath);
  try {
    await fs.stat(filePath);
  } catch {
    const spaceResolved = await resolveViaSpaceName(workspacePath, workspaceDir, { useReadOnlyScan: true });
    if (spaceResolved) filePath = spaceResolved;
  }

  let realFilePath: string;
  try {
    realFilePath = await fs.realpath(filePath);
  } catch (err) {
    log.warn({ err, filePath }, 'File not found for trust resolution');
    return null;
  }

  // Traversal guard — mirror the protocol handler's check exactly.
  const realWorkspaceDir = await fs.realpath(workspaceDir).catch(() => workspaceDir);
  const relative = path.relative(realWorkspaceDir, realFilePath);
  const isSpaceResolved = filePath !== path.join(workspaceDir, workspacePath);
  if (!isSpaceResolved && (relative.startsWith('..') || path.isAbsolute(relative))) {
    log.warn({ workspacePath, realFilePath, realWorkspaceDir }, 'Trust resolution: path traversal blocked');
    return null;
  }

  try {
    const content = await fs.readFile(realFilePath);
    return { absolutePath: realFilePath, content };
  } catch (err) {
    log.warn({ err, realFilePath }, 'Failed to read file for trust resolution');
    return null;
  }
}

export function registerHtmlPreviewTrustHandlers(): void {
  registerHandler('htmlPreviewTrust:isTrusted', async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const { workspacePath } = htmlPreviewTrustChannels['htmlPreviewTrust:isTrusted'].request.parse(payload);
    const resolved = await resolveAndRead(workspacePath);
    if (!resolved) return { trusted: false };
    const trusted = getHtmlPreviewTrustService().isTrustedForContent(resolved.absolutePath, resolved.content);
    return { trusted };
  });

  registerHandler('htmlPreviewTrust:trust', async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const { workspacePath } = htmlPreviewTrustChannels['htmlPreviewTrust:trust'].request.parse(payload);
    const resolved = await resolveAndRead(workspacePath);
    if (!resolved) {
      return { success: false, error: 'File could not be resolved or read' };
    }
    getHtmlPreviewTrustService().trust(resolved.absolutePath, resolved.content);
    return { success: true };
  });

  registerHandler('htmlPreviewTrust:reset', async (_event: IpcMainInvokeEvent, payload: unknown) => {
    const { workspacePath } = htmlPreviewTrustChannels['htmlPreviewTrust:reset'].request.parse(payload);
    const resolved = await resolveAndRead(workspacePath);
    // For reset, resolve the absolute path even if the file is gone — but if we can't resolve at all, no-op.
    if (!resolved) {
      log.info({ workspacePath }, 'Reset called for unresolvable path; no-op');
      return { success: true };
    }
    getHtmlPreviewTrustService().reset(resolved.absolutePath);
    return { success: true };
  });
}
